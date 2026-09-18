import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PromptLibraryService } from "../features/prompt-library/prompt-library-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const integerParameter = (fallback: number, min: number, max: number) => z.string()
  .regex(/^\d{1,7}$/)
  .transform(Number)
  .pipe(z.number().int().min(min).max(max))
  .optional()
  .transform(value => value ?? fallback);

const querySchema = z.object({
  q: z.string().max(160).optional().transform(value => value?.trim() ?? ""),
  source: z.string().max(80).optional().transform(value => value?.trim() ?? ""),
  category: z.string().max(80).optional().transform(value => value?.trim() ?? ""),
  offset: integerParameter(0, 0, 1000000),
  limit: integerParameter(24, 1, 48),
}).strict();

export async function registerPromptLibraryRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; promptLibraryService: PromptLibraryService },
) {
  app.get("/api/prompt-library", async (request, reply) => {
    // Authenticate before parsing or loading the public catalog. This route
    // never creates a workspace, runs models, or accesses private user data.
    try {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
      }
    } catch {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
    }
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "提示词查询参数无效，请检查关键词和分页范围。" } });
    }
    try {
      const result = await options.promptLibraryService.search(parsed.data);
      return reply.header("Cache-Control", "private, no-store").code(200).send(result);
    } catch {
      // Do not expose local filenames, malformed source content, stack traces,
      // or authentication/provider information in error responses.
      return reply.code(503).send({ error: { code: "prompt_library_unavailable", message: "提示词库暂时不可用，请稍后重试。" } });
    }
  });
}
