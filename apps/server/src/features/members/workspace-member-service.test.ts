import { describe, expect, it, vi } from "vitest";

import type { UserSupabaseClient } from "../../supabase/user.js";
import { createWorkspaceMemberService } from "./workspace-member-service.js";

function userClient(role: "owner" | "admin" | "member") {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn().mockResolvedValue({ data: { role }, error: null }),
  };
  return { from: vi.fn(() => query) } as unknown as UserSupabaseClient;
}

const user = { id: "user-1", email: "user@example.com", accessToken: "token", userMetadata: {} };

describe("workspace member service security", () => {
  it("rejects ordinary members before opening the service-role client", async () => {
    const getAdminClient = vi.fn();
    const service = createWorkspaceMemberService({
      createUserClient: () => userClient("member"),
      getAdminClient,
    });
    await expect(service.list(user, "workspace-1")).rejects.toMatchObject({ code: "member_forbidden", statusCode: 403 });
    expect(getAdminClient).not.toHaveBeenCalled();
  });

  it("does not let an administrator assign another administrator", async () => {
    const getAdminClient = vi.fn();
    const service = createWorkspaceMemberService({
      createUserClient: () => userClient("admin"),
      getAdminClient,
    });
    await expect(service.add(user, "workspace-1", "other@example.com", "admin")).rejects.toMatchObject({ code: "member_forbidden", statusCode: 403 });
    expect(getAdminClient).not.toHaveBeenCalled();
  });

  it("invalidates local sockets only after a successful member deletion", async () => {
    const onMembershipInvalidated = vi.fn();
    const admin = {
      from: vi.fn(() => {
        let deleting = false;
        const query: any = {
          select: vi.fn(() => query),
          delete: vi.fn(() => { deleting = true; return query; }),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({ data: { role: "member" }, error: null })),
          then: (resolve: (value: unknown) => void) =>
            resolve(deleting ? { error: null } : { data: null, error: null }),
        };
        return query;
      }),
    };
    const service = createWorkspaceMemberService({
      createUserClient: () => userClient("owner"),
      getAdminClient: () => admin as never,
      onMembershipInvalidated,
    });

    await service.remove(user, "workspace-1", "user-2");

    expect(onMembershipInvalidated).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-2",
    });
  });
});
