import { describe, expect, it } from "vitest";

import { AdminChannelError, createAdminChannelService } from "./admin-channel-service.js";

function fakeAdmin(input: {
  isActorAdmin?: boolean;
  directory?: unknown;
  detail?: unknown;
  rates?: unknown;
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
    if (fn === "admin_channel_directory") {
      return {
        data: input.directory ?? { total: 0, windowDays: 30, totalJobs: 0, totalFailures: 0, channels: [] },
        error: null,
      };
    }
    if (fn === "admin_channel_detail") {
      return {
        data: input.detail ?? { channel: { id: args.p_config_id }, history: [], errorCodes: [], failures: [] },
        error: null,
      };
    }
    return {
      data: input.rates ?? {
        windowDays: 30, totalJobs: 0, totalFailures: 0, overallFailureRate: null,
        providerJobs: 0, providerFailures: 0, providerFailureRate: null, channelCount: 0, errorCodes: [],
      },
      error: null,
    };
  };
  return { client: { from, rpc } as never, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONFIG = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return { ...createAdminChannelService({ getAdminClient: () => fake.client }), fake };
}

describe("admin channel service", () => {
  it("refuses a non-platform-admin actor before reading anything", async () => {
    const { listChannels, getChannel, getFailureRates, fake } = service({ isActorAdmin: false });
    const calls = [
      () => listChannels(ACTOR),
      () => getChannel(ACTOR, CONFIG),
      () => getFailureRates(ACTOR),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("passes every filter through, including the false one", async () => {
    const { listChannels, fake } = service({});
    await listChannels(ACTOR, {
      workspaceId: WORKSPACE, query: "  上游  ", enabled: false, testStatus: "failed",
      days: 7, limit: 20, offset: 40,
    });
    // `enabled: false` has to survive as false: treating it like "unset" would show
    // enabled channels to an operator who asked for disabled ones.
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_channel_directory",
      args: {
        p_actor_user_id: ACTOR, p_workspace_id: WORKSPACE, p_query: "上游", p_enabled: false,
        p_test_status: "failed", p_days: 7, p_limit: 20, p_offset: 40,
      },
    });

    await listChannels(ACTOR, { enabled: true, query: "   ", testStatus: "wat" });
    expect(fake.rpcCalls[1]!.args).toMatchObject({
      p_enabled: true, p_query: null, p_test_status: null,
    });
  });

  it("clamps the window, the page size and the offset", async () => {
    const { listChannels, fake } = service({});
    await listChannels(ACTOR, { days: 10_000, limit: 10_000, offset: -5 });
    await listChannels(ACTOR, { days: 0, limit: 0 });
    expect(fake.rpcCalls[0]!.args).toMatchObject({ p_days: 365, p_limit: 200, p_offset: 0 });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_days: 1, p_limit: 1 });
    // A number the caller never sent must not silently become "no window".
    await listChannels(ACTOR, {});
    expect(fake.rpcCalls[2]!.args).toMatchObject({ p_days: 30, p_limit: 50, p_offset: 0 });
  });

  it("returns the directory exactly as the function shaped it so the route can validate it", async () => {
    const directory = { total: 2, windowDays: 30, totalJobs: 358, totalFailures: 49, channels: [{ id: CONFIG }] };
    const { listChannels } = service({ directory });
    await expect(listChannels(ACTOR)).resolves.toEqual({
      total: 2, windowDays: 30, totalJobs: 358, totalFailures: 49, channels: [{ id: CONFIG }],
    });
  });

  it("keeps a malformed payload visible instead of quietly zeroing the counters", async () => {
    // The rate is what an operator acts on, so a function that stops returning it
    // must fail the contract parse rather than read as "no failures".
    const { listChannels } = service({ directory: { total: "nope", channels: "nope" } });
    const result = await listChannels(ACTOR);
    expect(result.total).toBe("nope");
    expect(result.channels).toEqual([]);
  });

  it("returns a channel detail with its history, breakdown and newest failures", async () => {
    const { getChannel, fake } = service({
      detail: {
        channel: { id: CONFIG, displayName: "BASE" },
        history: [{ action: "test_failed", errorCode: "http_401" }],
        errorCodes: [{ errorCode: "http_401", failures: 2 }],
        failures: [{ jobId: "job-1", errorCode: "http_401" }],
      },
    });
    const result = await getChannel(ACTOR, CONFIG, { days: 7, historyLimit: 5, jobLimit: 3 });
    expect(result).toMatchObject({
      channel: { id: CONFIG }, history: [{ action: "test_failed" }],
      errorCodes: [{ errorCode: "http_401" }], failures: [{ jobId: "job-1" }],
    });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_channel_detail",
      args: { p_actor_user_id: ACTOR, p_config_id: CONFIG, p_days: 7, p_history_limit: 5, p_job_limit: 3 },
    });
  });

  it("reports an unknown channel as not found and clamps the detail limits", async () => {
    const missing = service({ detail: { channel: null } });
    await expect(missing.getChannel(ACTOR, CONFIG)).rejects
      .toMatchObject({ code: "admin_channel_not_found", statusCode: 404 });

    const { getChannel, fake } = service({});
    await getChannel(ACTOR, CONFIG, { days: 9999, historyLimit: 9999, jobLimit: 9999 });
    expect(fake.rpcCalls[0]!.args).toMatchObject({ p_days: 365, p_history_limit: 100, p_job_limit: 100 });
  });

  it("returns both failure rates with the per-code breakdown", async () => {
    const rates = {
      windowDays: 30, totalJobs: 1449, totalFailures: 553, overallFailureRate: 0.3816,
      providerJobs: 358, providerFailures: 49, providerFailureRate: 0.1369, channelCount: 3,
      errorCodes: [{ errorCode: "provider_rejected", failures: 9, channelCount: 1 }],
    };
    const { getFailureRates, fake } = service({ rates });
    await expect(getFailureRates(ACTOR, { days: 30, limit: 10 })).resolves.toEqual(rates);
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_channel_failure_rates",
      args: { p_actor_user_id: ACTOR, p_days: 30, p_limit: 10 },
    });
  });

  it("translates every refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["UNKNOWN_CHANNEL: no such provider configuration", "admin_channel_not_found", 404],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { listChannels } = service({ rpcError: { message } });
      const error = await listChannels(ACTOR).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminChannelError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });
});
