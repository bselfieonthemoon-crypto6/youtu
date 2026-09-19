import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { CanvasServiceError, type CanvasService } from "../features/canvas/canvas-service.js";
import type { LayerElementSuggester } from "../features/images/layer-element-suggester.js";
import { resolveAgentImageAttachment } from "../agent/attachment-resolver.js";
import type { RequestAuthenticator, UserSupabaseClient } from "../supabase/user.js";

const requestSchema = z.object({
  canvasId: z.string().uuid(),
  image: z.object({
    assetId: z.string().min(1),
    url: z.string().min(1),
    mimeType: z.string().regex(/^image\//),
  }),
});

/**
 * Names the elements a generative split should extract.
 *
 * This is the only automatic path to a split's layer list: the model proposes the
 * names, the user sees and edits them in the toolbar before any image call is
 * quoted or charged. Authorization mirrors text recognition — the attachment is
 * resolved against a canvas the caller can read, never from the request body.
 */
export async function registerImageLayerElementRoutes(app: FastifyInstance, options: {
  auth: RequestAuthenticator;
  canvasService: CanvasService;
  createUserClient: (accessToken: string) => UserSupabaseClient;
  suggester: LayerElementSuggester;
}) {
  app.post("/api/images/layer-elements", { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
      const payload = requestSchema.parse(request.body);
      const canvas = await options.canvasService.getCanvas(user, payload.canvasId);
      const resolved = await resolveAgentImageAttachment({
        client: options.createUserClient(user.accessToken),
        attachment: payload.image,
        canvasContent: canvas.content,
      });
      const elements = await options.suggester.suggest(resolved);
      return reply.code(200).send({ elements });
    } catch (error) {
      request.log.error({
        code: (error as { code?: string })?.code,
        status: (error as { status?: number })?.status,
        name: error instanceof Error ? error.name : "UnknownError",
      }, "layer element suggestion failed");
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid layer element request." } });
      }
      if (error instanceof CanvasServiceError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof Error && ["attachment_not_found", "attachment_not_authorized"].includes(error.message)) {
        return reply.code(404).send({ error: { code: "image_not_found", message: "图片不存在或无权访问。" } });
      }
      if (error instanceof Error && error.message === "attachment_too_large") {
        return reply.code(413).send({ error: { code: "image_too_large", message: "图片超过识别大小限制。" } });
      }
      const code = (error as { code?: string })?.code;
      if (code === "vision_not_configured") {
        return reply.code(503).send({ error: { code, message: "自动识别元素的服务尚未配置。" } });
      }
      if (code === "layer_elements_unavailable") {
        return reply.code(422).send({ error: { code, message: "没能从这张图里识别出足够的独立元素，请改用框选剥离或自己填写元素名称。" } });
      }
      return reply.code(502).send({ error: { code: "suggestion_failed", message: "自动识别元素失败，请重试或改用框选剥离。" } });
    }
  });
}
