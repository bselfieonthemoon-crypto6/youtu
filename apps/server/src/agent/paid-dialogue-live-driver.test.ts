import { describe, expect, it } from "vitest";

import { parseCli, sanitizeTool, selectCancelableRows } from "../../scripts/test-paid-dialogue-live.js";

describe("paid dialogue live driver guardrails", () => {
  it("defaults to read-only preflight", () => {
    const cli = parseCli([]);
    expect(cli.mode).toBe("preflight");
    expect(cli.submit).toBe(false);
  });

  it.each(["init", "turn", "cancel"] as const)("requires --submit for %s", mode => {
    const args = mode === "turn" ? ["--turn", "确认生成"] : [`--${mode}`];
    expect(() => parseCli(args)).toThrow(/requires explicit --submit/);
  });

  it("allows a natural turn followed by image waiting as one operation", () => {
    const cli = parseCli(["--turn", "确认生成", "--wait-images", "--submit", "--aspect-ratio", "1:1"]);
    expect(cli).toMatchObject({ mode: "turn", turn: "确认生成", waitImages: true, aspectRatio: "1:1" });
  });

  it("rejects ambiguous destructive modes", () => {
    expect(() => parseCli(["--init", "--cancel", "--submit"])).toThrow(/choose exactly one mode/);
  });

  it("retains only whitelisted tool evidence and UUID references", () => {
    const evidence = sanitizeTool("generate_image", "completed", {
      prompt: "同系列海报",
      aspect_ratio: "4:5",
      input_images: ["https://example.test/signed?id=11111111-1111-4111-8111-111111111111&token=secret"],
      api_key: "must-not-survive",
    }, {
      jobId: "22222222-2222-4222-8222-222222222222",
      signedUrl: "https://example.test/private?token=secret",
    });
    expect(evidence).toEqual({
      toolName: "generate_image", status: "completed", prompt: "同系列海报", aspectRatio: "4:5",
      referenceAssetIds: ["11111111-1111-4111-8111-111111111111"],
      jobIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(JSON.stringify(evidence)).not.toContain("signed");
    expect(JSON.stringify(evidence)).not.toContain("must-not-survive");
  });

  it("scopes browser-style cancellation to the fixture session and creation time", () => {
    const rows = [
      { id: "run-live", session_id: "fixture-session", status: "running", created_at: "2026-09-11T10:00:01.000Z" },
      { id: "job-live", session_id: "fixture-session", status: "queued", created_at: "2026-09-11T10:00:02.000Z" },
      { id: "other-session", session_id: "other-session", status: "running", created_at: "2026-09-11T10:00:03.000Z" },
      { id: "before-fixture", session_id: "fixture-session", status: "running", created_at: "2026-09-11T09:59:59.000Z" },
      { id: "already-done", session_id: "fixture-session", status: "completed", created_at: "2026-09-11T10:00:04.000Z" },
    ];
    expect(selectCancelableRows(rows, "fixture-session", "2026-09-11T10:00:00.000Z").map(row => row.id))
      .toEqual(["run-live", "job-live"]);
  });
});
