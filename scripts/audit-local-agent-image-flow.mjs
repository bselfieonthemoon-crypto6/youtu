// SUPERSEDED — do not run this to validate the current runtime.
//
// It still asserts the legacy PROPOSAL → CONFIRM flow (a structured proposal with a
// durable confirmationId, then a "确认生成" turn). That flow was deliberately removed
// when the Mastra runtime took over direct image submission: `mastra-toolkit.ts`
// filters `get_image_proposal` / `confirm_image_generation` out entirely. So this
// script spends a REAL provider call on its first turn and then fails on
// "canvas: structured proposal" — it cannot pass, and running it costs money to
// learn that.
//
// Use the sanctioned four-step acceptance instead, documented in
// docs/type-guards-real-image-acceptance-20260916.md:
//   1. apps/server: node --env-file=../../artifacts/local-replica-20260907/app.env \
//        --import tsx scripts/preflight-real-image-acceptance.mjs        (read-only)
//   2. apps/server: … scripts/prepare-real-image-acceptance.mjs --prepare (creates a
//        dedicated QA project/session + fixture; submits no run)
//   3. apps/web:    … scripts/run-paid-dialogue-browser.mjs --submit \
//        --fixture=<fixture.json> --prompt="<fixture.prompt>"            (PAID, one image)
//   4. apps/server: … scripts/audit-real-image-acceptance.mjs --fixture=<fixture.json>
//        (read-only postflight: one job, canvas element, chat card, receipts, no
//         duplicate credit deduction)
// Kept only as a record of the legacy proposal-flow acceptance.
//
// Real local Agent + worker acceptance. Only creates dedicated QA projects.
// Run with --env-file=artifacts/local-replica-20260907/app.env.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const { createClient } = require("@supabase/supabase-js");
const { Client } = require("pg");
const { WebSocket } = require("ws");
const dbURL = new URL(process.env.SUPABASE_DB_URL);
if (
  dbURL.hostname !== "127.0.0.1" ||
  dbURL.pathname !== "/loomic_replica_light_20260907" ||
  process.env.SUPABASE_URL !== "http://127.0.0.1:54421"
)
  throw Error("Local replica only");
const db = new Client({ connectionString: dbURL.toString() });
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  options,
);
const auth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  options,
);
const report = { startedAt: new Date().toISOString(), checks: [], turns: [] };
if (process.argv.includes("--resume")) {
  Object.assign(
    report,
    JSON.parse(
      await readFile(
        new URL("../artifacts/agent-flow-audit-20260908.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  delete report.error;
}
let ws, token;
const check = (value, name) => {
  if (!value) throw Error(name);
  report.checks.push(name);
  console.log("PASS", name);
};
const api = async (path, body) => {
  const response = await fetch("http://127.0.0.1:3002" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw Error(path + ": " + JSON.stringify(value));
  return value;
};
async function connect() {
  ws?.close();
  ws = new WebSocket(
    "ws://127.0.0.1:3002/api/ws?token=" + encodeURIComponent(token),
  );
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}
async function turn(sessionId, prompt, extra = {}) {
  await api("/api/sessions/" + sessionId + "/messages", {
    role: "user",
    content: prompt,
    contentBlocks: [{ type: "text", text: prompt }, ...(extra.attachments ?? []).map(a => ({ type: "image", ...a, source: "canvas-ref" }))],
  });
  return new Promise((resolve, reject) => {
    const requestId = randomUUID(),
      events = [];
    let runId;
    const timer = setTimeout(() => done(Error("Agent turn timeout")), 300000);
    const done = (error) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      report.turns.push({
        sessionId,
        prompt,
        runId,
        error: error?.message,
        tools: events
          .filter((e) => e.type === "tool.completed")
          .map((e) => ({ name: e.toolName, output: e.output })),
      });
      error ? reject(error) : resolve(events);
    };
    const onMessage = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "rpc.request") {
        ws.send(
          JSON.stringify({
            type: "rpc.response",
            id: m.id,
            error:
              "Headless acceptance: use stored canvas/design data, no screenshot available.",
          }),
        );
        return;
      }
      if (m.type === "error") {
        done(Error(m.message));
        return;
      }
      if (m.type === "command.ack" && m.action === "agent.run") {
        if (m.requestId !== requestId) return;
        runId = m.payload.runId;
        console.log("ACK", runId);
      }
      if (m.type !== "event" || (runId && m.event.runId !== runId)) return;
      const e = m.event;
      events.push(e);
      if (e.type === "tool.completed")
        console.log(
          "TOOL",
          e.toolName,
          e.output?.status ?? "",
          e.output?.error ?? "",
        );
      if (e.type === "run.completed") done();
      if (e.type === "run.failed" || e.type === "run.canceled")
        done(Error(JSON.stringify(e.error ?? e.type)));
    };
    ws.on("message", onMessage);
    ws.send(
      JSON.stringify({
        type: "command",
        action: "agent.run",
        accessToken: token,
        requestId,
        payload: {
          sessionId,
          conversationId: report.canvasId,
          canvasId: report.canvasId,
          prompt,
          ...extra,
        },
      }),
    );
  });
}
async function generate(kind, prompt, extra = {}) {
  if (report[kind]?.jobs?.[0]?.id) {
    const latest = (await db.query('select id,status,result,error_code,payload,target_kind,attempt_count from background_jobs where id=$1', [report[kind].jobs[0].id])).rows[0];
    if (latest?.status === 'succeeded') {
      report[kind].jobs[0] = latest;
      return latest;
    }
    throw Error(kind + ': prior task is not complete; inspect before creating another paid task');
  }
  const session = (
    await api("/api/canvases/" + report.canvasId + "/sessions", {
      title: "Agent QA " + kind,
    })
  ).session;
  let events = await turn(session.id, prompt, extra);
  let proposal = events.find(
    (e) =>
      e.type === "tool.completed" &&
      e.output?.status === "awaiting_confirmation",
  )?.output;
  if (!proposal) {
    events = await turn(
      session.id,
      "按以上需求准备单张图片生成方案并调用生成工具给出确认卡片，不要只用文字询问确认。",
      extra,
    );
    proposal = events.find(
      (e) =>
        e.type === "tool.completed" &&
        e.output?.status === "awaiting_confirmation",
    )?.output;
  }
  check(proposal, kind + ": structured proposal");
  const confirmationId = proposal.confirmation.confirmationId;
  check(typeof confirmationId === "string", kind + ": durable confirmation ID");
  const details = proposal.confirmation.details;
  if (kind.startsWith("design"))
    check(
      details.target?.design_id === report.designId,
      kind + ": correct design target",
    );
  check(
    (
      await db.query("select id from background_jobs where session_id=$1", [
        session.id,
      ])
    ).rowCount === 0,
    kind + ": no job before approval",
  );
  await turn(session.id, "确认生成", {
    ...extra,
    imageConfirmation: { confirmationId, decision: "confirm" },
  });
  let jobs;
  for (let n = 0; n < 240; n++) {
    jobs = (
      await db.query(
        "select id,status,result,error_code,payload,target_kind from background_jobs where session_id=$1",
        [session.id],
      )
    ).rows;
    if (
      jobs.length &&
      jobs.every((j) => ["succeeded", "failed", "canceled"].includes(j.status))
    )
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  report[kind] = { sessionId: session.id, confirmationId, jobs };
  check(jobs.length === 1, kind + ": exactly one job");
  check(
    jobs[0].status === "succeeded",
    kind +
      ": image completed (" +
      jobs[0].status +
      ", " +
      jobs[0].error_code +
      ")",
  );
  await connect();
  await turn(session.id, "确认生成", {
    ...extra,
    imageConfirmation: { confirmationId, decision: "confirm" },
  });
  check(
    (
      await db.query("select id from background_jobs where session_id=$1", [
        session.id,
      ])
    ).rowCount === 1,
    kind + ": reconnect and repeated approval do not duplicate",
  );
  return jobs[0];
}
try {
  await db.connect();
  const owner = "541006fa-d2a1-4305-be55-b6263c27a1e3";
  const account = await admin.auth.admin.getUserById(owner);
  if (account.error) throw account.error;
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: account.data.user.email,
  });
  if (link.error) throw link.error;
  const login = await auth.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties.hashed_token,
  });
  if (login.error) throw login.error;
  token = login.data.session.access_token;
  if (!report.canvasId) {
    const project = (
      await api("/api/projects", {
        name: "Agent 生改图验收 " + report.startedAt,
      })
    ).project;
    report.projectId = project.id;
    report.canvasId = project.primaryCanvas.id;
  }
  const models = await api("/api/models");
  console.log("MODELS", JSON.stringify(models));
  await connect();
  const canvasJob = await generate(
    "canvas",
    "在无限画布生成一张 1:1 极简白色陶瓷杯产品图，纯黑背景，不要文字，单张即可。请提供可确认的生图方案。",
  );
  const assetId = canvasJob.result.asset_id;
  check(assetId, "canvas result has persisted asset ID");
  const asset = (
    await auth.from("asset_objects").select("*").eq("id", assetId).single()
  ).data;
  check(asset, "generated asset readable with user RLS");
  const downloaded = await auth.storage
    .from(asset.bucket)
    .download(asset.object_path);
  check(
    !downloaded.error && downloaded.data.size > 100,
    "generated original downloadable",
  );
  await generate(
    "edit",
    "黑色背景改为绿色，保留杯子的造型和位置，只改背景。这是一张图片，保持原比例。",
    {
      attachments: [
        {
          assetId,
          url: auth.storage.from(asset.bucket).getPublicUrl(asset.object_path)
            .data.publicUrl,
          mimeType: asset.mime_type ?? "image/png",
        },
      ],
    },
  );
  const canvas = (await api("/api/canvases/" + report.canvasId)).canvas;
  if (!report.designId) {
    const design = await api("/api/designs", {
      request_id: randomUUID(),
      canvas_id: report.canvasId,
      expected_canvas_revision: canvas.revision,
      canvas_element_id: "agent-qa-" + randomUUID(),
      name: "Agent QA 画板",
      width: 512,
      height: 512,
      background: "#ffffff",
      node: { x: 1400, y: 0, width: 512, height: 512 },
    });
    report.designId = design.design_id;
  }
  await generate(
    "designBackground",
    "给当前画板生成一张深蓝色科技背景，匹配画板尺寸，铺满置底。保留现有图层。",
    { activeDesignId: report.designId },
  );
  await generate(
    "designForeground",
    "给当前画板添加一只可爱的小老虎主体，放在正中央，不要背景，不删除或覆盖背景图层。只生成一个主体图片图层。",
    { activeDesignId: report.designId },
  );
  if (process.argv.includes('--checkpoint-live')) {
    const job = await generate('designForegroundCheckpoint', '在画板左上角添加一个小的金色星星主体，去掉背景，保留现有老虎和背景图层。只生成一张小星星图片。', { activeDesignId: report.designId });
    const saved = await db.query("select a.id from asset_objects a join background_jobs j on a.workspace_id=j.workspace_id where j.id=$1 and a.object_path like $2", [job.id, '%/' + job.id + '-source-before-matting.png']);
    check(saved.rowCount === 1, 'foreground source checkpoint persisted before matting');
    const foreground = await fetch('http://127.0.0.1:3002/api/uploads/' + job.result.asset_id + '/content', { headers: { Authorization: 'Bearer ' + token } });
    check(foreground.ok, 'foreground PNG accessible after local postprocessing');
    const png = Buffer.from(await foreground.arrayBuffer());
    const sharp = require('sharp');
    const metadata = await sharp(png).metadata();
    check(metadata.hasAlpha === true, 'foreground result has alpha channel');
    const alpha = await sharp(png).extractChannel('alpha').raw().toBuffer();
    check(alpha.some(v => v < 64) && alpha.some(v => v > 200), 'foreground contains transparent background and retained subject');
  }
  if (process.argv.includes('--cross-target') && !report.crossTarget?.jobId) {
    const sessionId = report.designBackground.sessionId;
    const before = (await db.query('select revision,scene from design_documents where id=$1', [report.designId])).rows[0];
    const existingId = process.argv.find(arg => arg.startsWith('--cross-target-existing='))?.split('=')[1];
    let jobs;
    if (existingId) {
      jobs = (await db.query('select id,status,target_kind,payload,result,error_code,created_at from background_jobs where id=$1 and session_id=$2 and canvas_id=$3', [existingId, sessionId, report.canvasId])).rows;
      const document = (await db.query('select scene,updated_at from design_documents where id=$1', [report.designId])).rows[0];
      check(jobs.length === 1 && new Date(document.updated_at) < new Date(jobs[0].created_at), 'cross-target: no design writes since the verified task began');
      check(JSON.stringify(document.scene) === JSON.stringify(report.persisted.designScene), 'cross-target: scene equals baseline before image edit');
    } else {
    const priorJobs = (await db.query('select id from background_jobs where session_id=$1', [sessionId])).rows.map(j => j.id);
    const attachments = [{ assetId, url: auth.storage.from(asset.bucket).getPublicUrl(asset.object_path).data.publicUrl, mimeType: asset.mime_type ?? 'image/png' }];
    // Deliberately keep the old active board AND use the same conversation.
    const events = await turn(sessionId, '黑色背景改为绿色', { attachments, activeDesignId: report.designId });
    const proposal = events.find(e => e.type === 'tool.completed' && e.toolName === 'generate_image' && e.output?.status === 'awaiting_confirmation')?.output;
    check(proposal, 'cross-target: real Agent creates a new image edit proposal');
    check(proposal.confirmation.details.target === null, 'cross-target: current attachment overrides old board');
    check(proposal.confirmation.details.aspectRatio === '1:1', 'cross-target: original square ratio preserved');
    check(proposal.confirmation.details.referenceImageCount === 1, 'cross-target: original image retained');
    check((await db.query('select id from background_jobs where session_id=$1', [sessionId])).rowCount === priorJobs.length, 'cross-target: no job before confirmation');
    await turn(sessionId, '确认生成', { activeDesignId: report.designId, imageConfirmation: { confirmationId: proposal.confirmation.confirmationId, decision: 'confirm' } });
    for (let n = 0; n < 240; n++) {
      jobs = (await db.query('select id,status,target_kind,payload,result,error_code from background_jobs where session_id=$1', [sessionId])).rows.filter(j => !priorJobs.includes(j.id));
      if (jobs.length && jobs.every(j => ['succeeded', 'failed', 'canceled'].includes(j.status))) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    }
    check(jobs.length === 1, 'cross-target: exactly one new task');
    check(jobs[0].target_kind === 'canvas' && jobs[0].payload.target?.kind === 'canvas', 'cross-target: confirmed job targets canvas even with active board');
    check(jobs[0].status === 'succeeded', 'cross-target: image edit completed (' + jobs[0].status + ')');
    const after = (await db.query('select revision,scene from design_documents where id=$1', [report.designId])).rows[0];
    check(JSON.stringify(before) === JSON.stringify(after), 'cross-target: design revision and every layer unchanged');
    const savedCanvas = (await api('/api/canvases/' + report.canvasId)).canvas;
    const images = savedCanvas.content.elements.filter(el => !el.isDeleted && el.type === 'image');
    check(images.some(el => el.customData?.assetId === assetId), 'cross-target: original image still exists');
    check(images.some(el => el.customData?.assetId === jobs[0].result.asset_id), 'cross-target: new result persisted on infinite canvas');
    report.crossTarget = { jobId: jobs[0].id, assetId: jobs[0].result.asset_id, sessionId, designUnchanged: true };
  }
  const freshCanvas = (await api("/api/canvases/" + report.canvasId)).canvas;
  const scene = (
    await db.query("select scene from design_documents where id=$1", [
      report.designId,
    ])
  ).rows[0].scene;
  report.persisted = {
    canvasElements: freshCanvas.content?.elements,
    designScene: scene,
  };
  check(
    scene.objects.length >= 2,
    "design background and foreground persisted separately",
  );
} catch (error) {
  report.error = String(error.message).replace(
    /Bearer\s+\S+/g,
    "Bearer [redacted]",
  );
  console.log("AUDIT_ERROR", report.error);
  process.exitCode = 1;
} finally {
  ws?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL("../artifacts/agent-flow-audit-20260908.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await db.end();
  await auth.auth.signOut({ scope: "local" });
}
