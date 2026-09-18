import type { LoomicSceneV1 } from "@loomic/shared";

import {
  type DesignResourceApiClient,
  DesignResourceApiError,
} from "./design-resource-api";

export type DesignFontReference = {
  faceId: string;
  family: string;
  style: "normal" | "italic" | "oblique";
  weight: string;
};

export type DesignFontIssue = DesignFontReference & {
  reason: "missing" | "embedding_forbidden" | "load_failed";
  message: string;
};

export type DesignFontLoadResult = {
  loadedFaceIds: string[];
  issues: DesignFontIssue[];
};

const loadedFaces = new Map<string, Promise<void>>();

/** Finds durable font references even when a future scene object embeds children. */
export function collectDesignFontReferences(
  scene: LoomicSceneV1,
): DesignFontReference[] {
  const references = new Map<string, DesignFontReference>();
  const visited = new Set<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const record = value as Record<string, unknown>;
    const faceId = readString(record, "fontFaceId", "font_face_id");
    if (faceId) {
      const family =
        readString(record, "fontFamily", "font_family") ?? "sans-serif";
      const rawStyle = readString(record, "fontStyle", "font_style");
      const style =
        rawStyle === "italic" || rawStyle === "oblique" ? rawStyle : "normal";
      const rawWeight = record.fontWeight ?? record.font_weight;
      references.set(`${faceId}:${family}:${style}:${String(rawWeight ?? 400)}`, {
        faceId,
        family,
        style,
        weight:
          typeof rawWeight === "number" || typeof rawWeight === "string"
            ? String(rawWeight)
            : "400",
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(scene.objects);
  return [...references.values()];
}

export async function loadDesignSceneFonts(input: {
  scene: LoomicSceneV1;
  accessToken: string;
  client: Pick<DesignResourceApiClient, "getFontFaceContent">;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<DesignFontLoadResult> {
  const references = collectDesignFontReferences(input.scene);
  const loadedFaceIds: string[] = [];
  const issues: DesignFontIssue[] = [];
  let index = 0;
  const worker = async () => {
    for (;;) {
      const reference = references[index++];
      if (!reference) return;
      try {
        await loadOneFace(reference, input);
        loadedFaceIds.push(reference.faceId);
      } catch (error) {
        issues.push(toIssue(reference, error));
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          Math.max(input.concurrency ?? 3, 1),
          references.length,
        ),
      },
      () => worker(),
    ),
  );
  await globalThis.document.fonts?.ready;
  return { loadedFaceIds, issues };
}

async function loadOneFace(
  reference: DesignFontReference,
  input: {
    accessToken: string;
    client: Pick<DesignResourceApiClient, "getFontFaceContent">;
    signal?: AbortSignal;
  },
) {
  const cacheKey = `${reference.faceId}:${reference.family}:${reference.style}:${reference.weight}`;
  const cached = loadedFaces.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    const source = await input.client.getFontFaceContent(
      input.accessToken,
      reference.faceId,
      input.signal,
    );
    const url = URL.createObjectURL(source);
    try {
      const loaded = await new FontFace(reference.family, `url(${url})`, {
        style: reference.style,
        weight: reference.weight,
      }).load();
      globalThis.document.fonts.add(loaded);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  loadedFaces.set(cacheKey, pending);
  try {
    await pending;
  } catch (error) {
    loadedFaces.delete(cacheKey);
    throw error;
  }
}

function toIssue(
  reference: DesignFontReference,
  error: unknown,
): DesignFontIssue {
  if (error instanceof DesignResourceApiError && error.status === 403) {
    return {
      ...reference,
      reason: "embedding_forbidden",
      message: `字体「${reference.family}」禁止网页嵌入，请选择替代字体。`,
    };
  }
  if (error instanceof DesignResourceApiError && error.status === 404) {
    return {
      ...reference,
      reason: "missing",
      message: `字体「${reference.family}」已缺失，请选择替代字体。`,
    };
  }
  return {
    ...reference,
    reason: "load_failed",
    message: `字体「${reference.family}」加载失败，请重试或选择替代字体。`,
  };
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Test-only escape hatch representing a fresh browser cache. */
export function resetDesignFontLoaderCache() {
  loadedFaces.clear();
}
