import { describe, expect, it, vi } from "vitest";
import { createImageProposalStore } from "./image-proposal-store.js";

const context = {
  access_token: "token",
  user_id: "10000000-0000-4000-8000-000000000001",
  canvas_id: "20000000-0000-4000-8000-000000000002",
  session_id: "30000000-0000-4000-8000-000000000003",
  run_id: "40000000-0000-4000-8000-000000000004",
};
const proposal = {
  id: "50000000-0000-4000-8000-000000000005",
  status: "pending",
  origin_run_id: "60000000-0000-4000-8000-000000000006",
  created_at: "2026-09-10T12:00:00.000Z",
  input: { title: "Landing", prompt: "Current landing plan", model: "test", aspectRatio: "16:9" },
};

describe("image proposal atomic requirement adapter", () => {
  it.each([0, 1, 2, 101])("binds a unique named pending proposal only with complete scoped results (%s)", async count => {
    const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: Array.from({ length: count }, () => ({ ...proposal, input: { ...proposal.input, title: "Mellow Coffee 优惠券" } })), error: null })) };
    const store = createImageProposalStore(() => ({ from: () => query }));
    const match = await store.namedCancellation(context, "取消优惠券方案");
    expect(match?.id ?? null).toBe(count === 1 ? proposal.id : null);
    expect(query.eq).toHaveBeenCalledWith("created_by", context.user_id);
    expect(query.eq).toHaveBeenCalledWith("session_id", context.session_id);
    expect(query.eq).toHaveBeenCalledWith("canvas_id", context.canvas_id);
    expect(query.eq).toHaveBeenCalledWith("status", "pending");
  });
  it("resolves the current proposal through the run-bound RPC", async () => {
    const rpc = vi.fn(async () => ({ data: proposal, error: null }));
    const store = createImageProposalStore(() => ({ rpc }));
    await expect(store.latestForCurrentRequirement(context)).resolves.toMatchObject({
      id: proposal.id,
      status: "pending",
      originRunId: proposal.origin_run_id,
      input: { prompt: "Current landing plan" },
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("loomic_get_current_image_proposal", {
      p_session: context.session_id,
      p_canvas: context.canvas_id,
      p_run: context.run_id,
    });
  });

  it("returns null when the atomic decision observes a newer requirement", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const store = createImageProposalStore(() => ({ rpc }));
    await expect(store.decideCurrent(context, proposal.id, "confirm")).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("loomic_decide_current_image", {
      p_id: proposal.id,
      p_session: context.session_id,
      p_canvas: context.canvas_id,
      p_run: context.run_id,
      p_decision: "confirm",
    });
  });

  it("uses the service-role decision RPC with the explicit actor id", async () => {
    const rpc = vi.fn(async () => ({ data: { ...proposal, status: "confirmed" }, error: null }));
    const store = createImageProposalStore(() => ({ rpc }), () => ({ rpc }));
    await expect(store.decide(context, proposal.id, "confirm")).resolves.toMatchObject({
      id: proposal.id,
      status: "confirmed",
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("loomic_decide_image_service", {
      p_id: proposal.id,
      p_user: context.user_id,
      p_session: context.session_id,
      p_canvas: context.canvas_id,
      p_run: context.run_id,
      p_decision: "confirm",
    });
  });

  it("fails closed when no service-role client is configured for a decision", async () => {
    const rpc = vi.fn();
    const store = createImageProposalStore(() => ({ rpc }));
    await expect(store.decide(context, proposal.id, "confirm")).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("loads only the same owner, session and canvas job including persisted result state", async () => {
    const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { id: proposal.id, status: "succeeded",
        result: { asset_id: "70000000-0000-4000-8000-000000000007" } }, error: null })) };
    const store = createImageProposalStore(() => ({ from: vi.fn(() => query) }));
    await expect(store.job(context, proposal.id)).resolves.toMatchObject({ id: proposal.id, status: "succeeded" });
    expect(query.select).toHaveBeenCalledWith(
      "id,status,error_code,error_message,attempt_count,max_attempts,result,payload",
    );
    expect(query.eq).toHaveBeenCalledWith("id", proposal.id);
    expect(query.eq).toHaveBeenCalledWith("created_by", context.user_id);
    expect(query.eq).toHaveBeenCalledWith("session_id", context.session_id);
    expect(query.eq).toHaveBeenCalledWith("canvas_id", context.canvas_id);
  });
});
