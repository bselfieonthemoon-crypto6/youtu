"use client";

import type {
  AdminHomeContentOverviewResponse,
  AdminHomeDiscoveryCase,
  AdminHomeExample,
  AdminHomeInputMention,
  HomeInputMentionWrite,
} from "@loomic/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteAdminHomeContent,
  fetchAdminHomeContentItems,
  fetchAdminHomeContentOverview,
  reorderAdminHomeCategories,
  reorderAdminHomeContent,
  setAdminHomeContentActive,
  upsertAdminHomeCategory,
  upsertAdminHomeDiscoveryCase,
  upsertAdminHomeExample,
} from "../../lib/server-api";
import { formatJobTimestamp } from "./admin-jobs-section";

/**
 * Home content management: the discovery library and the examples library.
 *
 * Both libraries are read by the browser under RLS, which grants SELECT on active
 * rows only, so "上架/下架" is a real publish switch - and a case also disappears
 * when its own category is unpublished. The console says that out loud instead of
 * letting an operator wonder why a published entry is missing from the home page.
 *
 * Two constraints from the schema shape the interaction:
 *   * the tables carry a unique index on (category_key, sort_order), so a row's
 *     position is never typed in: new rows append and 上移/下移 send a full,
 *     re-ordered list for the selected category. That is also why the buttons are
 *     disabled while a filter hides part of the category - an incomplete list is
 *     refused by the server.
 *   * categories cannot be deleted (their foreign keys cascade into the whole
 *     library), so the console only offers unpublish.
 */

const KIND_LABELS: Record<string, string> = {
  discovery_case: "发现案例",
  example_example: "示例",
  discovery_category: "发现分类",
  example_category: "示例分类",
};

export const homeContentKindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/**
 * Input mentions are edited one per line as `名称 | tool|image | 图片地址`, which
 * keeps a repeatable row editor out of the way while staying explicit about the
 * three fields the database validates.
 */
export function parseMentionLines(text: string): { mentions: HomeInputMentionWrite[]; errors: string[] } {
  const mentions: HomeInputMentionWrite[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split("|").map(part => part.trim());
    if (parts.length !== 3) {
      errors.push(`第 ${index + 1} 行需要「名称 | tool 或 image | 图片地址」三段`);
      return;
    }
    const [name, type, imgSrc] = parts as [string, string, string];
    if (!name) errors.push(`第 ${index + 1} 行缺少名称`);
    if (type !== "tool" && type !== "image") errors.push(`第 ${index + 1} 行的类型只能是 tool 或 image`);
    if (!/^https?:\/\//.test(imgSrc)) errors.push(`第 ${index + 1} 行的图片地址必须是 http(s) 链接`);
    if (name && (type === "tool" || type === "image") && /^https?:\/\//.test(imgSrc)) {
      mentions.push({ name, type, imgSrc });
    }
  });
  return { mentions, errors };
}

export function formatMentionLines(mentions: AdminHomeInputMention[]): string {
  return mentions.map(mention => `${mention.name} | ${mention.type} | ${mention.imgSrc}`).join("\n");
}

/** One image URL per line; the server rejects empty or oversized entries. */
export function parseImageUrlLines(text: string): { urls: string[]; errors: string[] } {
  const urls: string[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (!/^https?:\/\//.test(line)) errors.push(`第 ${index + 1} 行的图片地址必须是 http(s) 链接`);
    else urls.push(line);
  });
  return { urls, errors };
}

type FormState = {
  mode: "create" | "edit";
  caseId: string;
  exampleId: string;
  categoryKey: string;
  title: string;
  coverImageUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  caseUrl: string;
  seedPrompt: string;
  prompt: string;
  imageUrls: string;
  mentions: string;
  isActive: boolean;
};

/**
 * Every write needs a reason, so every action goes through the same inline confirm
 * step - including reordering, which submits the whole new order it just computed.
 */
type Pending =
  | { type: "toggle"; kind: string; entityId: string; label: string; next: boolean }
  | { type: "delete"; kind: "discovery_case" | "example_example"; entityId: string; label: string }
  | { type: "reorder"; kind: "discovery_case" | "example_example"; label: string; orderedIds: string[] }
  | { type: "category-reorder"; kind: "discovery_category" | "example_category"; label: string; orderedKeys: string[] };

const emptyForm = (categoryKey: string): FormState => ({
  mode: "create", caseId: "", exampleId: "", categoryKey, title: "", coverImageUrl: "",
  authorName: "", authorAvatarUrl: "", caseUrl: "", seedPrompt: "",
  prompt: "", imageUrls: "", mentions: "", isActive: true,
});

export function AdminHomeContentSection({ accessToken }: { accessToken: string }) {
  const [kind, setKind] = useState<"discovery_case" | "example_example">("discovery_case");
  const [overview, setOverview] = useState<AdminHomeContentOverviewResponse | null>(null);
  const [items, setItems] = useState<Array<AdminHomeDiscoveryCase | AdminHomeExample>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [categoryKey, setCategoryKey] = useState("");
  const [isActive, setIsActive] = useState("");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState({ categoryKey: "", isActive: "", query: "" });

  const [form, setForm] = useState<FormState | null>(null);
  const [categoryForm, setCategoryForm] = useState<{ key: string; label: string; dataType: string; accent: string; isActive: boolean; editing: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");

  const categories = useMemo(() => {
    if (!overview) return [];
    return kind === "discovery_case" ? overview.discovery.categories : overview.example.categories;
  }, [overview, kind]);

  const categoryKind = kind === "discovery_case" ? "discovery_category" : "example_category";

  const loadOverview = useCallback(async () => {
    if (!accessToken) return;
    try {
      setOverview(await fetchAdminHomeContentOverview(accessToken));
    } catch (caught) {
      setOverview(null);
      setError(caught instanceof Error ? caught.message : "首页内容概览加载失败，请稍后重试。");
    }
  }, [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminHomeContentItems(accessToken, {
        kind,
        ...(applied.categoryKey ? { categoryKey: applied.categoryKey } : {}),
        ...(applied.isActive === "" ? {} : { active: applied.isActive === "true" }),
        ...(applied.query.trim() ? { query: applied.query.trim() } : {}),
        limit: 200,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      setItems([]);
      setTotal(0);
      setError(caught instanceof Error ? caught.message : "首页内容加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [accessToken, kind, applied]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { void load(); }, [load]);

  // Selecting a category keeps the list exact, which is what the reorder contract
  // needs: the server only accepts a list that names every entry of one category.
  useEffect(() => {
    if (applied.categoryKey) return;
    const first = categories[0]?.key ?? "";
    if (!first) return;
    setCategoryKey(first);
    setApplied(current => ({ ...current, categoryKey: first }));
  }, [categories, applied.categoryKey]);

  const canReorder = applied.isActive === "" && !applied.query.trim() && total > 0 && total === items.length;

  async function runWrite(action: () => Promise<string>, done: string) {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const message = await action();
      setFeedback(message || done);
      setPending(null);
      setReason("");
      await Promise.all([loadOverview(), load()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function submitForm() {
    if (!form) return;
    const trimmed = {
      categoryKey: form.categoryKey.trim(), title: form.title.trim(),
      coverImageUrl: form.coverImageUrl.trim(), authorName: form.authorName.trim() || null,
      authorAvatarUrl: form.authorAvatarUrl.trim(), caseUrl: form.caseUrl.trim() || null,
      seedPrompt: form.seedPrompt.trim() || null, prompt: form.prompt.trim() || null,
      isActive: form.isActive, reason,
    };
    const images = parseImageUrlLines(form.imageUrls);
    const mentions = parseMentionLines(form.mentions);
    if (kind === "example_example" && (images.errors.length || mentions.errors.length)) {
      setError([...images.errors, ...mentions.errors].join("；"));
      return;
    }
    await runWrite(async () => {
      if (kind === "discovery_case") {
        const result = await upsertAdminHomeDiscoveryCase(accessToken, {
          caseId: form.mode === "edit" ? form.caseId : null,
          categoryKey: trimmed.categoryKey, title: trimmed.title, coverImageUrl: trimmed.coverImageUrl,
          authorName: trimmed.authorName, authorAvatarUrl: trimmed.authorAvatarUrl,
          caseUrl: trimmed.caseUrl, seedPrompt: trimmed.seedPrompt, isActive: trimmed.isActive, reason,
        });
        return result.created ? "已新建案例，操作已记入审计。" : "已保存案例，操作已记入审计。";
      }
      const result = await upsertAdminHomeExample(accessToken, {
        exampleId: form.mode === "edit" ? form.exampleId : null,
        categoryKey: trimmed.categoryKey, title: trimmed.title, prompt: trimmed.prompt,
        imageUrls: images.urls, inputMentions: mentions.mentions, isActive: trimmed.isActive, reason,
      });
      return result.created ? "已新建示例，操作已记入审计。" : "已保存示例，操作已记入审计。";
    }, "已保存，操作已记入审计。");
    setForm(null);
  }

  function moveItem(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ordered = [...items];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved!);
    setReason("");
    setPending({
      type: "reorder", kind,
      label: `「${categories.find(category => category.key === applied.categoryKey)?.label ?? applied.categoryKey}」的第 ${index + 1} 条`,
      orderedIds: ordered.map(item => item.id),
    });
  }

  function moveCategory(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= categories.length) return;
    const ordered = [...categories];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved!);
    setReason("");
    setPending({
      type: "category-reorder", kind: categoryKind,
      label: `「${categories[index]?.label ?? ""}」`,
      orderedKeys: ordered.map(category => category.key),
    });
  }

  async function confirmPending() {
    if (!pending) return;
    await runWrite(async () => {
      if (pending.type === "delete") {
        await deleteAdminHomeContent(accessToken, { kind: pending.kind, entityId: pending.entityId, reason });
        return "已删除，操作已记入审计。";
      }
      if (pending.type === "reorder") {
        const result = await reorderAdminHomeContent(accessToken, {
          kind: pending.kind, categoryKey: applied.categoryKey, orderedIds: pending.orderedIds, reason,
        });
        return `已保存顺序（${result.ordered} 条），操作已记入审计。`;
      }
      if (pending.type === "category-reorder") {
        const result = await reorderAdminHomeCategories(accessToken, {
          kind: pending.kind, orderedKeys: pending.orderedKeys, reason,
        });
        return `已保存分类顺序（${result.ordered} 个），操作已记入审计。`;
      }
      const result = await setAdminHomeContentActive(accessToken, {
        kind: pending.kind as "discovery_case", entityId: pending.entityId, isActive: pending.next, reason,
      });
      return result.hiddenItems > 0
        ? `已下架，同时隐藏其下 ${result.hiddenItems} 条内容，操作已记入审计。`
        : "已更新上架状态，操作已记入审计。";
    }, "已更新。");
  }

  const editingForm = form;

  return (
    <div className="space-y-5" data-testid="admin-home-content">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">首页内容</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              首页「发现」与「示例」两个内容库的分类、条目、配图与上下架。
              首页由浏览器直接读表，只返回 <span className="font-mono">is_active</span> 的内容，
              <strong>下架分类会同时隐藏它下面的全部内容</strong>；分类不支持删除（外键级联），请改用下架。
              顺序不用手填数字：新条目追加到末尾，上下移动会提交整个分类的完整顺序。
            </p>
          </div>
          <div className="inline-flex rounded-lg bg-muted p-1">
            {(["discovery_case", "example_example"] as const).map(value => (
              <button key={value} type="button"
                onClick={() => { setKind(value); setCategoryKey(""); setApplied({ categoryKey: "", isActive: "", query: "" }); setForm(null); }}
                className={`rounded-md px-3 py-1.5 text-xs ${kind === value ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}>
                {homeContentKindLabel(value)}
              </button>
            ))}
          </div>
        </div>
        {feedback ? <p className="mt-3 text-sm text-muted-foreground" data-testid="admin-home-feedback">{feedback}</p> : null}
        {error ? <p className="mt-3 text-sm text-destructive" data-testid="admin-home-error">{error}</p> : null}
      </section>

      <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-home-categories">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {kind === "discovery_case" ? "发现分类" : "示例分类"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {categories.length} 个 · 共 {kind === "discovery_case" ? overview?.discovery.itemCount ?? 0 : overview?.example.itemCount ?? 0} 条内容
            </span>
          </h3>
          <button type="button"
            onClick={() => setCategoryForm({ key: "", label: "", dataType: "", accent: "", isActive: true, editing: false })}
            className="rounded-md border border-border px-3 py-1 text-xs">新增分类</button>
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          {categories.map((category, index) => (
            <li key={category.key} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
              <div>
                <span className="font-medium">{category.label}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{category.key}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {category.activeItemCount}/{category.itemCount} 条已上架
                </span>
                {category.isActive
                  ? <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">已上架</span>
                  : <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">已下架（其下内容一并隐藏）</span>}
              </div>
              <div className="flex gap-1">
                <button type="button" disabled={index === 0} onClick={() => moveCategory(index, -1)}
                  className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">上移</button>
                <button type="button" disabled={index === categories.length - 1} onClick={() => moveCategory(index, 1)}
                  className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">下移</button>
                <button type="button"
                  onClick={() => setCategoryForm({
                    key: category.key, label: category.label,
                    // Only example categories carry these two; the typeof guards keep
                    // the narrowing honest instead of relying on `in`.
                    dataType: categoryDataType(category),
                    accent: categoryAccent(category),
                    isActive: category.isActive, editing: true,
                  })}
                  className="rounded-md border border-border px-2 py-1 text-xs">编辑</button>
                <button type="button"
                  onClick={() => { setPending({ type: "toggle", kind: categoryKind, entityId: category.key, label: category.label, next: !category.isActive }); setReason(""); }}
                  className="rounded-md border border-border px-2 py-1 text-xs">
                  {category.isActive ? "下架" : "上架"}
                </button>
              </div>
            </li>
          ))}
          {categories.length === 0 ? (
            <li className="py-3 text-xs text-muted-foreground">该内容库还没有分类，先新增一个分类。</li>
          ) : null}
        </ul>

        {categoryForm ? (
          <form className="mt-4 rounded-md border border-border p-3"
            onSubmit={event => { event.preventDefault(); void runWrite(async () => {
              const result = await upsertAdminHomeCategory(accessToken, {
                kind: categoryKind, key: categoryForm.key.trim(), label: categoryForm.label.trim(),
                dataType: categoryKind === "example_category" ? categoryForm.dataType.trim() || null : null,
                accent: categoryKind === "example_category" ? (categoryForm.accent.trim() || null) as "special" | null : null,
                isActive: categoryForm.isActive, reason,
              });
              setCategoryForm(null);
              return result.created ? "已新增分类，操作已记入审计。" : "已保存分类，操作已记入审计。";
            }, "已保存分类。"); }}>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">key（小写字母/数字/短横线）
                <input value={categoryForm.key} onChange={event => setCategoryForm({ ...categoryForm, key: event.target.value })}
                  disabled={categoryForm.editing} aria-label="分类 key"
                  className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-60" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">名称
                <input value={categoryForm.label} onChange={event => setCategoryForm({ ...categoryForm, label: event.target.value })}
                  aria-label="分类名称"
                  className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
              </label>
              {categoryKind === "example_category" ? (
                <>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">数据类型
                    <input value={categoryForm.dataType} onChange={event => setCategoryForm({ ...categoryForm, dataType: event.target.value })}
                      aria-label="分类数据类型"
                      className="w-40 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">强调样式
                    <select value={categoryForm.accent} onChange={event => setCategoryForm({ ...categoryForm, accent: event.target.value })}
                      aria-label="分类强调样式"
                      className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                      <option value="">无</option>
                      <option value="special">special</option>
                    </select>
                  </label>
                </>
              ) : null}
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={categoryForm.isActive}
                  onChange={event => setCategoryForm({ ...categoryForm, isActive: event.target.checked })} aria-label="分类上架" />
                上架
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">原因（必填，至少 2 个字符）
                <input value={reason} onChange={event => setReason(event.target.value)} aria-label="分类原因"
                  className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={busy || categoryForm.key.trim().length < 1 || categoryForm.label.trim().length < 1 || reason.trim().length < 2}
                  className="rounded-md bg-foreground px-3 py-1 text-xs text-background disabled:opacity-50">保存分类</button>
                <button type="button" onClick={() => setCategoryForm(null)}
                  className="rounded-md border border-border px-3 py-1 text-xs">取消</button>
              </div>
            </div>
          </form>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <form className="flex flex-wrap items-end gap-2"
          onSubmit={event => { event.preventDefault(); setApplied({ categoryKey, isActive, query }); }}>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">分类
            <select value={categoryKey} aria-label="内容分类" onChange={event => setCategoryKey(event.target.value)}
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部分类</option>
              {categories.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">上架状态
            <select value={isActive} aria-label="内容上架状态" onChange={event => setIsActive(event.target.value)}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
              <option value="">全部</option>
              <option value="true">已上架</option>
              <option value="false">已下架</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">关键词
            <input value={query} onChange={event => setQuery(event.target.value)} aria-label="内容关键词"
              placeholder="标题 / 提示词"
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm">查询</button>
          <button type="button" onClick={() => void load()} className="rounded-md border border-border px-3 py-1.5 text-sm">刷新</button>
          <button type="button"
            onClick={() => setForm(emptyForm(applied.categoryKey || categories[0]?.key || ""))}
            className="rounded-md border border-border px-3 py-1.5 text-sm">
            新增{homeContentKindLabel(kind)}
          </button>
        </form>
        {!canReorder ? (
          <p className="mt-3 text-xs text-muted-foreground">
            排序需要看到该分类的全部条目：请清空上架状态与关键词筛选（当前 {items.length}/{total} 条）。
          </p>
        ) : null}      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载首页内容…</p>
      ) : (
        <section className="rounded-lg border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">共 {total} 条匹配，当前显示 {items.length} 条。</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-home-table">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right">顺序</th>
                  <th className="px-3 py-2">标题</th>
                  <th className="px-3 py-2">分类</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">更新</th>
                  <th className="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    没有匹配的内容。可以清空筛选或新增一条。
                  </td></tr>
                ) : items.map((item, index) => (
                  <tr key={item.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{item.sortOrder}</td>
                    <td className="px-3 py-2">
                      <div>{item.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">{item.id}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{item.categoryKey}</td>
                    <td className="px-3 py-2 text-xs">
                      {item.isActive
                        ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">已上架</span>
                        : <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">已下架</span>}
                      {item.categoryIsActive === false ? (
                        <span className="ml-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600"
                          data-testid="admin-home-hidden">分类已下架</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{formatJobTimestamp(item.updatedAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button type="button" disabled={!canReorder || index === 0} onClick={() => moveItem(index, -1)}
                          className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">上移</button>
                        <button type="button" disabled={!canReorder || index === items.length - 1} onClick={() => moveItem(index, 1)}
                          className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40">下移</button>
                        <button type="button" onClick={() => setForm(toForm(kind, item))}
                          className="rounded-md border border-border px-2 py-1 text-xs">编辑</button>
                        <button type="button"
                          onClick={() => { setPending({ type: "toggle", kind, entityId: item.id, label: item.title, next: !item.isActive }); setReason(""); }}
                          className="rounded-md border border-border px-2 py-1 text-xs">
                          {item.isActive ? "下架" : "上架"}
                        </button>
                        <button type="button"
                          onClick={() => { setPending({ type: "delete", kind, entityId: item.id, label: item.title }); setReason(""); }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-destructive">删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editingForm ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-home-form">
          <h3 className="text-sm font-medium">
            {editingForm.mode === "create" ? `新增${homeContentKindLabel(kind)}` : `编辑${homeContentKindLabel(kind)}`}
          </h3>
          <form className="mt-3 grid gap-2 sm:grid-cols-2"
            onSubmit={event => { event.preventDefault(); void submitForm(); }}>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">分类
              <select value={editingForm.categoryKey} aria-label="表单分类"
                onChange={event => setForm({ ...editingForm, categoryKey: event.target.value })}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                <option value="">请选择</option>
                {categories.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">标题
              <input value={editingForm.title} onChange={event => setForm({ ...editingForm, title: event.target.value })}
                aria-label="表单标题"
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>

            {kind === "discovery_case" ? (
              <>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">封面图地址
                  <input value={editingForm.coverImageUrl} onChange={event => setForm({ ...editingForm, coverImageUrl: event.target.value })}
                    aria-label="表单封面图" placeholder="https://…"
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">作者
                  <input value={editingForm.authorName} onChange={event => setForm({ ...editingForm, authorName: event.target.value })}
                    aria-label="表单作者"
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">作者头像地址
                  <input value={editingForm.authorAvatarUrl} onChange={event => setForm({ ...editingForm, authorAvatarUrl: event.target.value })}
                    aria-label="表单作者头像"
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">案例链接
                  <input value={editingForm.caseUrl} onChange={event => setForm({ ...editingForm, caseUrl: event.target.value })}
                    aria-label="表单案例链接"
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">灵感提示词
                  <textarea value={editingForm.seedPrompt} onChange={event => setForm({ ...editingForm, seedPrompt: event.target.value })}
                    aria-label="表单提示词" rows={3}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">示例提示词
                  <textarea value={editingForm.prompt} onChange={event => setForm({ ...editingForm, prompt: event.target.value })}
                    aria-label="表单提示词" rows={3}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">预览图地址（每行一个）
                  <textarea value={editingForm.imageUrls} onChange={event => setForm({ ...editingForm, imageUrls: event.target.value })}
                    aria-label="表单预览图" rows={3}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">输入素材（每行「名称 | tool 或 image | 图片地址」）
                  <textarea value={editingForm.mentions} onChange={event => setForm({ ...editingForm, mentions: event.target.value })}
                    aria-label="表单输入素材" rows={3}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
                </label>
              </>
            )}

            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={editingForm.isActive}
                onChange={event => setForm({ ...editingForm, isActive: event.target.checked })} aria-label="表单上架" />
              上架
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">原因（必填，至少 2 个字符）
              <input value={reason} onChange={event => setReason(event.target.value)} aria-label="表单原因"
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" disabled={busy || reason.trim().length < 2 || editingForm.title.trim().length < 1
                || editingForm.categoryKey.trim().length < 1}
                className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-50">保存</button>
              <button type="button" onClick={() => { setForm(null); setReason(""); }}
                className="rounded-md border border-border px-3 py-1.5 text-xs">取消</button>
            </div>
          </form>
        </section>
      ) : null}

      {pending ? (
        <section className="rounded-lg border border-border bg-card p-5" data-testid="admin-home-confirm">
          <h3 className="text-sm font-medium">
            {pending.type === "delete" ? "删除" : pending.type === "toggle" ? (pending.next ? "上架" : "下架") : "调整顺序"}
            {" "}{pending.label}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {pending.type === "delete"
              ? "删除后无法恢复（首页内容没有回收站）。"
              : pending.type === "toggle" && pending.kind.endsWith("category")
                ? "下架分类会同时隐藏它下面的全部内容。"
                : pending.type === "toggle"
                  ? "上架/下架只影响首页是否展示。"
                  : "顺序会按当前列表完整提交，只影响首页展示次序。"}
            {" "}操作会连同原因一起写入管理审计。
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">原因（必填，至少 2 个字符）
              <input value={reason} onChange={event => setReason(event.target.value)} aria-label="操作原因"
                className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="button" disabled={busy || reason.trim().length < 2}
              onClick={() => void confirmPending()}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-white disabled:opacity-50">确认</button>
            <button type="button" onClick={() => { setPending(null); setReason(""); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs">取消</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Discovery categories have no data type or accent; the guards keep types honest. */
export function categoryDataType(category: unknown): string {
  const value = (category as { dataType?: unknown } | null)?.dataType;
  return typeof value === "string" ? value : "";
}

export function categoryAccent(category: unknown): string {
  const value = (category as { accent?: unknown } | null)?.accent;
  return typeof value === "string" ? value : "";
}

function toForm(kind: "discovery_case" | "example_example", item: AdminHomeDiscoveryCase | AdminHomeExample): FormState {  const base = { ...emptyForm(item.categoryKey), mode: "edit" as const, isActive: item.isActive, title: item.title };
  if (kind === "discovery_case") {
    const row = item as AdminHomeDiscoveryCase;
    return { ...base, caseId: row.id, coverImageUrl: row.coverImageUrl, authorName: row.authorName,
      authorAvatarUrl: row.authorAvatarUrl, caseUrl: row.caseUrl, seedPrompt: row.seedPrompt };
  }
  const row = item as AdminHomeExample;
  return { ...base, exampleId: row.id, prompt: row.prompt,
    imageUrls: row.imageUrls.join("\n"), mentions: formatMentionLines(row.inputMentions) };
}
