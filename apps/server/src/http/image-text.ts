import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ImageTextRecognizer } from "../features/images/image-text-recognizer.js";
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

export async function registerImageTextRoutes(app: FastifyInstance, options: {
  auth: RequestAuthenticator;
  canvasService: CanvasService;
  createUserClient: (accessToken: string) => UserSupabaseClient;
  recognizer: ImageTextRecognizer;
}) {
  app.post("/api/images/recognize-text", { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
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
      const texts = await options.recognizer.recognize(resolved);
      return reply.code(200).send({ texts });
    } catch (error) {
      request.log.error({
        code: (error as { code?: string })?.code,
        status: (error as { status?: number })?.status,
        name: error instanceof Error ? error.name : "UnknownError",
      }, "image text recognition failed");
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid image recognition request." } });
      }
      const code = (error as { code?: string })?.code;
      if (code === "vision_not_configured") {
        return reply.code(503).send({ error: { code, message: "图片文字识别服务尚未配置。" } });
      }
      return reply.code(502).send({ error: { code: "recognition_failed", message: "图片文字识别失败，请重试。" } });
    }
  });
}
