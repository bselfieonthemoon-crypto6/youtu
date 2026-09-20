"use client";

import { motion } from "framer-motion";
import { Check, Copy, Pencil } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  BackgroundJob,
  ContentBlock,
  ToolArtifact,
  ToolBlock,
} from "@loomic/shared";
import type { RestoreJobToCanvasResponse } from "../lib/server-api";
import {
  AgentPlanView,
  getToolExecutionAnchorId,
  type AgentPlanBlock,
} from "./chat/agent-plan-view";
import { ImagePill } from "./chat/image-lightbox";
import { MarkdownRenderer } from "./chat/markdown-renderer";
import { MentionPill } from "./chat/mention-pill";
import { ProcessGroup } from "./chat/process-group";
import { ThinkingBlockView } from "./chat/thinking-block-view";
import {
  ToolBlockView,
  isProcessOnlyToolBlock,
  isToolBlockInProgress,
  isUnrenderedToolBlock,
  type ToolConfirmationKind,
} from "./chat/tool-block-view";

// Re-export types for backward compatibility with existing consumers
export type { ContentBlock, ToolArtifact };

/** @deprecated Use ToolBlock from @loomic/shared instead */
export type ToolActivity = ToolBlock;

/* ------------------------------------------------------------------ */
/*  ChatMessage                                                        */
/* ------------------------------------------------------------------ */

type ChatMessageProps = {
  role: "user" | "assistant";
  contentBlocks: ContentBlock[];
  isStreaming?: boolean;
  onConfirmAction?: (
    confirmationId: string,
    decision: "confirm" | "cancel",
    kind?: ToolConfirmationKind,
    /** Terminal answer of a click the server already acknowledged as `accepted`. */
    onTerminalAck?: (ack: { status: string; message?: string }) => void,
  ) => Promise<{ status: string; message?: string }> | undefined;
  onWaitGeneration?: (jobId: string) => Promise<BackgroundJob>;
  onRestoreGeneration?: (jobId: string) => Promise<RestoreJobToCanvasResponse>;
  onRetryRead?: (
    toolExecutionId: string,
  ) => Promise<{ status: string; message?: string }>;
  onOpenDesign?: (designId: string) => void;
  onEditSend?: (text: string) => Promise<void>;
  editDisabled?: boolean;
};

/**
 * Read-only preparation tools remain in the persisted transcript for audit
 * and model continuity, but are implementation details in the customer chat.
 */
const INTERNAL_PREPARATION_TOOLS = new Set([
  "discover_tools",
  "list_skills",
  "use_skill",
  "compose_skills",
  "search_prompt_library",
  "get_prompt_library_entry",
  "ask_clarification",
]);

export function isUserVisibleToolBlock(block: ToolBlock): boolean {
  return !INTERNAL_PREPARATION_TOOLS.has(block.toolName);
}

const INTERNAL_PREPARATION_NARRATION = [
  /\b(?:i(?:'ll|\s+will|\s+need\s+to|\s+am\s+going\s+to)|let\s+me)\b[\s\S]{0,180}\b(?:load|inspect|check|see|list|read|pick)\b[\s\S]{0,140}\b(?:skill|guide|catalog|tool|prompt)/i,
  /(?:我(?:先|需要|会|将)|先).{0,70}(?:查看|看全|读取|加载|搜索|检查|选择).{0,80}(?:技能|指南|目录|工具|提示词)/s,
];

export function hideInternalPreparationNarration(text: string): string {
  return text
    .split(/(\n\s*\n)/)
    .filter((part) =>
      /^\n\s*\n$/.test(part) ||
      !INTERNAL_PREPARATION_NARRATION.some((pattern) => pattern.test(part)),
    )
    .join("")
    .replace(/^(?:\s*\n)+|(?:\s*\n)+$/g, "");
}

/**
 * Top-level chat message component.
 *
 * Memoized with a custom comparator: skips re-render when contentBlocks
 * reference and isStreaming flag are unchanged. During streaming, only the
 * actively-streaming message receives new contentBlocks arrays; all prior
 * messages keep the same reference and skip rendering entirely.
 *
 * Sub-components (MarkdownRenderer, ToolBlockView, ThinkingBlockView) are
 * each independently memoized for fine-grained update control.
 */
export const ChatMessage = React.memo(
  function ChatMessage({
    role,
    contentBlocks,
    isStreaming,
    onConfirmAction,
    onWaitGeneration,
    onRestoreGeneration,
    onRetryRead,
    onOpenDesign,
    onEditSend,
    editDisabled,
  }: ChatMessageProps) {
    const isUser = role === "user";

    if (isUser) {
      return (
        <UserMessage
          contentBlocks={contentBlocks}
          {...(onEditSend ? { onEditSend } : {})}
          {...(editDisabled !== undefined ? { editDisabled } : {})}
        />
      );
    }

    return (
      <AssistantMessage
        contentBlocks={contentBlocks}
        isStreaming={isStreaming ?? false}
        {...(onConfirmAction ? { onConfirmAction } : {})}
        {...(onWaitGeneration ? { onWaitGeneration } : {})}
        {...(onRestoreGeneration ? { onRestoreGeneration } : {})}
        {...(onRetryRead ? { onRetryRead } : {})}
        {...(onOpenDesign ? { onOpenDesign } : {})}
      />
    );
  },
  (prev, next) => {
    // Custom comparator: referential equality on contentBlocks is sufficient
    // because updateSessionMessages always creates a new array when content changes
    return (
      prev.role === next.role &&
      prev.contentBlocks === next.contentBlocks &&
      prev.isStreaming === next.isStreaming &&
      prev.onConfirmAction === next.onConfirmAction &&
      prev.onWaitGeneration === next.onWaitGeneration &&
      prev.onRestoreGeneration === next.onRestoreGeneration &&
      prev.onRetryRead === next.onRetryRead &&
      prev.onOpenDesign === next.onOpenDesign &&
      prev.onEditSend === next.onEditSend &&
      prev.editDisabled === next.editDisabled
    );
  },
);

/* ------------------------------------------------------------------ */
/*  UserMessage                                                        */
/* ------------------------------------------------------------------ */

const UserMessage = React.memo(function UserMessage({
  contentBlocks,
  onEditSend,
  editDisabled = false,
}: {
  contentBlocks: ContentBlock[];
  onEditSend?: (text: string) => Promise<void>;
  editDisabled?: boolean;
}) {
  // Categorize blocks once per render
  const { text, imageBlocks, mentionBlocks } = useMemo(() => {
    const textParts: string[] = [];
    const images: ContentBlock[] = [];
    const mentions: ContentBlock[] = [];

    for (const block of contentBlocks) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        images.push(block);
      } else if (block.type === "mention") {
        mentions.push(block);
      }
    }

    return {
      text: textParts.join(""),
      imageBlocks: images,
      mentionBlocks: mentions,
    };
  }, [contentBlocks]);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">(
    "idle",
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitGuardRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    textareaRef.current?.focus({ preventScroll: true });
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [draft, isEditing]);

  const cancelEdit = useCallback(() => {
    if (isSubmitting) return;
    setDraft(text);
    setEditError(null);
    setIsEditing(false);
  }, [isSubmitting, text]);

  const submitEdit = useCallback(async () => {
    const value = draft.trim();
    if (!onEditSend || !value || editDisabled || submitGuardRef.current || isSubmitting) return;
    submitGuardRef.current = true;
    setIsSubmitting(true);
    setEditError(null);
    try {
      await onEditSend(draft);
      setIsEditing(false);
    } catch (error) {
      setEditError(
        error instanceof Error && error.message
          ? error.message
          : "发送失败，请重试",
      );
    } finally {
      submitGuardRef.current = false;
      setIsSubmitting(false);
    }
  }, [draft, editDisabled, isSubmitting, onEditSend]);

  const copyMessage = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }, [text]);

  const renderAttachments = () => (
    <>
      {mentionBlocks.length > 0 && (
        <span className="inline">
          {mentionBlocks.map((block, idx) => (
            <MentionPill
              key={idx}
              label={(block as { label: string }).label}
              kind={
                (block as { mentionType: "image-model" | "brand-kit-asset" })
                  .mentionType
              }
            />
          ))}
        </span>
      )}
      {imageBlocks.length > 0 && (
        <span className="inline">
          {imageBlocks.map((block, idx) => (
            <ImagePill
              key={idx}
              src={(block as { url: string }).url}
              name={(block as { name?: string }).name ?? `image-${idx + 1}`}
            />
          ))}
        </span>
      )}
    </>
  );

  const bubble = isEditing ? (
    <div className="w-full max-w-[min(100%,36rem)] rounded-xl bg-muted px-3 py-2.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submitEdit();
          }
        }}
        disabled={isSubmitting}
        aria-label="编辑消息"
        className="block max-h-[180px] min-h-[48px] w-full resize-none overflow-y-auto bg-transparent text-sm font-medium leading-6 text-foreground outline-none"
      />
      {renderAttachments()}
      {editError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {editError}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={cancelEdit} disabled={isSubmitting} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background/60" aria-label="取消编辑" title="取消">
          取消
        </button>
        <button type="button" onClick={() => void submitEdit()} disabled={editDisabled || isSubmitting || !draft.trim()} className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50" aria-label="发送编辑后的消息" title="发送">
          {isSubmitting ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  ) : text ? (
    <div className="inline-block max-w-full rounded-xl bg-muted px-3 py-2.5 whitespace-pre-wrap break-words text-sm font-medium leading-6 text-foreground">
      <span className="cursor-text select-text [word-break:break-word]">{text}</span>
      {renderAttachments()}
    </div>
  ) : (
    <div className="inline-block max-w-full rounded-xl bg-muted px-3 py-2.5">
      {renderAttachments()}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="flex w-full flex-col items-end gap-2 pl-10"
    >
      {bubble}
      <div className="flex items-center gap-1 text-muted-foreground">
        <button type="button" onClick={() => void copyMessage()} className="rounded-md p-1 hover:bg-muted" aria-label={copyState === "success" ? "已复制" : "复制消息"} title="复制">
          {copyState === "success" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        {onEditSend && (
          <button type="button" onClick={() => { setDraft(text); setEditError(null); setIsEditing(true); }} disabled={editDisabled || isEditing} className="rounded-md p-1 hover:bg-muted disabled:opacity-50" aria-label="编辑消息" title="编辑">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <span className="sr-only" aria-live="polite">
          {copyState === "success" ? "消息已复制" : copyState === "error" ? "复制失败" : ""}
        </span>
        {copyState === "error" && <span className="text-xs text-destructive" role="alert">复制失败，请选中文字复制</span>}
      </div>
    </motion.div>
  );
});

/* ------------------------------------------------------------------ */
/*  AssistantMessage                                                    */
/* ------------------------------------------------------------------ */

const AssistantMessage = React.memo(function AssistantMessage({
  contentBlocks,
  isStreaming,
  onConfirmAction,
  onWaitGeneration,
  onRestoreGeneration,
  onRetryRead,
  onOpenDesign,
}: {
  contentBlocks: ContentBlock[];
  isStreaming: boolean;
  onConfirmAction?: (
    confirmationId: string,
    decision: "confirm" | "cancel",
    kind?: ToolConfirmationKind,
    /** Terminal answer of a click the server already acknowledged as `accepted`. */
    onTerminalAck?: (ack: { status: string; message?: string }) => void,
  ) => Promise<{ status: string; message?: string }> | undefined;
  onWaitGeneration?: (jobId: string) => Promise<BackgroundJob>;
  onRestoreGeneration?: (jobId: string) => Promise<RestoreJobToCanvasResponse>;
  onRetryRead?: (
    toolExecutionId: string,
  ) => Promise<{ status: string; message?: string }>;
  onOpenDesign?: (designId: string) => void;
}) {
  const toolRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Process rows collapse by default, so the transcript reads as the user's words
   * plus the media that was delivered. Expansion is controlled here because a
   * plan step must be able to open the row that holds the tool it points at
   * before scrolling to it.
   */
  const [openProcessGroups, setOpenProcessGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const openProcessGroupsRef = useRef(openProcessGroups);
  openProcessGroupsRef.current = openProcessGroups;
  const processGroupByToolRef = useRef(new Map<string, string>());
  const pendingLocateRef = useRef<string | null>(null);
  const [highlightedToolCallId, setHighlightedToolCallId] = useState<
    string | null
  >(null);
  const internalToolBlocks = useMemo(
    () =>
      contentBlocks.filter(
        (block): block is ToolBlock =>
          block.type === "tool" && !isUserVisibleToolBlock(block),
      ),
    [contentBlocks],
  );
  const hasInternalPreparation = internalToolBlocks.length > 0;
  const internalPreparationRunning = internalToolBlocks.some(
    (block) => block.status === "running",
  );
  const hasThinkingBlock = contentBlocks.some((block) => block.type === "thinking");

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  const toolsByPlanStep = useMemo(() => {
    const result = new Map<string, Map<string, ToolBlock[]>>();
    for (const block of contentBlocks) {
      if (block.type !== "tool") continue;
      if (!isUserVisibleToolBlock(block)) continue;
      const linked = block as ToolBlock & {
        planId?: string;
        planStepId?: string;
      };
      if (!linked.planId || !linked.planStepId) continue;
      let byStep = result.get(linked.planId);
      if (!byStep) {
        byStep = new Map();
        result.set(linked.planId, byStep);
      }
      const tools = byStep.get(linked.planStepId) ?? [];
      tools.push(block);
      byStep.set(linked.planStepId, tools);
    }
    return result;
  }, [contentBlocks]);

  const scrollToTool = useCallback((toolCallId: string) => {
    const target = toolRefs.current.get(toolCallId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedToolCallId(toolCallId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedToolCallId((current) =>
        current === toolCallId ? null : current,
      );
    }, 1800);
  }, []);

  const toggleProcessGroup = useCallback((key: string) => {
    setOpenProcessGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** A plan step can point at a tool inside a collapsed row: open it first, then
   * scroll once the row has actually rendered the target. */
  const locateTool = useCallback(
    (toolCallId: string) => {
      const groupKey = processGroupByToolRef.current.get(toolCallId);
      if (groupKey && !openProcessGroupsRef.current.has(groupKey)) {
        pendingLocateRef.current = toolCallId;
        setOpenProcessGroups((previous) => new Set(previous).add(groupKey));
        return;
      }
      scrollToTool(toolCallId);
    },
    [scrollToTool],
  );

  useEffect(() => {
    const pending = pendingLocateRef.current;
    if (!pending || !toolRefs.current.has(pending)) return;
    pendingLocateRef.current = null;
    scrollToTool(pending);
  }, [openProcessGroups, scrollToTool]);

  const renderToolBlock = useCallback(
    (block: ToolBlock) => (
      <div
        key={block.toolCallId}
        id={getToolExecutionAnchorId(block.toolCallId)}
        ref={(node) => {
          if (node) toolRefs.current.set(block.toolCallId, node);
          else toolRefs.current.delete(block.toolCallId);
        }}
        data-plan-step-id={
          (block as ToolBlock & { planStepId?: string }).planStepId
        }
      >
        <ToolBlockView
          block={block}
          highlighted={highlightedToolCallId === block.toolCallId}
          {...(onConfirmAction ? { onConfirmAction } : {})}
          {...(onWaitGeneration ? { onWaitGeneration } : {})}
          {...(onRestoreGeneration ? { onRestoreGeneration } : {})}
          {...(onRetryRead ? { onRetryRead } : {})}
          {...(onOpenDesign ? { onOpenDesign } : {})}
        />
      </div>
    ),
    [
      highlightedToolCallId,
      onConfirmAction,
      onOpenDesign,
      onRestoreGeneration,
      onRetryRead,
      onWaitGeneration,
    ],
  );

  // Find the last text block index for streaming cursor placement
  const lastTextIdx = useMemo(() => {
    for (let i = contentBlocks.length - 1; i >= 0; i--) {
      const block = contentBlocks[i]!;
      if (
        block.type === "text" &&
        (!hasInternalPreparation || hideInternalPreparationNarration(block.text).trim())
      ) return i;
    }
    return -1;
  }, [contentBlocks, hasInternalPreparation]);

  // Show thinking indicator when streaming but no content has arrived yet
  const hasContent = useMemo(
    () =>
      contentBlocks.some(
        (b) =>
          (b.type === "text" &&
            (hasInternalPreparation
              ? hideInternalPreparationNarration(b.text).length > 0
              : b.text.length > 0)) ||
          b.type === "plan" ||
          (b.type === "tool" && isUserVisibleToolBlock(b)) ||
          b.type === "thinking" ||
          (b.type === "tool" && !isUserVisibleToolBlock(b)),
      ),
    [contentBlocks, hasInternalPreparation],
  );

  const showThinking = isStreaming && !hasContent;
  // Once text or tool output is visible, keep a quiet status affordance in
  // place while the run is still active. A trailing thinking block already
  // renders its own live indicator, so do not duplicate it here.
  const showProcessing =
    isStreaming &&
    hasContent &&
    contentBlocks.at(-1)?.type !== "thinking";

  /**
   * Conversation order is preserved: a run of process-only steps collapses into
   * one row, while text, plans, delivered media, confirmations and failures render
   * in place. `processGroupByToolRef` remembers which row holds which tool so a
   * plan step can open it before scrolling (see `locateTool`).
   */
  const renderItems: React.ReactNode[] = [];
  const groupByTool = new Map<string, string>();
  let pendingNodes: React.ReactNode[] = [];
  let pendingTools: ToolBlock[] = [];
  let pendingKey: string | null = null;
  const flushProcess = () => {
    if (!pendingNodes.length) return;
    const key = pendingKey ?? `process-${renderItems.length}`;
    for (const tool of pendingTools) groupByTool.set(tool.toolCallId, key);
    const nodes = pendingNodes;
    renderItems.push(
      <ProcessGroup
        key={key}
        count={nodes.length}
        open={openProcessGroups.has(key)}
        running={pendingTools.some(isToolBlockInProgress)}
        onToggle={() => toggleProcessGroup(key)}
      >
        {nodes}
      </ProcessGroup>,
    );
    pendingNodes = [];
    pendingTools = [];
    pendingKey = null;
  };

  contentBlocks.forEach((block, idx) => {
    if ((block as { type: string }).type === "plan") {
      flushProcess();
      renderItems.push(
        <AgentPlanView
          key={`plan-${(block as unknown as AgentPlanBlock).planId}`}
          block={block as unknown as AgentPlanBlock}
          toolsByStepId={
            toolsByPlanStep.get((block as unknown as AgentPlanBlock).planId) ??
            new Map()
          }
          onLocateTool={locateTool}
        />,
      );
      return;
    }

    if (block.type === "thinking") {
      renderItems.push(
        <ThinkingBlockView
          key={`thinking-${idx}`}
          thinking={block.thinking}
          isStreaming={isStreaming && idx === contentBlocks.length - 1}
        />,
      );
      return;
    }

    if (block.type === "text") {
      const visibleText = hasInternalPreparation
        ? hideInternalPreparationNarration(block.text)
        : block.text;
      if (!visibleText.trim()) return;
      flushProcess();
      renderItems.push(
        <MarkdownRenderer
          key={idx}
          text={visibleText}
          showCursor={isStreaming && idx === lastTextIdx}
        />,
      );
      return;
    }

    if (block.type === "tool") {
      if (!isUserVisibleToolBlock(block)) return;
      if (isUnrenderedToolBlock(block)) return;
      if (isProcessOnlyToolBlock(block)) {
        pendingKey = pendingKey ?? `process-${block.toolCallId}`;
        pendingTools.push(block);
        pendingNodes.push(renderToolBlock(block));
        return;
      }
      flushProcess();
      renderItems.push(renderToolBlock(block));
    }
    // ImageBlock -- skip in assistant messages (user-side only)
  });
  flushProcess();
  processGroupByToolRef.current = groupByTool;

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="flex w-full flex-col gap-2 pr-10"
    >
      {showThinking && (
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>{"\u601d\u8003\u4e2d"}</span>
          <span
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce-dot"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce-dot"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground animate-bounce-dot"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      )}
      {hasInternalPreparation && !hasThinkingBlock && (
        <div
          role={internalPreparationRunning ? "status" : undefined}
          aria-live={internalPreparationRunning ? "polite" : undefined}
          className="flex items-center gap-2 text-xs text-muted-foreground/70"
        >
          <span aria-hidden="true">{internalPreparationRunning ? "◌" : "✓"}</span>
          <span>{internalPreparationRunning ? "正在分析中" : "分析完成"}</span>
        </div>
      )}
      {renderItems}
      {showProcessing && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-1 text-xs text-muted-foreground/70"
        >
          <span>处理中</span>
          <span
            aria-hidden="true"
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce-dot"
            style={{ animationDelay: "0ms" }}
          />
          <span
            aria-hidden="true"
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce-dot"
            style={{ animationDelay: "150ms" }}
          />
          <span
            aria-hidden="true"
            className="inline-block h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce-dot"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      )}
    </motion.div>
  );
});
