export type CanvasFileCandidate = {
  fileId: string;
  assetId?: string;
  storageUrl?: string;
  meta: Record<string, unknown>;
};

type QueueEntry = CanvasFileCandidate & { attempts: number };

export type CanvasFileLoadQueue = {
  enqueue(candidates: CanvasFileCandidate[]): void;
  dispose(): void;
};

export function canvasFileSourceKey(candidate: CanvasFileCandidate): string {
  return JSON.stringify([
    candidate.fileId,
    candidate.assetId ?? null,
    candidate.storageUrl ?? null,
  ]);
}

/**
 * The loader owns in-flight requests, so its React effect must only restart
 * when a file's readable source changes. Canvas refreshes deserialize fresh
 * files/elements objects even when they describe exactly the same assets.
 */
export function canvasFileSourcesKey(
  candidates: readonly CanvasFileCandidate[],
): string {
  return candidates
    .map(canvasFileSourceKey)
    .sort()
    .join("|");
}

type CanvasViewportElement = {
  type?: unknown;
  isDeleted?: unknown;
  fileId?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
};

type CanvasViewportState = {
  width?: unknown;
  height?: unknown;
  scrollX?: unknown;
  scrollY?: unknown;
  zoom?: { value?: unknown };
};

export function createCanvasFileLoadQueue(options: {
  load(candidate: CanvasFileCandidate, signal: AbortSignal): Promise<string>;
  onLoaded(candidate: CanvasFileCandidate, dataURL: string): void;
  onFailed?(candidate: CanvasFileCandidate, error: unknown): void;
  concurrency?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}): CanvasFileLoadQueue {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = Math.max(10, options.retryDelayMs ?? 400);
  const entries = new Map<string, QueueEntry>();
  const queuedIds = new Set<string>();
  const loadedIds = new Set<string>();
  const queue: QueueEntry[] = [];
  const controllers = new Set<AbortController>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = 0;
  let disposed = false;

  const pump = () => {
    if (disposed) return;
    while (active < concurrency && queue.length > 0) {
      const entry = queue.shift();
      if (!entry || loadedIds.has(entry.fileId)) continue;
      queuedIds.delete(entry.fileId);
      active += 1;
      entry.attempts += 1;
      const controller = new AbortController();
      controllers.add(controller);
      void options
        .load(entry, controller.signal)
        .then((dataURL) => {
          if (disposed) return;
          loadedIds.add(entry.fileId);
          entries.delete(entry.fileId);
          options.onLoaded(entry, dataURL);
        })
        .catch((error) => {
          if (disposed || controller.signal.aborted) return;
          if (entry.attempts < maxAttempts) {
            const delay = retryDelayMs * 2 ** (entry.attempts - 1);
            const timer = setTimeout(() => {
              timers.delete(timer);
              if (disposed || loadedIds.has(entry.fileId)) return;
              queuedIds.add(entry.fileId);
              queue.unshift(entry);
              pump();
            }, delay);
            timers.add(timer);
          } else {
            entries.delete(entry.fileId);
            options.onFailed?.(entry, error);
          }
        })
        .finally(() => {
          controllers.delete(controller);
          active -= 1;
          pump();
        });
    }
  };

  return {
    enqueue(candidates) {
      if (disposed) return;
      for (const candidate of candidates) {
        if (
          loadedIds.has(candidate.fileId) ||
          queuedIds.has(candidate.fileId) ||
          entries.has(candidate.fileId)
        ) {
          continue;
        }
        const entry = { ...candidate, attempts: 0 };
        entries.set(candidate.fileId, entry);
        queuedIds.add(candidate.fileId);
        queue.push(entry);
      }
      pump();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const controller of controllers) controller.abort();
      for (const timer of timers) clearTimeout(timer);
      controllers.clear();
      timers.clear();
    },
  };
}

export function visibleCanvasFileIds(
  elements: readonly CanvasViewportElement[],
  appState: CanvasViewportState,
  marginRatio = 0.75,
): string[] {
  const zoom = Math.max(0.01, Number(appState.zoom?.value ?? 1));
  const width = Math.max(1, Number(appState.width ?? 1920) / zoom);
  const height = Math.max(1, Number(appState.height ?? 1080) / zoom);
  const left = -Number(appState.scrollX ?? 0);
  const top = -Number(appState.scrollY ?? 0);
  const margin = Math.max(width, height) * marginRatio;
  const centerX = left + width / 2;
  const centerY = top + height / 2;

  return elements
    .filter((element) => {
      if (element.type !== "image" || element.isDeleted || !element.fileId) {
        return false;
      }
      const x = Number(element.x ?? 0);
      const y = Number(element.y ?? 0);
      const right = x + Number(element.width ?? 0);
      const bottom = y + Number(element.height ?? 0);
      return !(
        right < left - margin ||
        x > left + width + margin ||
        bottom < top - margin ||
        y > top + height + margin
      );
    })
    .sort((a, b) => {
      const distance = (element: CanvasViewportElement) => {
        const x = Number(element.x ?? 0) + Number(element.width ?? 0) / 2;
        const y = Number(element.y ?? 0) + Number(element.height ?? 0) / 2;
        return (x - centerX) ** 2 + (y - centerY) ** 2;
      };
      return distance(a) - distance(b);
    })
    .map((element) => String(element.fileId));
}
