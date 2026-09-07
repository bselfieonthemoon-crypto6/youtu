"use client";

import type {
  DesignFontFaceDto,
  DesignResourceDto,
  DesignTemplateDto,
  DesignTextPresetDto,
} from "@loomic/shared";
import { Heart, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type DesignCatalogCollection,
  type DesignCatalogPage,
  type DesignFontCatalogItem,
  createDesignResourceApiClient,
} from "../../lib/design-resource-api";
import { cn } from "../../lib/utils";

export type DesignResourceTab = "templates" | "assets" | "text" | "fonts";

export type DesignResourcePanelProps = {
  onResourceDrag?: (resource: DesignResourceDto) => void;
  accessToken: string;
  workspaceId: string;
  disabled?: boolean;
  onInsertResource?: (
    resource: DesignResourceDto,
    source: Blob,
  ) => Promise<void>;
  onInsertTextPreset?: (preset: DesignTextPresetDto) => Promise<void>;
  onApplyFont?: (face: DesignFontFaceDto) => Promise<void>;
  onChooseTemplate?: (template: DesignTemplateDto) => void;
  activeTab?: DesignResourceTab;
  onTabChange?: (tab: DesignResourceTab) => void;
};

const emptyPage = (): DesignCatalogPage<unknown> => ({
  items: [],
  next_cursor: null,
});

export function DesignResourcePanel({
  onResourceDrag,
  accessToken,
  workspaceId,
  disabled = false,
  onInsertResource,
  onInsertTextPreset,
  onApplyFont,
  onChooseTemplate,
  activeTab,
  onTabChange,
}: DesignResourcePanelProps) {
  const client = useMemo(() => createDesignResourceApiClient(), []);
  const [localTab, setLocalTab] = useState<DesignResourceTab>("assets");
  const tab = activeTab ?? localTab;
  const setTab = (next: DesignResourceTab) => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [collection, setCollection] = useState<DesignCatalogCollection>("all");
  const [page, setPage] = useState<DesignCatalogPage<unknown>>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (cursor?: string) => {
      const sequence = ++requestSequence.current;
      requestAbort.current?.abort();
      const controller = new AbortController();
      requestAbort.current = controller;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        let response: DesignCatalogPage<unknown>;
        if (tab === "assets") {
          response = await client.listResources(
            accessToken,
            {
              status: "published",
              query: debouncedQuery || undefined,
              collection,
              workspace_id: workspaceId,
              cursor,
              limit: 24,
            },
            controller.signal,
          );
        } else if (tab === "templates") {
          response = await client.listTemplates(
            accessToken,
            {
              query: debouncedQuery || undefined,
              cursor,
              limit: 24,
            },
            controller.signal,
          );
        } else if (tab === "text") {
          response = await client.listTextPresets(
            accessToken,
            {
              query: debouncedQuery || undefined,
              cursor,
              limit: 24,
            },
            controller.signal,
          );
        } else {
          response = await client.listFonts(
            accessToken,
            {
              query: debouncedQuery || undefined,
              cursor,
              limit: 24,
            },
            controller.signal,
          );
        }
        if (sequence !== requestSequence.current) return;
        setPage((current) => ({
          items: cursor
            ? [...current.items, ...response.items]
            : response.items,
          next_cursor: response.next_cursor,
        }));
        if (tab === "assets" && collection === "favorites") {
          setFavoriteIds(
            new Set(
              (response.items as DesignResourceDto[]).map((item) => item.id),
            ),
          );
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (sequence !== requestSequence.current) return;
        setPage(emptyPage());
        setError(cause instanceof Error ? cause.message : "资源加载失败。");
      } finally {
        if (
          !controller.signal.aborted &&
          sequence === requestSequence.current
        ) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [accessToken, client, collection, debouncedQuery, tab, workspaceId],
  );

  useEffect(() => {
    void load();
    return () => requestAbort.current?.abort();
  }, [load]);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资源操作失败。");
    } finally {
      setBusyId(null);
    }
  };

  const insertResource = (resource: DesignResourceDto) =>
    run(resource.id, async () => {
      if (!onInsertResource) return;
      const source = await client.getResourceContent(accessToken, resource.id);
      await onInsertResource(resource, source);
      await client.recordRecentUse(accessToken, resource.id, workspaceId);
      if (collection === "recent") await load();
    });

  const toggleFavorite = (resource: DesignResourceDto) =>
    run(resource.id, async () => {
      const desired = !favoriteIds.has(resource.id);
      const stored = await client.setFavorite(
        accessToken,
        resource.id,
        desired,
      );
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (stored) next.add(resource.id);
        else next.delete(resource.id);
        return next;
      });
      if (!stored && collection === "favorites") {
        setPage((current) => ({
          ...current,
          items: (current.items as DesignResourceDto[]).filter(
            (item) => item.id !== resource.id,
          ),
        }));
      }
    });

  return (
    <section className="min-h-0" aria-label="设计资源中心">
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
        {(
          [
            ["templates", "模板"],
            ["assets", "素材"],
            ["text", "文字"],
            ["fonts", "字体"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cn(
              "rounded-md px-1 py-1.5 text-xs",
              tab === id
                ? "bg-card font-medium shadow-sm"
                : "text-muted-foreground",
            )}
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              setCollection("all");
              setPage(emptyPage());
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mt-2 flex h-8 items-center gap-2 rounded-lg border bg-background px-2 text-muted-foreground">
        <Search className="size-3.5" aria-hidden />
        <span className="sr-only">搜索资源</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索名称、标签或分类"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
        />
      </label>

      {tab === "assets" && (
        <div className="mt-2 flex gap-1" aria-label="资源范围">
          {(
            [
              ["all", "全部"],
              ["favorites", "收藏"],
              ["recent", "最近"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "rounded-full border px-2 py-1 text-[11px]",
                collection === id && "bg-foreground text-background",
              )}
              onClick={() => {
                setCollection(id);
                setPage(emptyPage());
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex h-28 items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-label="正在加载资源" />
        </div>
      ) : page.items.length === 0 && !error ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          暂无可用资源
        </p>
      ) : (
        <div className="mt-2 grid max-h-[330px] grid-cols-2 gap-2 overflow-y-auto pr-1">
          {tab === "assets" &&
            (page.items as DesignResourceDto[]).map((resource) => (
              <ResourceCard
                {...(onResourceDrag
                  ? { onDrag: () => onResourceDrag(resource) }
                  : {})}
                key={resource.id}
                resource={resource}
                accessToken={accessToken}
                busy={busyId === resource.id}
                favorite={favoriteIds.has(resource.id)}
                disabled={disabled || !onInsertResource}
                loadPreview={(signal) =>
                  client.getResourcePreview(accessToken, resource.id, signal)
                }
                onInsert={() => void insertResource(resource)}
                onFavorite={() => void toggleFavorite(resource)}
              />
            ))}
          {tab === "templates" &&
            (page.items as DesignTemplateDto[]).map((template) => (
              <CatalogCard
                key={template.id}
                name={template.name}
                meta={`${template.width} × ${template.height}`}
                previewAssetObjectId={template.preview_asset_object_id}
                accessToken={accessToken}
                {...(onChooseTemplate
                  ? {
                      actionLabel: "使用",
                      onAction: () => onChooseTemplate(template),
                    }
                  : {})}
              />
            ))}
          {tab === "text" &&
            (page.items as DesignTextPresetDto[]).map((preset) => (
              <CatalogCard
                key={preset.id}
                name={preset.name}
                previewAssetObjectId={preset.preview_asset_object_id}
                accessToken={accessToken}
                busy={busyId === preset.id}
                {...(onInsertTextPreset
                  ? {
                      actionLabel: "插入",
                      onAction: () =>
                        void run(preset.id, () => onInsertTextPreset(preset)),
                    }
                  : {})}
              />
            ))}
          {tab === "fonts" &&
            (page.items as DesignFontCatalogItem[]).map(({ family, faces }) => (
              <div key={family.id} className="col-span-2 rounded-lg border p-2">
                <p className="truncate text-sm font-medium">{family.name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {faces.map((face) => (
                    <button
                      key={face.id}
                      type="button"
                      disabled={disabled || busyId === face.id || !onApplyFont}
                      className="rounded-md bg-muted px-2 py-1 text-[11px] disabled:opacity-50"
                      onClick={() =>
                        onApplyFont &&
                        void run(face.id, () => onApplyFont(face))
                      }
                    >
                      {face.weight} {face.style}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {page.next_cursor && (
        <button
          type="button"
          disabled={loadingMore}
          className="mt-2 w-full rounded-lg border py-1.5 text-xs disabled:opacity-50"
          onClick={() => void load(page.next_cursor ?? undefined)}
        >
          {loadingMore ? "正在加载…" : "加载更多"}
        </button>
      )}
    </section>
  );
}

function ResourceCard(props: {
  onDrag?: () => void;
  resource: DesignResourceDto;
  accessToken: string;
  busy: boolean;
  favorite: boolean;
  disabled: boolean;
  loadPreview: (signal?: AbortSignal) => Promise<Blob>;
  onInsert: () => void;
  onFavorite: () => void;
}) {
  const { resource } = props;
  return (
    <article className="group relative overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        disabled={props.disabled || props.busy}
        className="block w-full text-left disabled:opacity-50"
        onClick={props.onInsert}
        draggable={Boolean(props.onDrag) && !props.disabled && !props.busy}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            "application/x-loomic-design-resource",
            resource.id,
          );
          props.onDrag?.();
        }}
      >
        <LazyBlobImage load={props.loadPreview} alt="" />
        <span className="block truncate px-2 pt-1.5 text-xs font-medium">
          {resource.name}
        </span>
        <span className="block px-2 pb-2 text-[10px] text-muted-foreground">
          {resource.scope === "workspace" ? "工作区" : "平台"}
        </span>
      </button>
      <button
        type="button"
        aria-label={
          props.favorite ? `取消收藏 ${resource.name}` : `收藏 ${resource.name}`
        }
        disabled={props.busy}
        onClick={props.onFavorite}
        className="absolute right-1 top-1 rounded-full bg-background/90 p-1 shadow-sm disabled:opacity-50"
      >
        <Heart
          className={cn(
            "size-3.5",
            props.favorite && "fill-current text-rose-500",
          )}
        />
      </button>
    </article>
  );
}

function CatalogCard(props: {
  name: string;
  meta?: string;
  previewAssetObjectId: string | null;
  accessToken: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <article className="overflow-hidden rounded-lg border bg-card">
      <AssetPreview
        assetObjectId={props.previewAssetObjectId}
        accessToken={props.accessToken}
      />
      <div className="p-2">
        <p className="truncate text-xs font-medium">{props.name}</p>
        {props.meta && (
          <p className="text-[10px] text-muted-foreground">{props.meta}</p>
        )}
        {props.actionLabel && props.onAction && (
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onAction}
            className="mt-1.5 w-full rounded-md bg-foreground py-1 text-[11px] text-background disabled:opacity-50"
          >
            {props.busy ? "处理中…" : props.actionLabel}
          </button>
        )}
      </div>
    </article>
  );
}

function AssetPreview(props: {
  assetObjectId: string | null;
  accessToken: string;
}) {
  const loader = useMemo(
    () =>
      props.assetObjectId
        ? (signal?: AbortSignal) =>
            import("../../lib/canvas-elements").then(({ fetchAssetBlob }) =>
              fetchAssetBlob(props.accessToken, props.assetObjectId as string, {
                preview: true,
                ...(signal ? { signal } : {}),
              }),
            )
        : null,
    [props.accessToken, props.assetObjectId],
  );
  if (!loader) return <div className="aspect-square bg-muted" aria-hidden />;
  return <LazyBlobImage load={loader} alt="" />;
}

function LazyBlobImage({
  load,
  alt,
}: {
  load: (signal?: AbortSignal) => Promise<Blob>;
  alt: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    void previewQueue
      .run(() => loadRef.current(controller.signal))
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible]);
  return (
    <div ref={rootRef} className="aspect-square bg-muted">
      {url && (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="size-full object-cover"
        />
      )}
    </div>
  );
}

class RequestQueue {
  private active = 0;
  private pending: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.pending.shift()?.();
    }
  }
}

const previewQueue = new RequestQueue(4);
