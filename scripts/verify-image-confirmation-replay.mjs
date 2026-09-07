// Re-confirm completed smoke-test jobs through the real WebSocket/runtime.
// This must reuse the existing jobs and must NOT call image generation again.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const { Client } = require("pg"),
  { createClient } = require("@supabase/supabase-js"),
  { WebSocket } = require("ws");
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  opts,
);
const auth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  opts,
);
let ws;
try {
  const report = JSON.parse(
    await readFile(
      new URL(
        "../artifacts/live-dialogue-image-smoke-result.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const owner = (
    await db.query("select created_by from chat_sessions where id=$1", [
      report.canvas.sessionId,
    ])
  ).rows[0].created_by;
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
  ws = new WebSocket(
    "ws://127.0.0.1:3001/api/ws?token=" +
      encodeURIComponent(login.data.session.access_token),
  );
  await new Promise((ok, no) => {
    ws.once("open", ok);
    ws.once("error", no);
  });
  for (const kind of ["canvas", "design"]) {
    const session = report[kind].sessionId;
    const expected = report[kind].tools.find((t) => t.output?.jobId)?.output
      .jobId;
    const before = Number(
      (
        await db.query(
          "select count(*) from background_jobs where session_id=$1",
          [session],
        )
      ).rows[0].count,
    );
    for (let n = 0; n < 2; n++)
      await new Promise((resolve, reject) => {
        let found = false;
        const started = Date.now();
        const timer = setTimeout(() => done(Error("Replay timed out")), 90000);
        const done = (error) => {
          clearTimeout(timer);
          ws.off("message", onMessage);
          error ? reject(error) : resolve();
        };
        const onMessage = (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === "error") return done(Error(m.message));
          if (m.type !== "event") return;
          const e = m.event;
          if (e.type === "tool.completed") {
            if (
              e.toolName !== "confirm_image_generation" ||
              e.output?.jobId !== expected
            )
              return done(Error("Replay did not reuse the expected task"));
            found = true;
          }
          if (e.type === "run.failed") done(Error("Replay run failed"));
          if (e.type === "run.completed") {
            if (!found)
              return done(Error("Missing deterministic confirmation"));
            console.log(
              JSON.stringify({
                kind,
                replay: n + 1,
                jobId: expected,
                elapsedMs: Date.now() - started,
              }),
            );
            done();
          }
        };
        ws.on("message", onMessage);
        ws.send(
          JSON.stringify({
            type: "command",
            action: "agent.run",
            payload: {
              canvasId: report.canvasId,
              sessionId: session,
              conversationId: session,
              prompt: "确认生成",
              ...(n === 1
                ? {
                    imageConfirmation: {
                      confirmationId: expected,
                      decision: "confirm",
                    },
                  }
                : {}),
            },
          }),
        );
      });
    const after = Number(
      (
        await db.query(
          "select count(*) from background_jobs where session_id=$1",
          [session],
        )
      ).rows[0].count,
    );
    if (before !== after) throw new Error("Replay created an extra task");
  }
  await new Promise((resolve, reject) => {
    let rejected = false;
    const timer = setTimeout(() => finish(new Error('Cross-session check timed out')), 90000);
    const finish = error => { clearTimeout(timer); ws.off('message', listener); error ? reject(error) : resolve(); };
    const listener = raw => {
      const message = JSON.parse(raw.toString()); if (message.type !== 'event') return;
      const event = message.event;
      if (event.type === 'tool.completed') rejected = Boolean(event.output?.error) && !event.output?.jobId;
      if (event.type === 'run.failed') finish(new Error('Unexpected run failure'));
      if (event.type === 'run.completed') finish(rejected ? undefined : new Error('Foreign proposal ID was not rejected'));
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({type:'command',action:'agent.run',payload:{canvasId:report.canvasId,sessionId:report.canvas.sessionId,
      conversationId:report.canvas.sessionId,prompt:'确认生成',imageConfirmation:{confirmationId:report.design.tools.find(t=>t.output?.jobId).output.jobId,decision:'confirm'}}}));
  });
  console.log('PASS: a structured confirmation cannot select a proposal from another conversation.');
  console.log(
    "PASS: all confirmations reused their original task, without a new generation.",
  );
} finally {
  ws?.close();
  await auth.auth.signOut({ scope: "local" });
  await db.end();
}
