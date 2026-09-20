"use client";

import type { AdminSkillCatalogEntry, AdminSkillPreview } from "@loomic/shared";
import { useCallback, useEffect, useState } from "react";

import {
  deleteAdminSkillPreview,
  fetchAdminSkillCatalog,
  fetchAdminSkillPreviews,
  publishAdminSkillPreview,
  reorderAdminSkillPreviews,
  uploadAdminSkillPreview,
} from "../../lib/server-api";

/**
 * Platform skill catalog with its images.
 *
 * Skills only carried a lucide icon before this; the panel is how a platform admin
 * gives a skill a cover and example images. Every write (upload, publish,
 * unpublish, reorder, delete) needs a reason and an inline confirmation, and the
 * image itself stays a draft until it is published — drafts are visible here only.
 */

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

const ROLE_LABELS: Record<string, string> = { cover: "封面", example: "示例" };
const STATUS_LABELS: Record<string, string> = { draft: "草稿", published: "已发布" };
const CATEGORY_LABELS: Record<string, string> = {
  design: "设计", generation: "生成", code: "代码", data: "数据", writing: "文案", custom: "自定义",
};

export const previewRoleLabel = (role: string) => ROLE_LABELS[role] ?? role;
export const previewStatusLabel = (status: string) => STATUS_LABELS[status] ?? status;
export const skillCategoryLabel = (category: string) => CATEGORY_LABELS[category] ?? category;

export function validatePreviewFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return `只支持 ${ACCEPTED_TYPES.join(" / ")}。`;
  if (file.size === 0 || file.size > MAX_BYTES) return "图片大小必须在 1 字节到 5MB 之间。";
  return null;
}

type PendingAction = { previewId: string; kind: "publish" | "unpublish" | "delete" | "move"; direction?: "up" | "down" };

export function AdminSkillsSection({ accessToken }: { accessToken: string }) {
  const [skills, setSkills] = useState<AdminSkillCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<AdminSkillPreview[]>([]);
  const [previewsLoading, setPreviewsLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [role, setRole] = useState<"cover" | "example">("cover");
  const [caption, setCaption] = useState("");
  const [uploadReason, setUploadReason] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingReason, setPendingReason] = useState("");

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminSkillCatalog(accessToken, {
        ...(submittedQuery ? { query: submittedQuery } : {}), limit: 200,
      });
      setSkills(result.skills);
      setSelectedId(current => (current && result.skills.some(skill => skill.id === current)
        ? current
        : result.skills[0]?.id ?? null));
    } catch (caught) {
      setSkills([]);
      setError(caught instanceof Error ? caught.message : "技能目录加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, submittedQuery]);

  useEffect(() => void load(), [load]);

  const loadPreviews = useCallback(async (skillId: string) => {
    setPreviewsLoading(true);
    try {
      setPreviews((await fetchAdminSkillPreviews(accessToken, skillId)).previews);
    } catch (caught) {
      setPreviews([]);
      setFeedback(caught instanceof Error ? caught.message : "技能图片加载失败，请稍后重试。");
    } finally {
      setPreviewsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!selectedId) {
      setPreviews([]);
      return;
    }
    void loadPreviews(selectedId);
  }, [selectedId, loadPreviews]);

  const selected = skills.find(skill => skill.id === selectedId) ?? null;

  function refreshCounts(skillId: string, next: AdminSkillPreview[]) {
    setPreviews(next);
    setSkills(current => current.map(skill => skill.id === skillId ? {
      ...skill,
      previewCount: next.length,
      publishedPreviewCount: next.filter(preview => preview.status === "published").length,
      hasPublishedCover: next.some(preview => preview.role === "cover" && preview.status === "published"),
    } : skill));
  }

  async function handleUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !file) return;
    setFeedback(null);
    setBusy(true);
    try {
      await uploadAdminSkillPreview(accessToken, selected.id, { file, role, caption, reason: uploadReason });
      setFeedback(`已上传${previewRoleLabel(role)}（草稿状态，确认无误后再发布），操作已记入审计。`);
      setFile(null);
      setCaption("");
      setUploadReason("");
      setFileError(null);
      await loadPreviews(selected.id);
      await load();
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "上传失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function runPending() {
    if (!selected || !pending) return;
    setFeedback(null);
    setBusy(true);
    try {
      if (pending.kind === "publish" || pending.kind === "unpublish") {
        await publishAdminSkillPreview(accessToken, selected.id, pending.previewId, pendingReason, pending.kind);
        setFeedback(pending.kind === "publish" ? "已发布，已登录用户现在可以看到这张图。" : "已下架为草稿。");
      } else if (pending.kind === "delete") {
        await deleteAdminSkillPreview(accessToken, selected.id, pending.previewId, pendingReason);
        setFeedback("已删除该图片记录（存储对象交给既有回收流程处理）。");
      } else {
        const current = previews.filter(preview => preview.role === previews.find(item => item.id === pending.previewId)?.role);
        const index = current.findIndex(item => item.id === pending.previewId);
        const swapWith = pending.direction === "up" ? index - 1 : index + 1;
        if (index < 0 || swapWith < 0 || swapWith >= current.length) return;
        const reordered = [...current];
        [reordered[index], reordered[swapWith]] = [reordered[swapWith]!, reordered[index]!];
        // The endpoint requires every preview of the skill, so merge the moved
        // role-group order back with the untouched group.
        const others = previews.filter(preview => preview.role !== current[0]!.role);
        const ordered = [...reordered, ...others].map(preview => preview.id);
        await reorderAdminSkillPreviews(accessToken, selected.id, ordered, pendingReason);
        setFeedback("顺序已保存，操作已记入审计。");
      }
      setPending(null);
      setPendingReason("");
      await loadPreviews(selected.id);
      await load();
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">正在加载技能目录…</p>;
  if (error) {
    return (
      <div>
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void load()}
          className="mt-4 inline-flex rounded-md border border-border px-3 py-1.5 text-sm">重试</button>
      </div>
    );
  }

  const rolePreviews = (group: "cover" | "example") => previews.filter(preview => preview.role === group);

  return (
    <div className="space-y-5" data-testid="admin-skills">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">技能与图片</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              技能包只有图标时看不出效果，这里给每个技能配封面与示例图。图片存放在平台级素材桶，
              草稿只有后台可见，发布后所有登录用户可见；上传/发布/下架/排序/删除都需要填写原因并写入审计。
            </p>
          </div>
          <form className="flex items-end gap-2"
            onSubmit={event => { event.preventDefault(); setSubmittedQuery(query.trim()); }}>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              搜索技能
              <input value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索技能"
                placeholder="slug / 名称"
                className="w-52 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
          </form>
        </div>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-skills-feedback">{feedback}</p> : null}
      </section>

      <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-medium">技能包（{skills.length}）</h3>
          <ul className="mt-3 max-h-[32rem] space-y-1 overflow-y-auto" data-testid="admin-skill-list">
            {skills.length === 0 ? (
              <li className="px-2 py-4 text-sm text-muted-foreground">没有匹配的技能。</li>
            ) : skills.map(skill => (
              <li key={skill.id}>
                <button type="button" onClick={() => { setSelectedId(skill.id); setPending(null); setFeedback(null); }}
                  className={`w-full rounded-md px-2 py-2 text-left text-sm ${skill.id === selectedId ? "bg-muted" : "hover:bg-muted/60"}`}>
                  <div className="font-medium">{skill.displayName ?? skill.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {skill.slug} · v{skill.version} · {skillCategoryLabel(skill.category)}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {skill.enabledWorkspaces} 个工作区启用 · 图片 {skill.previewCount}
                    {skill.hasPublishedCover ? " · 已有封面" : " · 无封面"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-5">
          {selected ? (
            <>
              <div className="rounded-lg border border-border bg-card p-5" data-testid="admin-skill-detail">
                <h3 className="text-sm font-medium">{selected.displayName ?? selected.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  输出类型 {selected.outputKinds.join("、") || "（未声明）"}；安装 {selected.installCount} 次，
                  其中启用 {selected.enabledWorkspaces} 次。
                </p>

                <form onSubmit={handleUpload} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    图片文件
                    <input type="file" accept={ACCEPTED_TYPES.join(",")} aria-label="选择技能图片"
                      onChange={event => {
                        const picked = event.target.files?.[0] ?? null;
                        setFile(picked);
                        setFileError(picked ? validatePreviewFile(picked) : null);
                      }}
                      className="w-64 text-xs" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    用途
                    <select value={role} onChange={event => setRole(event.target.value as "cover" | "example")}
                      aria-label="图片用途"
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                      <option value="cover">封面</option>
                      <option value="example">示例</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    说明（可选）
                    <input value={caption} onChange={event => setCaption(event.target.value)} aria-label="图片说明"
                      placeholder="例如：1:1 主视觉"
                      className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    上传原因
                    <input value={uploadReason} onChange={event => setUploadReason(event.target.value)} required minLength={2}
                      aria-label="上传原因" placeholder="例如：补充示例图"
                      className="w-44 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  <button type="submit" disabled={busy || !file || !!fileError || uploadReason.trim().length < 2}
                    className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50">
                    上传为草稿
                  </button>
                </form>
                {fileError ? <p className="mt-2 text-xs text-destructive">{fileError}</p> : null}
              </div>

              {previewsLoading ? (
                <p className="text-sm text-muted-foreground">正在加载技能图片…</p>
              ) : (
                (["cover", "example"] as const).map(group => (
                  <div key={group} className="rounded-lg border border-border bg-card p-5"
                    data-testid={`admin-skill-previews-${group}`}>
                    <h3 className="text-sm font-medium">{previewRoleLabel(group)}（{rolePreviews(group).length}）</h3>
                    {rolePreviews(group).length === 0 ? (
                      <p className="mt-3 text-sm text-muted-foreground">
                        {group === "cover" ? "还没有封面图，发布一张后技能卡才会显示图片。" : "还没有示例图。"}
                      </p>
                    ) : (
                      <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {rolePreviews(group).map((preview, index) => (
                          <li key={preview.id} className="rounded-md border border-border p-2">
                            <div className="flex h-32 items-center justify-center overflow-hidden rounded bg-muted/40">
                              {preview.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={preview.imageUrl} alt={preview.caption ?? "技能图片"} className="max-h-32 object-contain" />
                              ) : <span className="text-xs text-muted-foreground">图片链接过期，刷新后重试</span>}
                            </div>
                            <div className="mt-2 text-xs">
                              <div>{previewStatusLabel(preview.status)}
                                {preview.caption ? ` · ${preview.caption}` : ""}
                              </div>
                              <div className="text-muted-foreground">{preview.mimeType ?? "未知类型"}</div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {pending?.previewId === preview.id ? (
                                <div className="w-full space-y-1">
                                  <input value={pendingReason} onChange={event => setPendingReason(event.target.value)}
                                    aria-label={`${previewStatusLabel(preview.status)}操作原因`}
                                    placeholder="原因（至少 2 个字符）"
                                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs" />
                                  <div className="flex gap-1">
                                    <button type="button" disabled={busy || pendingReason.trim().length < 2}
                                      onClick={() => void runPending()}
                                      className="rounded-md bg-foreground px-2 py-1 text-[11px] text-background disabled:opacity-50">
                                      确认{previewStatusLabel(preview.status)}
                                    </button>
                                    <button type="button" onClick={() => { setPending(null); setPendingReason(""); }}
                                      className="rounded-md border border-border px-2 py-1 text-[11px]">取消</button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button type="button"
                                    onClick={() => { setPending({ previewId: preview.id, kind: preview.status === "published" ? "unpublish" : "publish" }); setPendingReason(""); setFeedback(null); }}
                                    className="rounded-md border border-border px-2 py-1 text-[11px]">
                                    {preview.status === "published" ? "下架" : "发布"}
                                  </button>
                                  <button type="button" disabled={index === 0}
                                    onClick={() => { setPending({ previewId: preview.id, kind: "move", direction: "up" }); setPendingReason(""); setFeedback(null); }}
                                    className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-40">上移</button>
                                  <button type="button" disabled={index === rolePreviews(group).length - 1}
                                    onClick={() => { setPending({ previewId: preview.id, kind: "move", direction: "down" }); setPendingReason(""); setFeedback(null); }}
                                    className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-40">下移</button>
                                  <button type="button"
                                    onClick={() => { setPending({ previewId: preview.id, kind: "delete" }); setPendingReason(""); setFeedback(null); }}
                                    className="rounded-md border border-border px-2 py-1 text-[11px] text-destructive">删除</button>
                                </>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">选择左侧技能后管理它的图片。</p>
          )}
        </section>
      </div>
    </div>
  );
}
