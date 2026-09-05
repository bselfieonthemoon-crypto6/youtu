import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  designTemplateReplaceApplyRequestSchema,
  designTemplateReplaceApplyResponseSchema,
  designTemplateReplacePreviewRequestSchema,
  designTemplateReplacePreviewResponseSchema,
  designUuidSchema,
  updateDesignTemplateVariablesRequestSchema,
} from "@loomic/shared";

import { DesignResourceServiceError } from "../features/design-resources/design-resource-service.js";
import type {
  CreateTemplateFromDesignInput,
  DesignTemplateService,
} from "../features/design-resources/design-template-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const templateListQuerySchema = z
  .object({
    scope: z.enum(["platform", "workspace"]).optional(),
    status: z
      .enum(["draft", "pending_review", "published", "rejected", "disabled"])
      .optional(),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const adminTemplateListQuerySchema = templateListQuerySchema.extend({
  deleted: z.enum(["false", "true", "all"]).optional(),
});

const nullableUrl = z.string().url().nullable().default(null);
const nullableText = (max: number) =>
  z.string().max(max).nullable().default(null);
const createFromDesignSchema = z
  .object({
    request_id: z.string().uuid(),
    design_id: z.string().uuid(),
    scope: z.enum(["platform", "workspace"]),
    workspace_id: z.string().uuid().nullable(),
    name: z.string().trim().min(1).max(200),
    description: nullableText(2_000),
    preview_asset_object_id: z.string().uuid().nullable().default(null),
    category_id: z.string().uuid().nullable().default(null),
    tag_ids: z.array(z.string().uuid()).max(100).default([]),
    source_url: nullableUrl,
    author: nullableText(300),
    license_name: nullableText(300),
    license_url: nullableUrl,
    attribution: nullableText(2_000),
    usage_restrictions: nullableText(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.scope === "platform" && value.workspace_id !== null) ||
      (value.scope === "workspace" && value.workspace_id === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id does not match template scope",
      });
    }
    if (new Set(value.tag_ids).size !== value.tag_ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tag_ids"],
        message: "tag_ids must be unique",
      });
    }
  });

export async function registerDesignTemplateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    templateService: DesignTemplateService;
  },
) {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/design-templates",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const input = templateListQuerySchema.parse(request.query);
        return reply
          .code(200)
          .send(await options.templateService.list(user, input));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { templateId: string } }>(
    "/api/design-templates/:templateId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply
          .code(200)
          .send(
            await options.templateService.get(
              user,
              designUuidSchema.parse(request.params.templateId),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { templateId: string } }>(
    "/api/design-templates/:templateId/replace-preview",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const templateId = designUuidSchema.parse(request.params.templateId);
        const input = designTemplateReplacePreviewRequestSchema.parse(
          request.body,
        );
        if (input.template_id !== templateId)
          throw new Error("template_id_mismatch");
        return reply
          .code(200)
          .send(
            designTemplateReplacePreviewResponseSchema.parse(
              await options.templateService.previewReplace(user, input),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { templateId: string } }>(
    "/api/design-templates/:templateId/replace-apply",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const templateId = designUuidSchema.parse(request.params.templateId);
        const input = designTemplateReplaceApplyRequestSchema.parse(
          request.body,
        );
        if (input.template_id !== templateId)
          throw new Error("template_id_mismatch");
        return reply
          .code(200)
          .send(
            designTemplateReplaceApplyResponseSchema.parse(
              await options.templateService.applyReplace(user, input),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post(
    "/api/admin/design-catalog/templates/from-design",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const input = createFromDesignSchema.parse(
          request.body,
        ) as CreateTemplateFromDesignInput;
        return reply
          .code(201)
          .send(await options.templateService.createFromDesign(user, input));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.put<{ Params: { templateId: string } }>(
    "/api/admin/design-catalog/templates/:templateId/variables",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const templateId = designUuidSchema.parse(request.params.templateId);
        const input = updateDesignTemplateVariablesRequestSchema.parse(
          request.body,
        );
        return reply
          .code(200)
          .send(
            await options.templateService.updateVariables(
              user,
              templateId,
              input,
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/admin/design-catalog/templates",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply.code(200).send(
          await options.templateService.list(
            user,
            (() => {
              const parsed = adminTemplateListQuerySchema.parse(request.query);
              const { deleted, ...input } = parsed;
              return {
                ...input,
                deleted:
                  deleted === "all"
                    ? ("all" as const)
                    : deleted === "true"
                      ? ("only" as const)
                      : ("exclude" as const),
              };
            })(),
          ),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "unauthorized",
      message: "Missing or invalid bearer token.",
    },
  });
}

function sendError(error: unknown, reply: FastifyReply) {
  if (isZodError(error)) {
    return reply.code(400).send({
      error: { code: "resource_invalid", message: "Invalid request." },
    });
  }
  if (error instanceof DesignResourceServiceError) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof Error && error.message === "template_id_mismatch") {
    return reply.code(400).send({
      error: {
        code: "resource_invalid",
        message: "Template ID does not match path.",
      },
    });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return reply.code(error.statusCode).send({
      error: {
        code:
          "code" in error && typeof error.code === "string"
            ? error.code
            : "resource_write_failed",
        message:
          error instanceof Error ? error.message : "Template apply failed.",
      },
    });
  }
  return reply.code(500).send({
    error: { code: "resource_write_failed", message: "Internal server error." },
  });
}

function isZodError(error: unknown): error is { issues: unknown[] } {
  return typeof error === "object" && error !== null && "issues" in error;
}
