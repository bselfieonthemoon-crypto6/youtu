/** Uses isolated QA accounts and a private workspace, never the current user's session. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { loadWorkspaceSkills } from "../src/agent/workspace-skills.js";
import { createSkillPackageService } from "../src/features/skills/skill-package-service.js";

const baseUrl = "http://127.0.0.1:54421";
if (process.env.SUPABASE_URL !== baseUrl) throw new Error("Local replica environment required");
const admin = createClient(baseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const userIds: string[] = [];
const clients: Array<typeof admin> = [];
let workspaceId: string | undefined;
let checks = 0;
function check(condition: unknown, label: string): asserts condition { assert.ok(condition, label); checks++; }
async function account() {
  const suffix = randomUUID();
  const email = "skills-loader-" + suffix + "@example.invalid";
  const password = randomUUID() + "!Qa9";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error); assert.ok(created.data.user);
  userIds.push(created.data.user.id);
  const client = createClient(baseUrl, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  clients.push(client);
  const login = await client.auth.signInWithPassword({ email, password });
  assert.ifError(login.error); assert.ok(login.data.session);
  return { client, userId: created.data.user.id };
}
async function main() {
  try {
    const owner = await account();
    const workspace = await admin.from("workspaces").select("id").eq("owner_user_id", owner.userId).eq("type", "personal").single();
    assert.ifError(workspace.error); assert.ok(workspace.data?.id); workspaceId = workspace.data.id as string;
    const project = await owner.client.from("projects").insert({ workspace_id: workspaceId, name: "Private Skills loader QA",
      slug: "skills-loader-" + randomUUID(), created_by: owner.userId }).select("id").single();
    assert.ifError(project.error); assert.ok(project.data?.id);
    const canvas = await owner.client.from("canvases").insert({ project_id: project.data.id, workspace_id: workspaceId,
      name: "Private Skills loader QA", content: {}, created_by: owner.userId }).select("id").single();
    assert.ifError(canvas.error); assert.ok(canvas.data?.id);
    const service = createSkillPackageService(owner.client as any);
    const active = await service.create(workspaceId, { name: "Private active skill", description: "Only read a bounded fixture.",
      category: "custom", skillContent: "# QA instructions\nPreserve scope and read the linked references.",
      files: [{ filePath: "references/中文 说明.md", content: "Original actual database reference." }] });
    const disabled = await service.create(workspaceId, { name: "Private disabled skill", description: "Must not be loaded.",
      category: "custom", skillContent: "# Disabled\nThis package should not appear in a run." });
    await service.install(workspaceId, disabled.id, false);
    const loaded = await loadWorkspaceSkills(owner.client as any, canvas.data.id as string);
    const entry = loaded.find(skill => skill.id === active.id);
    check(entry?.content === active.skillContent, "owner loader receives complete SKILL.md");
    check(entry.files[0]?.path === "references/中文 说明.md" && entry.files[0].content === "Original actual database reference.", "real Unicode reference read");
    check(!!entry.contentHash && entry.contentHash.length === 64, "versioned package content hash");
    check(!loaded.some(skill => skill.id === disabled.id), "disabled installation excluded from runtime loader");
    const oldHash = entry.contentHash;
    await service.update(active.id, { name: "Renamed private skill", files: [{ filePath: "references/中文 说明.md", content: "Edited reference." }] });
    const changed = (await loadWorkspaceSkills(owner.client as any, canvas.data.id as string)).find(skill => skill.id === active.id);
    check(changed?.name === active.slug && changed.contentHash !== oldHash && changed.files[0]?.content === "Edited reference.", "edited reference invalidates hash without changing stable path");
    const member = await account();
    const membership = await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: member.userId, role: "member" });
    assert.ifError(membership.error);
    const memberEntries = await loadWorkspaceSkills(member.client as any, canvas.data.id as string);
    check(memberEntries.some(skill => skill.id === active.id && skill.files[0]?.content === "Edited reference."), "member JWT can resolve nested private package and files through RLS");
    check(!memberEntries.some(skill => skill.id === disabled.id), "member JWT cannot load disabled package");
    await service.install(workspaceId, active.id, false);
    check(!(await loadWorkspaceSkills(member.client as any, canvas.data.id as string)).some(skill => skill.id === active.id), "new load removes just-disabled instructions");
    await service.install(workspaceId, disabled.id, true);
    check((await loadWorkspaceSkills(member.client as any, canvas.data.id as string)).some(skill => skill.id === disabled.id), "new load includes just-enabled package");
  } finally {
    const cleanupErrors: string[] = [];
    for (const client of clients) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    for (const id of userIds) {
      // Only the fresh isolated actor's exact rows. Deleting its workspaces
      // cascades its private QA projects/canvases; no user artwork is in scope.
      const skills = await admin.from("skills").delete().eq("created_by", id);
      if (skills.error) cleanupErrors.push("skills cleanup: " + skills.error.code);
      const workspaces = await admin.from("workspaces").delete().eq("owner_user_id", id);
      if (workspaces.error) cleanupErrors.push("workspace cleanup: " + workspaces.error.code);
      const user = await admin.auth.admin.deleteUser(id);
      if (user.error) cleanupErrors.push("QA account cleanup failed");
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
  }
  console.log(JSON.stringify({ status: "passed", checks, source: "real local Supabase JWT/RLS and runtime loader", cleanup: "isolated QA accounts, skills, projects and canvases deleted" }));
}
await main().catch(error => { console.error(error instanceof Error ? error.message : "Local Skills loader QA failed"); process.exitCode = 1; });
