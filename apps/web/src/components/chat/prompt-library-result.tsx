"use client";

import {
  promptLibraryEntrySchema,
  promptLibrarySourceSchema,
  promptPreviewUrlSchema,
  type PromptLibraryEntry,
  type PromptLibrarySource,
} from "@loomic/shared";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { useState } from "react";

import {
  hasExplicitAdultPreviewLabel,
  PromptPreviewImage,
  PromptPreviewNotice,
  promptPreviewUrls,
} from "../prompt-library/prompt-preview-image";

type PromptLibraryTool = "search_prompt_library" | "get_prompt_library_entry";
type Candidate = {
  entry: PromptLibraryEntry;
  source: PromptLibrarySource;
  fullPrompt: boolean;
};

export function isPromptLibraryTool(name: string): name is PromptLibraryTool {
  return (
    name === "search_prompt_library" || name === "get_prompt_library_entry"
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The shared URL guard also rejects local/private literal addresses. Tool
// outputs restored from old chats are untrusted and bypass HTTP response parsing.
function publicUrl(value: unknown): string | undefined {
  const parsed = promptPreviewUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readSource(value: unknown): PromptLibrarySource | null {
  const parsed = promptLibrarySourceSchema.safeParse(value);
  if (!parsed.success || !publicUrl(parsed.data.url)) return null;
  const { licenseUrl, ...source } = parsed.data;
  const safeLicenseUrl = publicUrl(licenseUrl);
  return {
    ...source,
    ...(safeLicenseUrl ? { licenseUrl: safeLicenseUrl } : {}),
  };
}

function readCandidate(
  value: unknown,
  source: PromptLibrarySource | null,
  fullPrompt: boolean,
): Candidate | null {
  const raw = record(value);
  if (
    !raw ||
    !source ||
    source.status !== "available" ||
    raw.sourceId !== source.id
  )
    return null;
  const sourceUrl = publicUrl(raw.sourceUrl);
  if (!sourceUrl) return null;
  // A bad preview URL must not suppress an otherwise usable title/source. Drop
  // invalid previews before parsing the entry and never use any as inputImages.
  const { imageUrl: rawImage, previewImageUrls: rawPreviews, ...rest } = raw;
  const imageUrl = publicUrl(rawImage);
  const previewImageUrls = Array.isArray(rawPreviews)
    ? rawPreviews
        .slice(0, 8)
        .map(publicUrl)
        .filter((url): url is string => Boolean(url))
    : [];
  const parsed = promptLibraryEntrySchema.safeParse({
    ...rest,
    sourceUrl,
    prompt: fullPrompt ? raw.prompt : raw.promptExcerpt,
    ...(imageUrl ? { imageUrl } : {}),
    ...(previewImageUrls.length ? { previewImageUrls } : {}),
  });
  return parsed.success ? { entry: parsed.data, source, fullPrompt } : null;
}

function SourceOnly({ source }: { source: PromptLibrarySource }) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-2.5 text-[11px] leading-relaxed">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
      >
        {source.name}
        <ArrowUpRight className="size-3" />
      </a>
      <p className="text-muted-foreground">仅来源链接 · {source.license}</p>
      <p className="text-muted-foreground">{source.note}</p>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const { entry, source, fullPrompt } = candidate;
  const [revealed, setRevealed] = useState(false);
  const hiddenAdultImage = hasExplicitAdultPreviewLabel(entry) && !revealed;
  return (
    <article
      aria-label={`提示词案例：${entry.title}`}
      className="overflow-hidden rounded-xl border border-border bg-background"
    >
      {hiddenAdultImage ? (
        <PromptPreviewNotice
          onReveal={() => setRevealed(true)}
          sourceUrl={entry.sourceUrl}
          className="min-h-[150px]"
        />
      ) : (
        <PromptPreviewImage
          src={promptPreviewUrls(entry)[0]}
          title={entry.title}
          sourceUrl={entry.sourceUrl}
          className="aspect-[4/3] max-h-[220px]"
        />
      )}
      <div className="space-y-2 px-3 py-2.5">
        <h4 className="line-clamp-2 text-xs font-semibold leading-relaxed break-words">
          {entry.title}
        </h4>
        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5">
            {entry.category}
          </span>
          {entry.requiresReference && (
            <span className="rounded bg-muted px-1.5 py-0.5">需参考图</span>
          )}
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          来源：
          <a
            href={entry.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            {source.name}
          </a>
        </p>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
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
        {entry.modelHints.length > 0 && (
          <p className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
            来源标注模型：{entry.modelHints.join("、")}；不代表已切换当前模型。
          </p>
        )}
        {fullPrompt ? (
          <details className="rounded-lg bg-muted/35 px-2.5 py-2">
            <summary className="cursor-pointer text-[11px] font-medium">
              查看提示词原文
            </summary>
            <pre className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed">
              {entry.prompt}
            </pre>
          </details>
        ) : (
          <div>
            <p className="text-[10px] text-muted-foreground">提示词摘录</p>
            <p className="mt-0.5 line-clamp-4 break-words text-[11px] leading-relaxed text-muted-foreground">
              {entry.prompt}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

/** Presentation only: no fetch, generation, prompt insertion or canvas callbacks. */
export function PromptLibraryResult({
  toolName,
  output,
}: { toolName: PromptLibraryTool; output: unknown }) {
  const raw = record(output);
  if (raw?.status === "unavailable")
    return (
      <p
        role="status"
        className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
      >
        提示词库暂时不可用，请稍后重试。
      </p>
    );
  if (raw?.status === "not_found")
    return (
      <p
        role="status"
        className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
      >
        没有找到该提示词案例，可重新搜索。
      </p>
    );
  if (raw?.status !== "ok")
    return (
      <p
        role="status"
        className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
      >
        暂时没有可展示的提示词结果。
      </p>
    );

  const metadata = Array.isArray(raw.sources)
    ? raw.sources
        .slice(0, 30)
        .map(readSource)
        .filter((source): source is PromptLibrarySource => Boolean(source))
    : [];
  const sourceMap = new Map<string, PromptLibrarySource>();
  for (const source of metadata) {
    // Conflicting restored metadata must fail closed: any link-only declaration
    // for a source wins, even if a later duplicate claims it is available.
    if (sourceMap.get(source.id)?.status !== "link_only") {
      sourceMap.set(source.id, source);
    }
  }
  const linkOnly = new Map(
    metadata
      .filter((source) => source.status === "link_only")
      .map((source) => [source.id, source]),
  );
  const candidates: Candidate[] = [];
  if (toolName === "get_prompt_library_entry") {
    const nestedSource = readSource(raw.source);
    const source =
      nestedSource?.status === "link_only"
        ? nestedSource
        : nestedSource
          ? (sourceMap.get(nestedSource.id) ?? nestedSource)
          : null;
    if (source?.status === "link_only") linkOnly.set(source.id, source);
    const candidate = readCandidate(raw.item, source, true);
    if (candidate) candidates.push(candidate);
  } else if (Array.isArray(raw.items)) {
    const seen = new Set<string>();
    for (const value of raw.items.slice(0, 12)) {
      const item = record(value);
      const nestedSource = readSource(item?.source);
      const source =
        nestedSource?.status === "link_only"
          ? nestedSource
          : nestedSource
            ? (sourceMap.get(nestedSource.id) ?? nestedSource)
            : null;
      if (source?.status === "link_only") linkOnly.set(source.id, source);
      const candidate = readCandidate(value, source, false);
      if (candidate && !seen.has(candidate.entry.id)) {
        seen.add(candidate.entry.id);
        candidates.push(candidate);
      }
    }
  }
  const total =
    typeof raw.total === "number" &&
    Number.isInteger(raw.total) &&
    raw.total >= candidates.length &&
    raw.total <= 10000
      ? raw.total
      : candidates.length;
  return (
    <section aria-label="提示词库结果" className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <BookOpen className="size-3.5" />
        <span>
          {toolName === "get_prompt_library_entry"
            ? `已读取 ${candidates.length} 条案例原文`
            : `找到 ${total} 个案例 · 展示 ${candidates.length} 个`}
        </span>
      </div>
      {candidates.length > 0 ? (
        <div
          className={`grid gap-2 ${toolName === "search_prompt_library" ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {candidates.map((candidate) => (
            <CandidateCard
              key={`${candidate.entry.id}:${candidate.entry.imageUrl ?? ""}`}
              candidate={candidate}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          没有可展示的开放案例，试试其他关键词。
        </p>
      )}
      {linkOnly.size > 0 && (
        <details className="rounded-lg border border-border p-2.5">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            其他来源（{linkOnly.size} 个仅外链）
          </summary>
          <div className="mt-2 space-y-2">
            {[...linkOnly.values()].map((source) => (
              <SourceOnly key={source.id} source={source} />
            ))}
          </div>
        </details>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        仅供风格参考 ·
        尚未应用到画布或生成图片。示例图不是用户参考图，来源标注模型不保证跨模型效果。
      </p>
    </section>
  );
}
