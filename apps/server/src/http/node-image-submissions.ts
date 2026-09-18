import type { FastifyInstance, FastifyReply } from "fastify";
import {
  nodeImageSubmissionRequestSchema, nodeImageSubmissionLookupSchema,
  nodeImageSubmissionResponseSchema, nodeImageSubmissionLookupResponseSchema,
} from "@loomic/shared";
import type { RequestAuthenticator } from "../supabase/user.js";
import { NodeImageSubmissionError, type NodeImageSubmissionService } from "../features/jobs/node-image-submission-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import { JobServiceError } from "../features/jobs/job-service.js";

export async function registerNodeImageSubmissionRoutes(app: FastifyInstance, options: {
  auth: RequestAuthenticator;
  service: NodeImageSubmissionService;
}) {
  app.post("/api/jobs/node-image-generation", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "请先登录。" } });
    const parsed = nodeImageSubmissionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "节点生成请求无效。" } });
    try {
      const result = await options.service.submit(user, parsed.data);
      return reply.code(result.replayed ? 200 : 201).send(nodeImageSubmissionResponseSchema.parse(result));
    } catch (error) { return sendError(error, reply); }
  });
  app.get("/api/jobs/node-image-generation/:requestId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "请先登录。" } });
    const params = request.params as { requestId: string };
    const query = request.query as Record<string, unknown>;
    const parsed = nodeImageSubmissionLookupSchema.safeParse({ requestId: params.requestId, canvasId: query.canvas_id, elementId: query.element_id });
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", message: "任务查询参数无效。" } });
    try {
      return reply.send(nodeImageSubmissionLookupResponseSchema.parse(await options.service.get(user, parsed.data)));
    } catch (error) { return sendError(error, reply); }
  });
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof NodeImageSubmissionError || error instanceof CreditServiceError || error instanceof TierGuardError || error instanceof JobServiceError)
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  return reply.code(503).send({ error: { code: "node_submission_unavailable", message: "暂时无法确认任务状态，请查询原请求，勿重复生成。" } });
}
