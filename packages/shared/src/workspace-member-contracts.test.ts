import { describe, expect, it } from "vitest";

import {
  workspaceMemberCreateRequestSchema,
  workspaceMemberListResponseSchema,
  workspaceMemberUpdateRequestSchema,
} from "./workspace-member-contracts.js";

describe("workspace member contracts", () => {
  it("allows only member/admin assignments", () => {
    expect(workspaceMemberCreateRequestSchema.safeParse({ email: "user@example.com", role: "member" }).success).toBe(true);
    expect(workspaceMemberUpdateRequestSchema.safeParse({ role: "admin" }).success).toBe(true);
    expect(workspaceMemberUpdateRequestSchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("requires safe public member fields", () => {
    const result = workspaceMemberListResponseSchema.safeParse({ members: [{
      userId: "user-1",
      email: "user@example.com",
      displayName: "User",
      avatarUrl: null,
      role: "owner",
      joinedAt: "2026-09-03T00:00:00.000Z",
      isCurrentUser: true,
    }] });
    expect(result.success).toBe(true);
  });
});
