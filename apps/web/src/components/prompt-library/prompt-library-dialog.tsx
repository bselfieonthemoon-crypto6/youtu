"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { PromptLibraryEntry, PromptLibrarySource } from "@loomic/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  fetchPromptLibrary,
  type PromptLibraryApplyMode,
} from "../../lib/prompt-library-api";
import {
  PromptImageGallery,
  PromptPreviewImage,
  PromptPreviewNotice,
  hasExplicitAdultPreviewLabel,
  promptPreviewUrls,
} from "./prompt-preview-image";

type Props = {
  accessToken: string;
  currentPrompt: string;
  disabled?: boolean;
  onApply: (entry: PromptLibraryEntry, mode: PromptLibraryApplyMode) => void;
  onClose: () => void;
};

function SourceLink({ source }: { source: PromptLibrarySource }) {
  return (
    <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
      >
        {source.name}
        <ArrowUpRight className="size-3" />
      </a>
      <p>{source.attribution}</p>
      <p>
        授权：
        {source.licenseUrl ? (
          <a
            href={source.licenseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            {source.license}
          </a>
        ) : (
          source.license
        )}
      </p>
      <p>{source.note}</p>
    </div>
  );
}

export function PromptLibraryDialog({
  accessToken,
  currentPrompt,
  disabled = false,
  onApply,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [category, setCategory] = useState("");
  const [sources, setSources] = useState<PromptLibrarySource[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [items, setItems] = useState<PromptLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState<PromptLibraryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const [revealedPreviews, setRevealedPreviews] = useState<Set<string>>(
    () => new Set(),
  );
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const revealPreview = (id: string) =>
    setRevealedPreviews((previous) => new Set([...previous, id]));
  const isPreviewHidden = (entry: PromptLibraryEntry) =>
    hasExplicitAdultPreviewLabel(entry) && !revealedPreviews.has(entry.id);

  useEffect(() => {
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setItems([]);
    setNextOffset(null);
    setSelected(null);
    const timer = window.setTimeout(
      () => {
        void fetchPromptLibrary(
          accessToken,
          { q: query, source: sourceId, category },
          controller.signal,
        )
          .then((result) => {
            if (controller.signal.aborted || request !== requestRef.current)
              return;
            setSources(result.sources);
            setCategories(result.categories);
            setItems(result.items);
            setTotal(result.total);
            setNextOffset(result.nextOffset);
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted || request !== requestRef.current)
              return;
            setError(
              cause instanceof Error
                ? cause.message
                : "提示词库暂时无法加载，请重试。",
            );
          })
          .finally(() => {
            if (!controller.signal.aborted && request === requestRef.current)
              setLoading(false);
          });
      },
      query ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      controllerRef.current?.abort();
    };
  }, [accessToken, query, sourceId, category, retry]);

  const loadMore = async () => {
    if (nextOffset === null || loading || loadingMore) return;
    const request = requestRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchPromptLibrary(
        accessToken,
        { q: query, source: sourceId, category, offset: nextOffset },
        controller.signal,
      );
      if (controller.signal.aborted || request !== requestRef.current) return;
      setItems((previous) => {
        const seen = new Set(previous.map((entry) => entry.id));
        return [
          ...previous,
          ...result.items.filter((entry) => !seen.has(entry.id)),
        ];
      });
      setTotal(result.total);
      setNextOffset(result.nextOffset);
    } catch (cause) {
      if (!controller.signal.aborted && request === requestRef.current)
        setError(
          cause instanceof Error ? cause.message : "加载更多失败，请重试。",
        );
    } finally {
      if (!controller.signal.aborted && request === requestRef.current)
        setLoadingMore(false);
    }
  };

  const filteredSource = sources.find((source) => source.id === sourceId);
  const selectedSource = sources.find(
    (source) => source.id === selected?.sourceId,
  );
  const canApply = Boolean(
    selected && selectedSource?.status === "available" && !disabled,
  );
  const apply = (mode: PromptLibraryApplyMode) => {
    if (selected && canApply) onApply(selected, mode);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-[150] bg-black/25 backdrop-blur-sm"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        />
        <Dialog.Popup
          initialFocus={searchRef}
          className="fixed left-1/2 top-1/2 z-[160] flex h-[min(780px,88dvh)] w-[min(1100px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl outline-none"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
              <BookOpen className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold">
                提示词库
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-relaxed text-muted-foreground">
                从公开提示词中寻找灵感，填入当前节点后可继续修改。不会自动生成或切换模型。
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="关闭提示词库"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
            <label className="relative min-w-[180px] flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                aria-label="搜索提示词"
                value={query}
                maxLength={160}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、风格或提示词内容"
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-foreground/40"
              />
            </label>
            <select
              aria-label="提示词分类"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-9 max-w-[180px] rounded-lg border border-border bg-background px-2 text-xs"
            >
              <option value="">全部分类</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label="提示词来源"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              className="h-9 max-w-[230px] rounded-lg border border-border bg-background px-2 text-xs"
            >
              <option value="">全部来源</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                  {source.status === "link_only" ? " · 仅外链" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowSources((value) => !value)}
              className="h-9 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted"
              aria-expanded={showSources}
            >
              来源与授权
            </button>
          </div>
          {showSources && (
            <div className="grid max-h-[200px] shrink-0 gap-4 overflow-y-auto border-b border-border bg-muted/30 px-5 py-3 sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => (
                <section key={source.id}>
                  <SourceLink source={source} />
                  <p className="mt-1 text-xs">
                    {source.status === "available"
                      ? `已收录 ${source.entryCount} 条`
                      : "仅提供来源链接，未导入内容"}
                  </p>
                </section>
              ))}
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <section
              ref={listRef}
              aria-label="提示词列表"
              aria-busy={loading}
              className={`min-w-0 flex-1 overflow-y-auto p-5 ${selected ? "hidden sm:block" : ""}`}
            >
              {filteredSource?.status === "link_only" && (
                <div className="mb-4 rounded-xl border border-border bg-muted/30 p-4">
                  <p className="mb-2 text-sm font-medium">
                    此来源仅提供外部链接
                  </p>
                  <SourceLink source={filteredSource} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    尚未确认可直接收录的授权，不会套用其提示词或加载预览图片。
                  </p>
                </div>
              )}
              {loading ? (
                <div
                  role="status"
                  className="flex min-h-[240px] items-center justify-center gap-2 text-sm text-muted-foreground"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  正在加载提示词…
                </div>
              ) : (
                <>
                  {error && (
                    <div
                      role="alert"
                      className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm"
                    >
                      <p>{error}</p>
                      <button
                        type="button"
                        onClick={() =>
                          items.length
                            ? void loadMore()
                            : setRetry((value) => value + 1)
                        }
                        className="mt-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {!error &&
                    items.length === 0 &&
                    filteredSource?.status !== "link_only" && (
                      <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
                        <Search className="size-7 text-muted-foreground/50" />
                        <p className="text-sm">没有找到匹配的提示词</p>
                        <p className="text-xs text-muted-foreground">
                          试试其他关键词，或清除分类与来源筛选。
                        </p>
                        <button
                          type="button"
                          className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs"
                          onClick={() => {
                            setQuery("");
                            setSourceId("");
                            setCategory("");
                          }}
                        >
                          清除筛选
                        </button>
                      </div>
                    )}
                  <div
                    className={`grid grid-cols-2 gap-3 ${selected ? "" : "lg:grid-cols-4"}`}
                  >
                    {items.map((entry) => {
                      const source = sources.find(
                        (value) => value.id === entry.sourceId,
                      );
                      return (
                        <article
                          key={entry.id}
                          onClick={() => setSelected(entry)}
                          className={`group cursor-pointer overflow-hidden rounded-xl border bg-background text-left transition-colors hover:border-foreground/35 ${entry.id === selected?.id ? "border-foreground/60 ring-1 ring-foreground/15" : "border-border"}`}
                        >
                          {source?.status === "available" &&
                          isPreviewHidden(entry) ? (
                            <PromptPreviewNotice
                              className="aspect-[4/3]"
                              sourceUrl={entry.sourceUrl}
                              onReveal={() => revealPreview(entry.id)}
                            />
                          ) : (
                            <PromptPreviewImage
                              src={
                                source?.status === "available"
                                  ? promptPreviewUrls(entry)[0]
                                  : undefined
                              }
                              title={entry.title}
                              sourceUrl={entry.sourceUrl}
                              scrollRootRef={listRef}
                              className="aspect-[4/3] p-2"
                            />
                          )}
                          <button
                            type="button"
                            aria-label={`查看提示词：${entry.title}`}
                            aria-pressed={entry.id === selected?.id}
                            className="w-full space-y-1.5 p-3 text-left"
                          >
                            <p className="line-clamp-2 text-xs font-medium leading-relaxed">
                              {entry.title}
                            </p>
                            <p className="truncate text-[10px] text-muted-foreground">
                              {source?.name ?? entry.sourceId}
                            </p>
                            <div className="flex flex-wrap gap-1">
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {entry.category}
                              </span>
                              {entry.requiresReference && (
                                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                                  需参考图
                                </span>
                              )}
                            </div>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                  {nextOffset !== null && (
                    <button
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border py-2 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {loadingMore && (
                        <LoaderCircle className="size-3 animate-spin" />
                      )}
                      {loadingMore ? "加载中…" : "加载更多"}
                    </button>
                  )}
                </>
              )}
            </section>
            {selected && (
              <aside
                aria-label="提示词详情"
                className="flex w-full shrink-0 flex-col border-l border-border bg-muted/15 sm:w-[400px]"
              >
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ArrowLeft className="size-3.5" />
                    返回列表
                  </button>
                  <h3 className="text-base font-semibold leading-relaxed">
                    {selected.title}
                  </h3>
                  {selectedSource?.status === "available" &&
                  isPreviewHidden(selected) ? (
                    <PromptPreviewNotice
                      className="h-[300px] rounded-xl border border-border"
                      sourceUrl={selected.sourceUrl}
                      onReveal={() => revealPreview(selected.id)}
                    />
                  ) : (
                    <PromptImageGallery
                      key={selected.id}
                      entry={selected}
                      allowed={selectedSource?.status === "available"}
                    />
                  )}
                  <div className="rounded-xl border border-border bg-background p-3 text-xs leading-relaxed">
                    <p className="font-medium">模型适用提示</p>
                    <p className="mt-1 text-muted-foreground">
                      {selected.modelHints.length
                        ? selected.modelHints.join("、")
                        : "未注明特定模型，可结合当前模型调整提示词。"}
                    </p>
                    <p className="mt-2 text-muted-foreground">
                      原作者示例不保证在所有模型上得到相同效果，当前模型与参数保持不变。
                    </p>
                    {selected.requiresReference && (
                      <p className="mt-2 text-amber-700 dark:text-amber-300">
                        需参考图，请在支持参考图的改图入口使用。当前节点为文字生图，可先填入并调整原文。示例图不会自动作为参考图。
                      </p>
                    )}
                  </div>
                  <section>
                    <h4 className="mb-2 text-xs font-medium">提示词原文</h4>
                    <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-3 font-sans text-xs leading-[1.8]">
                      {selected.prompt}
                    </pre>
                  </section>
                  <section className="border-t border-border pt-3">
                    <h4 className="mb-2 text-xs font-medium">来源与授权</h4>
                    {selected.author && (
                      <p className="mb-2 text-xs text-muted-foreground">
                        作者：{selected.author}
                      </p>
                    )}
                    {selectedSource && <SourceLink source={selectedSource} />}
                    <a
                      href={selected.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-4"
                    >
                      查看原始条目
                      <ArrowUpRight className="size-3" />
                    </a>
                  </section>
                </div>
                <footer className="shrink-0 space-y-2 border-t border-border bg-card p-4">
                  {currentPrompt.trim() ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        当前节点已有提示词，请选择替换或追加。
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={!canApply}
                          onClick={() => apply("replace")}
                          className="flex-1 rounded-lg border border-border px-2 py-2 text-xs hover:bg-muted disabled:opacity-40"
                        >
                          替换当前提示词
                        </button>
                        <button
                          type="button"
                          disabled={!canApply}
                          onClick={() => apply("append")}
                          className="flex-1 rounded-lg bg-foreground px-2 py-2 text-xs text-background disabled:opacity-40"
                        >
                          追加到末尾
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!canApply}
                      onClick={() => apply("replace")}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-foreground px-3 py-2 text-xs text-background disabled:opacity-40"
                    >
                      <Check className="size-3.5" />
                      使用此提示词
                    </button>
                  )}
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {disabled
                      ? "节点正在生成，暂时不能修改提示词。"
                      : selectedSource?.status !== "available"
                        ? "此来源尚未开放直接套用，请查看原始链接。"
                        : "只填入文字，不会提交生成请求或扣除生成费用。"}
                  </p>
                </footer>
              </aside>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-between gap-2 border-t border-border px-5 py-2.5 text-[10px] text-muted-foreground">
            <span>
              {loading ? "正在检索…" : `已显示 ${items.length} / ${total} 条`}
            </span>
            <span>
              图片按需从原站加载 · 保留作者与来源 · 不会自动作为生成输入
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
