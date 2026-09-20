import { describe, expect, it, vi } from "vitest";

import { AdminBillingError, createAdminBillingService } from "./admin-billing-service.js";

function fakeAdmin(input: {
  isActorAdmin?: boolean;
  billing?: unknown;
  planResult?: unknown;
  adjustResult?: unknown;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = () => {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      is() { return builder; },
      maybeSingle: async () => ({ data: input.isActorAdmin === false ? null : { user_id: "actor" }, error: null }),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (input.rpcError) return { data: null, error: input.rpcError };
    if (fn === "admin_workspace_billing") return { data: input.billing ?? {}, error: null };
    if (fn === "admin_set_workspace_plan") return { data: input.planResult ?? { plan: args.p_plan, planBefore: "free", grantedCredits: args.p_grant_credits, balance: 100 }, error: null };
    return { data: input.adjustResult ?? { delta: args.p_delta, balance: 100 }, error: null };
  };
  return { client: { from, rpc } as never, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return { ...createAdminBillingService({ getAdminClient: () => fake.client }), fake };
}

describe("admin billing service", () => {
  it("refuses a non-platform-admin actor before any read or write", async () => {
    const { getBilling, setPlan, adjustCredits, fake } = service({ isActorAdmin: false });
    const calls = [
      () => getBilling(ACTOR, WORKSPACE),
      () => setPlan(ACTOR, { workspaceId: WORKSPACE, plan: "pro", grantCredits: 100, reason: "升级" }),
      () => adjustCredits(ACTOR, { workspaceId: WORKSPACE, delta: 50, reason: "补偿" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("reads one workspace's billing with a bounded transaction limit", async () => {
    const billing = { workspace: { id: WORKSPACE }, plan: "free", balance: 940, recentTransactions: [] };
    const { getBilling, fake } = service({ billing });
    await expect(getBilling(ACTOR, WORKSPACE, 10)).resolves.toEqual(billing);
    await getBilling(ACTOR, WORKSPACE, 10_000);
    await getBilling(ACTOR, WORKSPACE);
    expect(fake.rpcCalls[0]!.args).toEqual({ p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_tx_limit: 10 });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_tx_limit: 100 });
    expect(fake.rpcCalls[2]!.args).toMatchObject({ p_tx_limit: 20 });
  });

  it("sets a plan through the audited function with a trimmed reason", async () => {
    const { setPlan, fake } = service({});
    await expect(setPlan(ACTOR, { workspaceId: WORKSPACE, plan: "ultra", grantCredits: 500, reason: "  商务补偿  " }))
      .resolves.toEqual({ plan: "ultra", planBefore: "free", grantedCredits: 500, balance: 100 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_set_workspace_plan",
      args: { p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_plan: "ultra", p_grant_credits: 500, p_reason: "商务补偿" },
    });
  });

  it("tolerates a partially malformed plan result instead of producing NaN", async () => {
    const { setPlan } = service({ planResult: { plan: 7, planBefore: 5, grantedCredits: "nope", balance: "nope" } });
    await expect(setPlan(ACTOR, { workspaceId: WORKSPACE, plan: "pro", grantCredits: 0, reason: "调整" }))
      .resolves.toEqual({ plan: "7", planBefore: null, grantedCredits: 0, balance: 0 });
  });

  it("adjusts credits through the audited function, including negative deltas", async () => {
    const { adjustCredits, fake } = service({});
    await expect(adjustCredits(ACTOR, { workspaceId: WORKSPACE, delta: -250, reason: "退回多算额度" }))
      .resolves.toEqual({ delta: -250, balance: 100 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_adjust_credits",
      args: { p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_delta: -250, p_reason: "退回多算额度" },
    });
  });

  it("translates every billing refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required for a billing change", "admin_reason_required", 400],
      ["UNKNOWN_WORKSPACE: no such workspace", "admin_workspace_not_found", 404],
      ["INVALID_AMOUNT: the adjustment must be a non-zero amount within 1000000", "admin_invalid_amount", 400],
      ["INSUFFICIENT_BALANCE: the adjustment would make the balance negative", "admin_insufficient_balance", 409],
      ["CONCURRENT_MODIFICATION: credit balance changed while updating", "admin_write_failed", 409],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { adjustCredits } = service({ rpcError: { message } });
      const error = await adjustCredits(ACTOR, { workspaceId: WORKSPACE, delta: -10, reason: "扣减" }).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminBillingError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });

  it("explains an insufficient balance in user terms", async () => {
    const { adjustCredits } = service({ rpcError: { message: "INSUFFICIENT_BALANCE: nope" } });
    const error = await adjustCredits(ACTOR, { workspaceId: WORKSPACE, delta: -10, reason: "扣减" }).catch(caught => caught);
    expect(error.message).toContain("余额不足");
    void vi;
  });
});
