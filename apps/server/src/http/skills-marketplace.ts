import type { FastifyInstance } from "fastify";
import { marketplaceInstallRequestSchema, skillDetailResponseSchema } from "@loomic/shared";
import { searchMarketplace, getMarketplaceDetail, installFromMarketplace, MarketplaceError } from "../features/skills/marketplace-service.js";
import { createSkillPackageService, SkillPackageError } from "../features/skills/skill-package-service.js";
import { sendSkillRouteError, withSkillReadiness, type SkillRouteOptions } from "./skills.js";

export async function registerMarketplaceRoutes(app: FastifyInstance, options: SkillRouteOptions) {
  const fail = (reply: Parameters<typeof sendSkillRouteError>[0], error: unknown) => sendSkillRouteError(reply,
    error instanceof MarketplaceError ? new SkillPackageError(
      error.code === "package_not_found" ? "marketplace_detail_failed" : error.code === "search_failed" ? "marketplace_search_failed" : "marketplace_install_failed",
      error.message, error.code === "package_not_found" ? 404 : 502) : error,
    "marketplace_failed");
  app.get("/api/skills/marketplace/search", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required." } });
      const query = request.query as Record<string, unknown>;
      const q = query.q ?? ""; const page = Number(query.page ?? 1); const limit = Number(query.limit ?? 20);
      if (typeof q !== "string" || q.length > 200 || !Number.isInteger(page) || page < 1 || page > 100
        || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new SkillPackageError("marketplace_invalid_request", "Expected q up to 200 characters, page 1–100 and limit 1–50.", 400);
      return reply.send(await searchMarketplace(q, page, limit));
    } catch (error) { request.log.error({ err: error }, "marketplace search failed"); return fail(reply, error); }
  });
  app.get("/api/skills/marketplace/detail", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required." } });
      const { packageName } = marketplaceInstallRequestSchema.parse({ packageName: (request.query as Record<string, unknown>).name });
      return reply.send(await getMarketplaceDetail(packageName));
    } catch (error) { return fail(reply, error); }
  });
  app.post("/api/skills/marketplace/install", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required." } });
      const { packageName } = marketplaceInstallRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const { imported, packageName: resolvedName } = await installFromMarketplace(packageName);
      const saved = await createSkillPackageService(options.createUserClient(user.accessToken)).import(viewer.workspace.id, imported, resolvedName);
      const [skill] = await withSkillReadiness(options, user, [saved]);
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) { request.log.error({ err: error }, "marketplace install failed"); return fail(reply, error); }
  });
}
