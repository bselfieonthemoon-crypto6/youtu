"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import type { PublishedSkillPreview, PublishedSkillPreviewGroup, SkillCategory, SkillDetail, SkillListItem } from "@loomic/shared";
import { SkillCard } from "@/components/skills/skill-card";
import { CreateSkillDialog, type SkillFormData } from "@/components/skills/create-skill-dialog";
import { ImportPanel } from "@/components/skills/import-panel";
import { MarketplacePanel } from "@/components/skills/marketplace-panel";
import { SkillDetailDialog } from "@/components/skills/skill-detail-dialog";
import { SkillsSkeleton } from "@/components/skeletons/skills-skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { createSkill, deleteSkill, fetchPublishedSkillPreviewGroups, fetchSkillDetail, installSkill, toggleSkill, uninstallSkill, updateSkill } from "@/lib/server-api";
import { mergeSkillInstallation, notifySkillsChanged, readSkills, SKILL_CATEGORY_LABELS, skillErrorMessage } from "@/lib/skills-client";
import { cn } from "@/lib/utils";

type Tab = "installed" | "catalog" | "marketplace" | "import";
const TABS: Record<Tab, string> = { installed: "已安装", catalog: "技能目录", marketplace: "社区市场", import: "导入" };

export default function SkillsPage() {
  const { session, user, loading: authLoading } = useAuth();
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;
  const getToken = useCallback(() => tokenRef.current, []);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const locks = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const [tab, setTab] = useState<Tab>("installed");
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory | "">("");
  const [officialOnly, setOfficialOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDetail | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [previewGroups, setPreviewGroups] = useState<Record<string, PublishedSkillPreviewGroup>>({});
  const selectedSkill = useRef<SkillListItem | null>(null);

  const load = useCallback(async () => {
    const token = getToken();
    const sequence = ++listSequence.current;
    if (!token) { setSkills([]); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [catalog, workspace] = await Promise.all([readSkills(token, "catalog"), readSkills(token, "workspace")]);
      if (sequence !== listSequence.current || token !== getToken()) return;
      const merged = mergeSkillInstallation(catalog.skills, workspace.skills);
      setSkills(merged);
      setDetail((current) => {
        const updated = current && merged.find((skill) => skill.id === current.id);
        return current && updated ? { ...current, ...updated } : current;
      });
    } catch (cause) {
      if (sequence === listSequence.current && token === getToken()) setError(skillErrorMessage(cause, "技能列表加载失败，已保留上次结果，请重试。"));
    } finally {
      if (sequence === listSequence.current && token === getToken()) setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    setSkills([]); setDetail(null); setDetailOpen(false); setFormOpen(false);
    setEditingSkill(null); setNotice(null); setTab("installed");
    detailSequence.current += 1;
  }, [user?.id]);

  useEffect(() => {
    void load();
    return () => { listSequence.current += 1; detailSequence.current += 1; };
  }, [session?.access_token, load]);

  const refresh = useCallback(async () => { notifySkillsChanged(); await load(); }, [load]);

  const showDetail = useCallback(async (skill: SkillListItem) => {
    const token = getToken();
    if (!token) return;
    const sequence = ++detailSequence.current;
    selectedSkill.current = skill;
    setDetail(null); setDetailError(null); setDetailOpen(true); setDetailLoading(true);
    try {
      const response = await fetchSkillDetail(token, skill.id);
      if (sequence === detailSequence.current && token === getToken()) {
        setDetail({ ...response.skill, installed: skill.installed === true, enabled: skill.enabled === true });
      }
    } catch (cause) {
      if (sequence === detailSequence.current && token === getToken()) setDetailError(skillErrorMessage(cause, "技能详情加载失败，请重试。"));
    } finally {
      if (sequence === detailSequence.current && token === getToken()) setDetailLoading(false);
    }
  }, [getToken]);

  const mutate = useCallback(async (id: string, action: (token: string) => Promise<unknown>, message: string) => {
    if (locks.current.has(id)) return;
    const token = getToken();
    if (!token) throw new Error("请登录后重试。");
    locks.current.add(id); setBusyIds(new Set(locks.current)); setError(null); setNotice(null);
    listSequence.current += 1;
    try {
      await action(token);
      if (token !== getToken()) return;
      setNotice(message);
      await refresh();
    } finally { locks.current.delete(id); setBusyIds(new Set(locks.current)); }
  }, [getToken, refresh]);

  const install = (id: string) => mutate(id, (token) => installSkill(token, id), "技能已安装；实际可用能力以状态检查为准。");
  const uninstall = async (id: string) => {
    await mutate(id, (token) => uninstallSkill(token, id), "技能已卸载。");
  };
  const remove = async (id: string) => {
    await mutate(id, (token) => deleteSkill(token, id), "自定义技能已删除。");
    setDetailOpen(false); setDetail(null); detailSequence.current += 1;
  };
  const toggle = (id: string, enabled: boolean) => {
    void mutate(id, (token) => toggleSkill(token, id, enabled), enabled ? "技能已启用。" : "技能已停用。")
      .catch((cause) => setError(skillErrorMessage(cause, "切换失败，原状态未更改，请重试。")));
  };
  const save = async (data: SkillFormData) => {
    const token = getToken();
    if (!token) throw new Error("请登录后重试。");
    const response = editingSkill ? await updateSkill(token, editingSkill.id, data) : await createSkill(token, data);
    if (token !== getToken()) return;
    setNotice(editingSkill ? "技能修改已保存。" : "自定义技能已创建并安装。");
    setDetailOpen(false); setDetail(null); detailSequence.current += 1;
    setTab("installed");
    await refresh();
    // The API owns installation status; no local enabled defaults are invented.
    selectedSkill.current = response.skill;
  };

  const filtered = useMemo(() => skills.filter((skill) => (
    (tab !== "installed" || skill.installed === true)
    && (!category || skill.category === category)
    && (!officialOnly || skill.source === "system")
    && `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())
  )), [skills, tab, category, officialOnly, query]);

  // Published cover/example images for the visible cards, in ONE bounded request
  // per list change. The key keeps the effect from re-running on every render and
  // silently caps the batch at the server's limit of 50 slugs.
  const previewSlugs = useMemo(
    () => [...new Set(filtered.map((skill) => skill.slug).filter(Boolean))].sort().slice(0, 50),
    [filtered],
  );
  const previewKey = previewSlugs.join(",");
  useEffect(() => {
    const token = getToken();
    if (!token || !previewKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchPublishedSkillPreviewGroups(token, previewKey.split(","));
        if (cancelled || token !== getToken()) return;
        const next: Record<string, PublishedSkillPreviewGroup> = {};
        for (const group of response.groups) next[group.slug] = group;
        setPreviewGroups(next);
      } catch {
        // Images are decoration: a failed read must never break the skill list.
        if (!cancelled) setPreviewGroups({});
      }
    })();
    return () => { cancelled = true; };
  }, [getToken, previewKey, session?.access_token]);

  if (authLoading || (loading && !skills.length && !error)) return <SkillsSkeleton />;
  if (!session) return <p role="alert" className="p-8">请登录后管理技能。</p>;

  return (
    <main className="px-4 py-6 sm:px-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold">技能</h1><p className="mt-1 text-sm text-muted-foreground">在这里管理可复用的任务说明和参考文件。</p></div>
        <Button size="sm" onClick={() => { setEditingSkill(null); setFormOpen(true); }}><Plus className="size-4" />添加自定义技能</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">“配置就绪”只表示当前配置匹配，不保证设计质量；附属脚本需按其说明手动运行。</p>
      <div role="tablist" aria-label="技能来源" className="my-5 flex gap-1 overflow-x-auto border-b border-border">
        {Object.entries(TABS).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value as Tab)} className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === value ? "border-foreground" : "border-transparent text-muted-foreground")}>{label}</button>)}
      </div>
      {error && <div role="alert" className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}<Button variant="outline" size="xs" disabled={loading} onClick={() => { void refresh(); }}>重试</Button></div>}
      {notice && <p role="status" className="mb-4 text-sm text-muted-foreground">{notice}</p>}
      {(tab === "installed" || tab === "catalog") && <>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-48"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><input aria-label="搜索技能" placeholder="搜索技能…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full rounded-lg border border-input bg-transparent pl-8 pr-3 text-sm" /></div>
          <select aria-label="技能分类" value={category} onChange={(event) => setCategory(event.target.value as SkillCategory | "")} className="h-9 rounded-lg border border-input bg-background px-2 text-sm"><option value="">全部分类</option>{Object.entries(SKILL_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <Button size="sm" variant={officialOnly ? "default" : "outline"} aria-pressed={officialOnly} onClick={() => setOfficialOnly(!officialOnly)}>仅官方</Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => { void refresh(); }}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />刷新</Button>
        </div>
        {tab === "catalog" && <p className="mb-4 text-xs text-muted-foreground">目录包含可安装的官方、社区和自定义技能。</p>}
        {!filtered.length ? <div className="py-16 text-center text-sm text-muted-foreground">{query || category || officialOnly ? "未找到匹配的技能" : tab === "installed" ? "尚未安装技能，可前往技能目录选择或创建自定义技能。" : "暂无可用技能"}</div>
          : <div aria-busy={loading} className="grid gap-4 lg:grid-cols-2">{filtered.map((skill) => {
            const group = previewGroups[skill.slug];
            return <SkillCard key={skill.id} skill={skill} busy={busyIds.has(skill.id)} coverUrl={group?.cover?.imageUrl ?? null} exampleCount={group?.examples.length ?? 0} onToggle={toggle} onClick={(item) => { void showDetail(item); }} onInstall={(id) => { void install(id).catch((cause) => setError(skillErrorMessage(cause, "安装失败，请重试。"))); }} />;
          })}</div>}
      </>}
      {tab === "marketplace" && <MarketplacePanel accessToken={getToken} onInstalled={refresh} />}
      {tab === "import" && <ImportPanel accessToken={getToken} onImported={refresh} onSwitchToInstalled={() => setTab("installed")} />}
      <CreateSkillDialog open={formOpen} onOpenChange={setFormOpen} onSubmit={save} skill={editingSkill} />
      <SkillDetailDialog skill={detail} open={detailOpen} loading={detailLoading} error={detailError} busy={detail ? busyIds.has(detail.id) : false}
        cover={detail ? previewGroups[detail.slug]?.cover ?? null : null}
        examples={detail ? previewGroups[detail.slug]?.examples ?? [] : []}
        onRetry={() => { if (selectedSkill.current) void showDetail(selectedSkill.current); }}
        onOpenChange={(open) => { setDetailOpen(open); if (!open) { detailSequence.current += 1; setDetail(null); } }}
        onInstall={install} onUninstall={uninstall} onDelete={remove}
        onEdit={detail?.source === "user" && detail.createdBy === user?.id ? () => { setEditingSkill(detail); setDetailOpen(false); setFormOpen(true); } : undefined}
        canDelete={detail?.source === "user" && detail.createdBy === user?.id} />
    </main>
  );
}
