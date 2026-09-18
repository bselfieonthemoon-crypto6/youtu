"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { PromptLibraryEntry } from "@loomic/shared";
import {
  ArrowUpRight,
  ImageOff,
  LoaderCircle,
  Maximize2,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

export const PROMPT_IMAGE_TIMEOUT_MS = 25_000;

/** Respect explicit upstream labels, without inferring content from a prompt. */
export function hasExplicitAdultPreviewLabel(
  entry: PromptLibraryEntry,
): boolean {
  return [entry.title, ...entry.tags].some((label) =>
    /\bnsfw\b|成人内容|成人內容/i.test(label),
  );
}

export function PromptPreviewNotice({
  onReveal,
  sourceUrl,
  className,
}: { onReveal: () => void; sourceUrl: string; className: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 bg-muted/50 p-4 text-center text-xs text-muted-foreground ${className}`}
    >
      <ImageOff className="size-6 opacity-60" />
      <span>来源标注为 NSFW / 成人内容</span>
      <span className="text-[10px]">图片默认隐藏，不会提前请求。</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onReveal();
        }}
        className="rounded-lg border border-border bg-background px-3 py-1.5 text-foreground hover:bg-muted"
      >
        显示此案例图片
      </button>
      <SourceLink href={sourceUrl} />
    </div>
  );
}

type ImageProps = {
  src?: string | undefined;
  title: string;
  sourceUrl: string;
  scrollRootRef?: RefObject<HTMLElement | null>;
  className?: string;
  onZoom?: () => void;
};

function SourceLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-4"
      onClick={(event) => event.stopPropagation()}
    >
      查看原始条目 <ArrowUpRight className="size-3" />
    </a>
  );
}

/** Only visible cards receive a src. Native lazy loading alone eagerly fetches
 * images several screens outside a nested scroll container in some browsers. */
function ObservedPreview({
  src,
  title,
  sourceUrl,
  scrollRootRef,
  className = "aspect-[4/3]",
  onZoom,
}: ImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(!scrollRootRef);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!src || visible || !scrollRootRef) return;
    const target = containerRef.current;
    const root = scrollRootRef.current;
    // Do not accidentally fall back to the window and fetch every modal card.
    if (!target || !root) return;
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          if (
            entries.some(
              (entry) =>
                entry.target === target &&
                entry.isIntersecting &&
                entry.intersectionRatio > 0,
            )
          ) {
            setVisible(true);
            observer.disconnect();
          }
        },
        { root, rootMargin: "0px", threshold: 0.01 },
      );
      observer.observe(target);
      return () => observer.disconnect();
    }
    // Older browsers still respect the list viewport without loading all cards.
    const check = () => {
      const box = target.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      if (
        box.width > 0 &&
        box.height > 0 &&
        box.top < viewport.bottom &&
        box.bottom > viewport.top &&
        box.left < viewport.right &&
        box.right > viewport.left
      )
        setVisible(true);
    };
    check();
    root.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      root.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [scrollRootRef, src, visible]);

  useEffect(() => {
    const img = imageRef.current;
    // A cached image may finish before React subscribes to load.
    if (img?.complete && img.naturalWidth > 0) setState("loaded");
  }, [src, visible, attempt]);

  useEffect(() => {
    if (!src || !visible || state !== "loading") return;
    // Remote hosts can leave image connections pending without an error event.
    // A timed-out request remains an explicit retry; never loop paid/proxied work.
    const timer = window.setTimeout(
      () => setState("error"),
      PROMPT_IMAGE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [src, visible, state, attempt]);

  const retry = () => {
    setState("loading");
    setAttempt((value) => value + 1);
  };

  return (
    <div
      ref={containerRef}
      data-prompt-preview="true"
      className={`relative flex w-full items-center justify-center overflow-hidden bg-muted/50 ${className}`}
    >
      {!src ? (
        <div className="flex flex-col items-center gap-2 p-3 text-center text-xs text-muted-foreground">
          <ImageOff className="size-6 opacity-50" />
          <span>暂无示例图</span>
          <SourceLink href={sourceUrl} />
        </div>
      ) : state === "error" ? (
        <div
          className="flex flex-col items-center gap-2 p-3 text-center text-xs text-muted-foreground"
          role="status"
        >
          <ImageOff className="size-6 opacity-50" />
          <span>原站图片暂时无法加载</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-foreground"
          >
            <RotateCw className="size-3" /> 重试图片
          </button>
          <SourceLink href={sourceUrl} />
        </div>
      ) : (
        <>
          {state !== "loaded" && (
            <div
              className="absolute inset-0 flex animate-pulse flex-col items-center justify-center gap-2 bg-muted/60 text-[11px] text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              {visible ? "正在加载原站图片…" : "进入可视区域后加载图片"}
            </div>
          )}
          {visible && (
            <img
              key={attempt}
              ref={imageRef}
              src={src}
              alt={title}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => setState("loaded")}
              onError={() => setState("error")}
              className={`h-full w-full object-contain ${state === "loaded" ? "opacity-100" : "opacity-0"}`}
            />
          )}
          {onZoom && state === "loaded" && (
            <button
              type="button"
              aria-label="放大查看示例图"
              onClick={(event) => {
                event.stopPropagation();
                onZoom();
              }}
              className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-lg border border-border bg-background/90 px-2 py-1.5 text-xs shadow-sm hover:bg-background"
            >
              <Maximize2 className="size-3" /> 放大
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function PromptPreviewImage(props: ImageProps) {
  // Reset visibility/error/load state on a changed item or URL, including when
  // selecting two library entries that happen to share an upstream image.
  return (
    <ObservedPreview key={`${props.title}\n${props.src ?? ""}`} {...props} />
  );
}

export function promptPreviewUrls(entry: PromptLibraryEntry): string[] {
  return Array.from(
    new Set(
      [entry.imageUrl, ...(entry.previewImageUrls ?? [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ).slice(0, 8);
}

export function PromptImageGallery({
  entry,
  allowed,
}: { entry: PromptLibraryEntry; allowed: boolean }) {
  const urls = allowed ? promptPreviewUrls(entry) : [];
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeIndex = Math.min(index, Math.max(0, urls.length - 1));
  const src = urls[activeIndex];

  return (
    <section aria-label="提示词示例图库" className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-border">
        <PromptPreviewImage
          src={src}
          title={`${entry.title} · 示例 ${activeIndex + 1}`}
          sourceUrl={entry.sourceUrl}
          className="h-[300px] p-2"
          onZoom={() => setZoomed(true)}
        />
      </div>
      {urls.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label="选择示例图片"
        >
          {urls.map((url, imageIndex) => (
            <button
              key={url}
              type="button"
              aria-label={`查看示例图 ${imageIndex + 1}`}
              aria-pressed={imageIndex === activeIndex}
              onClick={(event) => {
                event.stopPropagation();
                setIndex(imageIndex);
              }}
              className={`rounded-md border px-2 py-1 text-xs ${imageIndex === activeIndex ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted"}`}
            >
              {imageIndex + 1}
            </button>
          ))}
          <span className="ml-1 text-[10px] text-muted-foreground">
            {activeIndex + 1} / {urls.length}
          </span>
        </div>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        原作者示例 / 参考展示，仅用于浏览；不会自动作为生图参考输入。
      </p>
      <Dialog.Root open={zoomed} onOpenChange={setZoomed}>
        <Dialog.Portal>
          <Dialog.Backdrop
            className="fixed inset-0 z-[170] bg-black/75"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          />
          <Dialog.Popup
            initialFocus={closeRef}
            className="fixed inset-4 z-[180] flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl outline-none md:inset-8"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-sm font-medium">
                  {entry.title} · 示例 {activeIndex + 1}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                  完整图片按原始比例显示，可返回详情切换其他示例。
                </Dialog.Description>
              </div>
              <Dialog.Close
                ref={closeRef}
                aria-label="关闭放大图片"
                className="rounded-lg p-2 hover:bg-muted"
              >
                <X className="size-4" />
              </Dialog.Close>
            </header>
            <PromptPreviewImage
              src={src}
              title={`${entry.title} · 放大示例 ${activeIndex + 1}`}
              sourceUrl={entry.sourceUrl}
              className="min-h-0 flex-1 p-3"
            />
            <div className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <SourceLink href={entry.sourceUrl} />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
