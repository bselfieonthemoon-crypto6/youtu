import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_IMAGE_TIMEOUT_MS,
  PromptPreviewImage,
  hasExplicitAdultPreviewLabel,
  promptPreviewUrls,
} from "../src/components/prompt-library/prompt-preview-image";
import type { PromptLibraryEntry } from "@loomic/shared";

const entry: PromptLibraryEntry = {
  id: "one",
  title: "Original poster",
  prompt: "Original prompt",
  category: "Poster",
  tags: [],
  sourceId: "source",
  sourceUrl: "https://example.com/source",
  modelHints: [],
  requiresReference: false,
};
const props = {
  src: "https://example.com/one.png",
  title: entry.title,
  sourceUrl: entry.sourceUrl,
};
type Observer = {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit;
  target?: Element;
  disconnect: ReturnType<typeof vi.fn>;
};
let observers: Observer[] = [];
beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      data: Observer;
      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit,
      ) {
        this.data = { callback, options, disconnect: vi.fn() };
        observers.push(this.data);
      }
      observe(target: Element) {
        this.data.target = target;
      }
      disconnect() {
        this.data.disconnect();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function intersect(observer: Observer, visible = true) {
  act(() =>
    observer.callback(
      [
        {
          target: observer.target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
}

describe("prompt preview image", () => {
  it("only recognizes explicit upstream adult labels in titles or tags, not prompt descriptions", () => {
    expect(
      hasExplicitAdultPreviewLabel({ ...entry, title: "Editorial (NSFW)" }),
    ).toBe(true);
    expect(hasExplicitAdultPreviewLabel({ ...entry, tags: ["nsfw"] })).toBe(
      true,
    );
    expect(
      hasExplicitAdultPreviewLabel({ ...entry, title: "成人内容 · 案例" }),
    ).toBe(true);
    expect(hasExplicitAdultPreviewLabel({ ...entry, tags: ["成人內容"] })).toBe(
      true,
    );
    expect(
      hasExplicitAdultPreviewLabel({
        ...entry,
        prompt: "An NSFW prompt label only in body",
        title: "Art portrait",
      }),
    ).toBe(false);
    expect(
      hasExplicitAdultPreviewLabel({
        ...entry,
        title: "Fashion and swimwear",
        tags: ["beach", "medical"],
      }),
    ).toBe(false);
    expect(
      hasExplicitAdultPreviewLabel({ ...entry, title: "NSFWish study" }),
    ).toBe(false);
  });

  it("times out only visible pending images and retries only on request", () => {
    vi.useFakeTimers();
    render(
      <PromptPreviewImage
        {...props}
        scrollRootRef={{ current: document.createElement("section") }}
      />,
    );
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS * 2));
    expect(screen.queryByText("原站图片暂时无法加载")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    intersect(observers[0]!);
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS - 1));
    expect(screen.getByRole("img")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("原站图片暂时无法加载")).toBeTruthy();
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS * 3));
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.src);
    fireEvent.load(screen.getByRole("img"));
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS * 2));
    expect(screen.queryByText("原站图片暂时无法加载")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cancels an old URL timeout when switching to a new image", () => {
    vi.useFakeTimers();
    const { rerender } = render(<PromptPreviewImage {...props} />);
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS - 1));
    rerender(
      <PromptPreviewImage {...props} src="https://example.com/new.png" />,
    );
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("原站图片暂时无法加载")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      "https://example.com/new.png",
    );
    fireEvent.load(screen.getByRole("img"));
    act(() => vi.advanceTimersByTime(PROMPT_IMAGE_TIMEOUT_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not fetch offscreen cards or use the global window as the scroll root", () => {
    const root = document.createElement("section");
    const rootRef = { current: root };
    render(
      <>
        <PromptPreviewImage {...props} scrollRootRef={rootRef} />
        <PromptPreviewImage
          {...props}
          title="Offscreen"
          src="https://example.com/two.png"
          scrollRootRef={rootRef}
        />
      </>,
    );
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(observers).toHaveLength(2);
    expect(observers[0]!.options).toEqual({
      root,
      rootMargin: "0px",
      threshold: 0.01,
    });
    intersect(observers[1]!, false);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    intersect(observers[0]!);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.src);
    expect(observers[0]!.disconnect).toHaveBeenCalled();
    expect(observers[1]!.disconnect).not.toHaveBeenCalled();
  });

  it("shows loading, displays the complete image and never fetches with an app credential", () => {
    const onZoom = vi.fn();
    render(<PromptPreviewImage {...props} onZoom={onZoom} />);
    expect(screen.getByText("正在加载原站图片…")).toBeTruthy();
    const img = screen.getByRole("img");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("src")).toBe(props.src);
    fireEvent.load(img);
    expect(screen.queryByRole("status")).toBeNull();
    expect(img.className).toContain("object-contain");
    expect(img.className).toContain("opacity-100");
    fireEvent.click(screen.getByRole("button", { name: "放大查看示例图" }));
    expect(onZoom).toHaveBeenCalledOnce();
  });

  it("recognizes already complete cache hits without waiting for a second load event", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      100,
    );
    render(<PromptPreviewImage {...props} onZoom={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "放大查看示例图" })).toBeTruthy();
  });

  it("retries the actual source URL without changing query signatures or selecting the card", () => {
    const select = vi.fn();
    render(
      <div onClick={select}>
        <PromptPreviewImage {...props} />
      </div>,
    );
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("原站图片暂时无法加载")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(entry.sourceUrl);
    fireEvent.click(screen.getByRole("button", { name: "重试图片" }));
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.src);
    fireEvent.load(screen.getByRole("img"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears error and loaded state when URL or item changes", () => {
    const { rerender } = render(<PromptPreviewImage {...props} />);
    fireEvent.error(screen.getByRole("img"));
    rerender(
      <PromptPreviewImage {...props} src="https://example.com/two.png" />,
    );
    expect(screen.queryByText("原站图片暂时无法加载")).toBeNull();
    expect(screen.getByText("正在加载原站图片…")).toBeTruthy();
    fireEvent.load(screen.getByRole("img"));
    rerender(
      <PromptPreviewImage
        {...props}
        title="Next item"
        src="https://example.com/two.png"
      />,
    );
    expect(screen.getByText("正在加载原站图片…")).toBeTruthy();
  });

  it("keeps a visible missing-image explanation and source link without a text-only replacement", () => {
    render(
      <PromptPreviewImage title={entry.title} sourceUrl={entry.sourceUrl} />,
    );
    expect(screen.getByText("暂无示例图")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "查看原始条目" }).getAttribute("rel"),
    ).toBe("noopener noreferrer");
    expect(screen.queryByRole("img")).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it("never observes or fetches when the intended scroll root is not attached", () => {
    render(<PromptPreviewImage {...props} scrollRootRef={{ current: null }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it("disconnects active observations on unmount", () => {
    const { unmount } = render(
      <PromptPreviewImage
        {...props}
        scrollRootRef={{ current: document.createElement("div") }}
      />,
    );
    unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it("keeps cover first, deduplicates gallery URLs, supports missing cover and bounds the gallery", () => {
    expect(
      promptPreviewUrls({
        ...entry,
        imageUrl: "https://example.com/one.png",
        previewImageUrls: [
          "https://example.com/two.png",
          "https://example.com/one.png",
        ],
      }),
    ).toEqual(["https://example.com/one.png", "https://example.com/two.png"]);
    expect(
      promptPreviewUrls({
        ...entry,
        previewImageUrls: ["https://example.com/two.png"],
      }),
    ).toEqual(["https://example.com/two.png"]);
    expect(
      promptPreviewUrls({
        ...entry,
        previewImageUrls: Array.from(
          { length: 15 },
          (_, index) => `https://example.com/${index}.png`,
        ),
      }),
    ).toHaveLength(8);
  });
});
