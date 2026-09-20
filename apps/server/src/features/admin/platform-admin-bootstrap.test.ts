import { describe, expect, it, vi } from "vitest";

import {
  bootstrapPlatformAdmin,
  countActivePlatformAdmins,
  noPlatformAdminWarning,
  warnIfNoPlatformAdmin,
} from "./platform-admin-bootstrap.js";

/**
 * Fake for the four tables the bootstrap touches. It records writes so the tests
 * can prove the grant is idempotent, audited, and never applied twice.
 */
function fakeAdmin(input: {
  activeAdmins?: number;
  profiles?: Array<{ id: string; email: string | null }>;
  earliestOwner?: { owner_user_id: string } | null;
  upsertError?: { message: string } | null;
}) {
  const upserts: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const from = (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      ilike: () => builder,
      order: () => builder,
      limit: (count: number) => (table === "profiles"
        ? {
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({
              data: (input.profiles ?? []).slice(0, count), error: null,
            }).then(resolve),
          }
        : builder),
      maybeSingle: async () => {
        if (table === "workspaces") return { data: input.earliestOwner ?? null, error: null };
        if (table === "profiles") return { data: input.profiles?.[0] ?? null, error: null };
        return { data: null, error: null };
      },
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: input.upsertError ?? null };
      },
      insert: async (row: Record<string, unknown>) => {
        auditRows.push(row);
        return { error: null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: null, error: null, count: table === "platform_admins" ? (input.activeAdmins ?? 0) : null,
      }).then(resolve),
    };
    return builder;
  };
  return { client: { from } as never, upserts, auditRows };
}

const OWNER = "541006fa-d2a1-4305-be55-b6263c27a1e3";

describe("platform admin bootstrap", () => {
  it("counts only active, non-revoked admins and fails loudly when the count cannot be read", async () => {
    await expect(countActivePlatformAdmins(fakeAdmin({ activeAdmins: 2 }).client)).resolves.toBe(2);
    const broken = { from: () => { throw new Error("no database"); } } as never;
    await expect(countActivePlatformAdmins(broken)).rejects.toMatchObject({ message: "platform_admin_count_failed" });
  });

  it("names the exact command in the boot warning", () => {
    const warning = noPlatformAdminWarning();
    expect(warning).toContain("没有任何平台管理员");
    expect(warning).toContain("bootstrap:platform-admin");
    expect(warning).toContain("--email");
  });

  it("warns at boot when nobody is an admin, and stays quiet when someone is", async () => {
    const warn = vi.fn();
    await expect(warnIfNoPlatformAdmin(fakeAdmin({ activeAdmins: 0 }).client, { warn })).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("没有任何平台管理员"));

    const quiet = vi.fn();
    await expect(warnIfNoPlatformAdmin(fakeAdmin({ activeAdmins: 1 }).client, { warn: quiet })).resolves.toBe(1);
    expect(quiet).not.toHaveBeenCalled();

    // A failing check must not stop the server from starting.
    const failing = vi.fn();
    await expect(warnIfNoPlatformAdmin({ from: () => { throw new Error("boom"); } } as never, { warn: failing }))
      .resolves.toBe(-1);
    expect(failing).toHaveBeenCalledWith(expect.stringContaining("无法确认平台管理员数量"));
  });

  it("promotes the earliest workspace owner when no email is given", async () => {
    const fake = fakeAdmin({ activeAdmins: 0, earliestOwner: { owner_user_id: OWNER },
      profiles: [{ id: OWNER, email: "owner@example.com" }] });
    await expect(bootstrapPlatformAdmin(fake.client)).resolves.toEqual({
      status: "granted", userId: OWNER, email: "owner@example.com",
    });
    expect(fake.upserts).toEqual([expect.objectContaining({ user_id: OWNER, is_active: true, revoked_at: null })]);
    expect(fake.auditRows).toEqual([expect.objectContaining({
      actor_user_id: null, action: "platform_admin.bootstrap", target_kind: "user", target_id: OWNER,
    })]);
  });

  it("promotes a named account by email", async () => {
    const fake = fakeAdmin({ activeAdmins: 0, profiles: [{ id: OWNER, email: "Owner@Example.com" }] });
    await expect(bootstrapPlatformAdmin(fake.client, { email: "owner@example.com" }))
      .resolves.toMatchObject({ status: "granted", userId: OWNER });
  });

  it("refuses an unknown or ambiguous email instead of guessing an account", async () => {
    const missing = fakeAdmin({ activeAdmins: 0, profiles: [] });
    await expect(bootstrapPlatformAdmin(missing.client, { email: "ghost@example.com" }))
      .resolves.toEqual({ status: "unknown_user", email: "ghost@example.com" });
    expect(missing.upserts).toHaveLength(0);

    const ambiguous = fakeAdmin({ activeAdmins: 0, profiles: [
      { id: OWNER, email: "dup@example.com" }, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "dup@example.com" },
    ] });
    await expect(bootstrapPlatformAdmin(ambiguous.client, { email: "dup@example.com" }))
      .resolves.toMatchObject({ status: "unknown_user" });
    expect(ambiguous.upserts).toHaveLength(0);
  });

  it("does nothing when the install already has an active admin", async () => {
    const fake = fakeAdmin({ activeAdmins: 1, earliestOwner: { owner_user_id: OWNER } });
    await expect(bootstrapPlatformAdmin(fake.client)).resolves.toEqual({ status: "already_bootstrapped", platformAdmins: 1 });
    expect(fake.upserts).toHaveLength(0);
    expect(fake.auditRows).toHaveLength(0);
  });

  it("reports an empty install instead of inventing a candidate", async () => {
    const fake = fakeAdmin({ activeAdmins: 0, earliestOwner: null });
    await expect(bootstrapPlatformAdmin(fake.client)).resolves.toEqual({ status: "no_candidate" });
    expect(fake.upserts).toHaveLength(0);
  });

  it("surfaces a failed grant as an error rather than reporting success", async () => {
    const fake = fakeAdmin({ activeAdmins: 0, earliestOwner: { owner_user_id: OWNER },
      profiles: [{ id: OWNER, email: "owner@example.com" }], upsertError: { message: "denied" } });
    await expect(bootstrapPlatformAdmin(fake.client)).rejects.toMatchObject({
      message: "platform_admin_bootstrap_grant_failed",
    });
  });
});
