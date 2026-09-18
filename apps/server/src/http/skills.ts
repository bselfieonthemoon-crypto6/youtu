import type { FastifyInstance, FastifyReply } from "fastify";
import {
  applicationErrorResponseSchema, skillCreateRequestSchema, skillDetailResponseSchema,
  skillImportRequestSchema, skillListResponseSchema, skillUpdateRequestSchema,
  unauthenticatedErrorResponseSchema, workspaceSkillListResponseSchema,
  workspaceSkillToggleRequestSchema, workspaceSkillInstallRequestSchema, type SkillReadiness, isUuid,
} from "@loomic/shared";
import { importSkillFromUrl, SkillImportError } from "../features/skills/skill-import-service.js";
import {
  createSkillPackageService, SkillPackageError, mapSkillRow, mapSkillFileRow, mapSkillDetailRow,
} from "../features/skills/skill-package-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { RequestAuthenticator, UserSupabaseClient, AuthenticatedUser } from "../supabase/user.js";

export type SkillRouteOptions = {
  auth: RequestAuthenticator;
  createUserClient: (accessToken: string) => UserSupabaseClient;
  viewerService: ViewerService;
  getSkillReadiness?: (user: AuthenticatedUser, rows: Array<{ metadata?: unknown; skill_content?: unknown }>) => Promise<SkillReadiness[]>;
};
const untypedFrom = (client: UserSupabaseClient, table: string) => (client as any).from(table);
export function requireSkillId(value: string): string {
  if (!isUuid(value)) throw new SkillPackageError("skill_invalid_request", "Invalid skill ID.", 400);
  return value;
}
export function sendSkillRouteError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "ZodError" && "issues" in error) {
    return reply.code(400).send({ issues: error.issues, message: "Invalid skill request" });
  }
  if (error instanceof SkillPackageError || error instanceof SkillImportError) {
    return reply.code(error instanceof SkillPackageError ? error.statusCode : 400).send(
      applicationErrorResponseSchema.parse({ error: { code: error instanceof SkillImportError ? "skill_import_failed" : error.code, message: error.message } }));
  }
  return reply.code(500).send(applicationErrorResponseSchema.parse({ error: { code: fallback, message: "Unable to complete the skill operation." } }));
}
function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(unauthenticatedErrorResponseSchema.parse({ error: { code: "unauthorized", message: "Authentication required." } }));
}
export async function withSkillReadiness<T extends { metadata?: unknown; skillContent?: string }>(
  options: SkillRouteOptions, user: AuthenticatedUser, skills: T[], rows?: Array<{ metadata?: unknown; skill_content?: unknown }>,
): Promise<Array<T & { readiness?: SkillReadiness }>> {
  if (!options.getSkillReadiness) return skills;
  // Capability inspection must not turn an already committed save into a false failure.
  let readiness: SkillReadiness[];
  try {
    readiness = await options.getSkillReadiness(user, rows ?? skills.map(skill => ({ metadata: skill.metadata, skill_content: skill.skillContent })));
  } catch {
    readiness = skills.map(() => ({ status: "unavailable", reasons: ["Capability readiness could not be checked."], models: [] }));
  }
  return skills.map((skill, index) => ({ ...skill, ...(readiness[index] ? { readiness: readiness[index] } : {}) }));
}

export async function registerSkillRoutes(app: FastifyInstance, options: SkillRouteOptions) {
  // Includes JSON escaping overhead above the 8 MiB decoded package limit.
  const packageBodyOptions = { bodyLimit: 16 * 1024 * 1024 };
  app.get("/api/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const { data, error } = await untypedFrom(options.createUserClient(user.accessToken), "skills")
        .select("*").order("is_featured", { ascending: false }).order("name", { ascending: true });
      if (error) throw error;
      return reply.send(skillListResponseSchema.parse({ skills: await withSkillReadiness(options, user, (data ?? []).map(mapSkillRow), data ?? []) }));
    } catch (error) { request.log.error({ err: error }, "skills list failed"); return sendSkillRouteError(reply, error, "skill_query_failed"); }
  });

  for (const filesOnly of [false, true]) app.get("/api/skills/:id" + (filesOnly ? "/files" : ""), async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const id = requireSkillId((request.params as { id: string }).id);
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await untypedFrom(client, "skills").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) throw new SkillPackageError("skill_not_found", "Skill not found.", 404);
      const { data: files, error: fileError } = await untypedFrom(client, "skill_files").select("*").eq("skill_id", id).order("file_path");
      if (fileError) throw fileError;
      if (filesOnly) return reply.send({ files: (files ?? []).map(mapSkillFileRow) });
      const [skill] = await withSkillReadiness(options, user, [mapSkillDetailRow(data, files ?? [])], [data]);
      return reply.send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) { request.log.error({ err: error }, "skill detail failed"); return sendSkillRouteError(reply, error, "skill_query_failed"); }
  });

  app.post("/api/skills", packageBodyOptions, async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const payload = skillCreateRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const saved = await createSkillPackageService(options.createUserClient(user.accessToken)).create(viewer.workspace.id, payload);
      const [skill] = await withSkillReadiness(options, user, [saved]);
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) { request.log.error({ err: error }, "skill creation failed"); return sendSkillRouteError(reply, error, "skill_create_failed"); }
  });
  app.post("/api/skills/import", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const { url } = skillImportRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const imported = await importSkillFromUrl(url);
      const saved = await createSkillPackageService(options.createUserClient(user.accessToken)).import(viewer.workspace.id, imported);
      const [skill] = await withSkillReadiness(options, user, [saved]);
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) { request.log.error({ err: error }, "skill import failed"); return sendSkillRouteError(reply, error, "skill_import_failed"); }
  });
  app.put("/api/skills/:id", packageBodyOptions, async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const id = requireSkillId((request.params as { id: string }).id);
      const payload = skillUpdateRequestSchema.parse(request.body);
      const saved = await createSkillPackageService(options.createUserClient(user.accessToken)).update(id, payload);
      const [skill] = await withSkillReadiness(options, user, [saved]);
      return reply.send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) { request.log.error({ err: error }, "skill update failed"); return sendSkillRouteError(reply, error, "skill_update_failed"); }
  });
  app.delete("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const id = requireSkillId((request.params as { id: string }).id);
      const { error, count } = await untypedFrom(options.createUserClient(user.accessToken), "skills")
        .delete({ count: "exact" }).eq("id", id).eq("created_by", user.id);
      if (error) throw error;
      if (!count) throw new SkillPackageError("skill_not_found", "Skill not found or not editable by this user.", 404);
      return reply.code(204).send();
    } catch (error) { return sendSkillRouteError(reply, error, "skill_delete_failed"); }
  });

  app.get("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const viewer = await options.viewerService.ensureViewer(user);
      const { data, error } = await untypedFrom(options.createUserClient(user.accessToken), "workspace_skills")
        .select("skill_id, enabled, installed_at, skills(*)").eq("workspace_id", viewer.workspace.id).order("installed_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []).filter((row: any) => row.skills !== null);
      const skills = rows.map((row: any) => ({ ...mapSkillRow(row.skills), installed: true, enabled: row.enabled, installedAt: row.installed_at }));
      return reply.send(workspaceSkillListResponseSchema.parse({ skills: await withSkillReadiness(options, user, skills, rows.map((row: any) => row.skills)) }));
    } catch (error) { return sendSkillRouteError(reply, error, "skill_query_failed"); }
  });
  app.post("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const { skillId } = workspaceSkillInstallRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      await createSkillPackageService(options.createUserClient(user.accessToken)).install(viewer.workspace.id, skillId);
      return reply.code(204).send();
    } catch (error) { return sendSkillRouteError(reply, error, "skill_install_failed"); }
  });
  app.patch("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const skillId = requireSkillId((request.params as { skillId: string }).skillId);
      const { enabled } = workspaceSkillToggleRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      await createSkillPackageService(options.createUserClient(user.accessToken)).install(viewer.workspace.id, skillId, enabled);
      return reply.code(204).send();
    } catch (error) { return sendSkillRouteError(reply, error, "skill_toggle_failed"); }
  });
  app.delete("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request); if (!user) return sendUnauthenticated(reply);
      const skillId = requireSkillId((request.params as { skillId: string }).skillId);
      const viewer = await options.viewerService.ensureViewer(user);
      const { error, count } = await untypedFrom(options.createUserClient(user.accessToken), "workspace_skills")
        .delete({ count: "exact" }).eq("workspace_id", viewer.workspace.id).eq("skill_id", skillId);
      if (error) throw error;
      if (!count) throw new SkillPackageError("skill_not_found", "Skill is not installed in this workspace, or you cannot manage it.", 404);
      return reply.code(204).send();
    } catch (error) { return sendSkillRouteError(reply, error, "skill_uninstall_failed"); }
  });
}
