import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
test.use({ trace: "off", video: "off" });

test("real conversation restores an existing image without generating or inserting twice", async ({
  page,
  request,
}, info) => {
  test.skip(
    process.env.SUPABASE_URL !== "http://127.0.0.1:54421",
    "Local replica only",
  );
  test.setTimeout(180000);
  const report = JSON.parse(
    await readFile(
      new URL(
        "../../../artifacts/agent-flow-audit-20260908.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const crossTarget = process.env.LOOMIC_E2E_CROSS_TARGET === "true";
  if (crossTarget) expect(report.crossTarget?.jobId).toBeTruthy();
  const url = process.env.SUPABASE_URL!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, opts);
  const account = await admin.auth.admin.getUserById(
    "541006fa-d2a1-4305-be55-b6263c27a1e3",
  );
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: account.data.user!.email!,
  });
  const login = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.data.properties!.hashed_token,
  });
  const token = login.data.session!.access_token;
  const headers = { Authorization: `Bearer ${token}` };
  const api = "http://127.0.0.1:3002";
  try {
    const queryJobs = async () =>
      (
        await client
          .from("background_jobs")
          .select("id,status")
          .eq("canvas_id", report.canvasId)
      ).data!;
    const readCanvas = async () => {
      const r = await request.get(`${api}/api/canvases/${report.canvasId}`, {
        headers,
      });
      expect(r.ok()).toBe(true);
      return (await r.json()).canvas;
    };
    const initialJobs = await queryJobs(),
      before = await readCanvas();
    const elementIds = (canvas: any) =>
      canvas.content.elements
        .filter((e: any) => !e.isDeleted)
        .map((e: any) => e.id)
        .sort();
    await page.addInitScript(
      ({ key, session }) => localStorage.setItem(key, JSON.stringify(session)),
      {
        key: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`,
        session: login.data.session,
      },
    );
    const events: any[] = [];
    let confirmationRunId: string | undefined;
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        try {
          const value = JSON.parse(String(payload));
          if (value.type === "command.ack" && value.action === "agent.run") confirmationRunId = value.payload?.runId;
          if (value.type === "event") events.push(value.event);
        } catch {}
      }),
    );
    await page.goto(
      `/canvas?id=${report.canvasId}&session=${crossTarget ? report.crossTarget.sessionId : report.canvas.sessionId}`,
    );
    const editable = page.getByRole("textbox", { name: "输入消息" });
    await expect(editable).toBeVisible({ timeout: 45000 });
    await expect(editable).toBeEnabled();
    await editable.fill("确认生成");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect
      .poll(
        () =>
          events.find(
            (e) =>
              e.type === "tool.completed" &&
              e.runId === confirmationRunId &&
              e.toolName === "confirm_image_generation",
          )?.output?.status,
        { timeout: 90000 },
      )
      .toBe("succeeded");
    await expect
      .poll(() => events.some((e) => e.type === "run.completed" && e.runId === confirmationRunId), {
        timeout: 90000,
      })
      .toBe(true);
    expect(await queryJobs()).toEqual(initialJobs);
    expect(elementIds(await readCanvas())).toEqual(elementIds(before));
    await expect(
      page.getByText("Failed to get response.", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "菜单", exact: true }),
    ).toBeVisible({ timeout: 45000 });
    await expect
      .poll(
        async () =>
          page.locator("canvas").evaluateAll((canvases) =>
            canvases.some((canvas) => {
              const context = canvas.getContext("2d");
              if (!context) return false;
              const pixels = context.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              for (let i = 0; i < pixels.length; i += 16)
                if (
                  pixels[i + 3] > 200 &&
                  Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
                    Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >
                    60
                )
                  return true;
              return false;
            }),
          ),
        { timeout: 45000 },
      )
      .toBe(true);
    expect(elementIds(await readCanvas())).toEqual(elementIds(before));
    for (const kind of ["canvas", "edit"]) {
      const assetId = report[kind].jobs[0].result.asset_id;
      const image = await request.get(`${api}/api/uploads/${assetId}/content`, {
        headers,
      });
      expect(image.ok()).toBe(true);
      expect((await image.body()).length).toBeGreaterThan(1000);
    }
    if (crossTarget) {
      const image = await request.get(`${api}/api/uploads/${report.crossTarget.assetId}/content`, { headers });
      expect(image.ok()).toBe(true);
      expect((await image.body()).length).toBeGreaterThan(1000);
      expect((await readCanvas()).content.elements.some((element: any) => !element.isDeleted && element.customData?.assetId === report.crossTarget.assetId)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath("agent-image-replay.png") });
  } finally {
    await client.auth.signOut({ scope: "local" });
  }
});
