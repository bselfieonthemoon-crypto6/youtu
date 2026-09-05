import type { FastifyInstance, FastifyReply } from "fastify";
import {
  userIdSchema,
  workspaceMemberCreateRequestSchema,
  workspaceMemberErrorResponseSchema,
  workspaceMemberListResponseSchema,
  workspaceMemberResponseSchema,
  workspaceMemberUpdateRequestSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { WorkspaceMemberServiceError, type WorkspaceMemberService } from "../features/members/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerWorkspaceMemberRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; memberService: WorkspaceMemberService; viewerService: ViewerService },
) {
  app.get("/api/workspace/members", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const members = await options.memberService.list(context.user, context.workspaceId);
      return reply.code(200).send(workspaceMemberListResponseSchema.parse({ members }));
    } catch (error) {
      return sendMemberError(error, reply);
    }
  });

  app.post("/api/workspace/members", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const payload = workspaceMemberCreateRequestSchema.parse(request.body);
      const member = await options.memberService.add(context.user, context.workspaceId, payload.email, payload.role);
      return reply.code(201).send(workspaceMemberResponseSchema.parse({ member }));
    } catch (error) {
      return sendMemberError(error, reply);
    }
  });

  app.patch("/api/workspace/members/:userId", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const targetUserId = userIdSchema.parse((request.params as { userId?: unknown }).userId);
      const payload = workspaceMemberUpdateRequestSchema.parse(request.body);
      const member = await options.memberService.updateRole(context.user, context.workspaceId, targetUserId, payload.role);
      return reply.code(200).send(workspaceMemberResponseSchema.parse({ member }));
    } catch (error) {
      return sendMemberError(error, reply);
    }
  });

  app.delete("/api/workspace/members/:userId", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const targetUserId = userIdSchema.parse((request.params as { userId?: unknown }).userId);
      await options.memberService.remove(context.user, context.workspaceId, targetUserId);
      return reply.code(204).send();
    } catch (error) {
      return sendMemberError(error, reply);
    }
  });
}

async function resolveContext(
  request: Parameters<RequestAuthenticator["authenticate"]>[0],
  reply: FastifyReply,
  options: { auth: RequestAuthenticator; viewerService: ViewerService },
) {
  const user = await options.auth.authenticate(request);
  if (!user) {
    reply.code(401).send({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
    return null;
  }
  const viewer = await options.viewerService.ensureViewer(user);
  return { user, workspaceId: viewer.workspace.id };
}

function sendMemberError(error: unknown, reply: FastifyReply) {
  if (isZodError(error)) {
    return reply.code(422).send(workspaceMemberErrorResponseSchema.parse({ error: { code: "member_invalid_request", message: "Invalid workspace member request." } }));
  }
  if (error instanceof WorkspaceMemberServiceError) {
    return reply.code(error.statusCode).send(workspaceMemberErrorResponseSchema.parse({ error: { code: error.code, message: error.message } }));
  }
  return reply.code(500).send(workspaceMemberErrorResponseSchema.parse({ error: { code: "member_persistence_failed", message: "Unable to process workspace members." } }));
}

function isZodError(error: unknown): error is { name: string; issues: unknown[] } {
  return error instanceof Error && error.name === "ZodError" && "issues" in error;
}
