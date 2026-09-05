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
});
