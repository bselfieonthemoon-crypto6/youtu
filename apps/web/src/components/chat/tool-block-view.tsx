"use client";

import { motion } from "framer-motion";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BackgroundJob, ImageArtifact, ToolBlock } from "@loomic/shared";
import { readGenerationJobElementId } from "../../hooks/use-job-fallback-polling";
import { useGenerationCanvasPresence } from "./generation-canvas-presence";
import type { RestoreJobToCanvasResponse } from "../../lib/server-api";
import { ChatImage } from "./image-lightbox";
import { imageProposalDestination } from "../../lib/image-proposal-destination";
import { isPromptLibraryTool, PromptLibraryResult } from "./prompt-library-result";
import {
  formatModelDisplayName,
  formatOutputPreview,
  formatParamName,
  formatParamValue,
  getToolConfig,
  isHumanReadable,
} from "./utils";

/* ------------------------------------------------------------------ */
/*  ToolIcon                                                           */
/* ------------------------------------------------------------------ */

function ToolIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const cls = className ?? "h-3.5 w-3.5";
  switch (type) {
    case "eye":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
          <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      );
    case "image":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
        </svg>
      );
    case "video":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
      );
    case "palette":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 0 0 3.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.88 2.88M6.75 17.25h.008v.008H6.75v-.008Z" />
        </svg>
      );
    case "search":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
      );
    case "brush":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
        </svg>
      );
    default:
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437" />
        </svg>
      );
  }
}

/* ------------------------------------------------------------------ */
/*  findSidebarRect — locate the chatbar container for panel placement */
/* ------------------------------------------------------------------ */

function findSidebarRect(el: HTMLElement | null): DOMRect | null {
  let node = el;
  while (node) {
    if (node.style.width && node.classList.contains("shrink-0")) {
      return node.getBoundingClientRect();
    }
    node = node.parentElement;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  ToolBlockView — main card in chatbar + floating detail panel       */
/* ------------------------------------------------------------------ */

export const ToolBlockView = React.memo(function ToolBlockView({
  block,
  onConfirmAction,
  highlighted = false,
  onWaitGeneration,
  onRestoreGeneration,
  onRetryRead,
  onOpenDesign,
}: {
  block: ToolBlock;
  highlighted?: boolean;
  onConfirmAction?: (
    confirmationId: string,
    decision: "confirm" | "cancel",
    kind?: ConfirmationDetails["kind"],
  ) => Promise<{ status: string; message?: string }> | undefined;
  onWaitGeneration?: (jobId: string) => Promise<BackgroundJob>;
  onRestoreGeneration?: (jobId: string) => Promise<RestoreJobToCanvasResponse>;
  onRetryRead?: (
    toolExecutionId: string,
  ) => Promise<{ status: string; message?: string }>;
  onOpenDesign?: (designId: string) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const readCanvasPresence = useGenerationCanvasPresence();
  const [panelRight, setPanelRight] = useState(416);
  const containerRef = useRef<HTMLDivElement>(null);

  const config = getToolConfig(block.toolName);
  const status = block.status as
    | "running"
    | "completed"
    | "failed"
    | "canceled";
  const isCompleted = status === "completed";
  const hasOutput = block.output && Object.keys(block.output).length > 0;
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const hasDetails = hasOutput || hasInput;

  const cardTitle =
    block.outputSummary && isHumanReadable(block.outputSummary)
      ? block.outputSummary
      : config.label;

  const previewLines = block.output ? formatOutputPreview(block.output) : [];
  const showCard =
    config.showCard && isCompleted && (block.outputSummary || hasOutput);

  // Extract artifacts for generate_image / generate_video inline preview
  const imageArtifact = block.artifacts?.find(
    (artifact): artifact is ImageArtifact => artifact.type === "image",
  );
  const isImageProposalTool = block.toolName === "generate_image";
  const isPreparingImageProposal =
    isImageProposalTool &&
    !isCompleted &&
    !(block.output as Record<string, unknown> | undefined)?.jobId &&
    (block.output as Record<string, unknown> | undefined)?.status !==
      "submitting";
  const isImageTool =
    isImageProposalTool || block.toolName === "edit_image" || block.toolName === "confirm_image_generation";
  const isVideoTool = block.toolName === "generate_video";
  const isMediaTool = isImageTool || isVideoTool;
  const mediaErrorOutput = block.output as Record<string, unknown> | undefined;
  const mediaError =
    isMediaTool && isCompleted && !imageArtifact
      ? (mediaErrorOutput?.error as string | undefined)
      : undefined;
  const inputValidationFailure = isMediaTool && !block.output?.jobId &&
    !!block.output?.validationErrors &&
    typeof block.output?.message === "string" &&
    block.output.message.startsWith("Tool input validation failed");
  const inputData = block.input as Record<string, unknown> | undefined;
  const modelName = inputData?.model as string | undefined;
  const aspectRatio =
    (inputData?.aspectRatio as string) ?? (isVideoTool ? "16:9" : "1:1");
  const isConversationalImageProposal = Boolean(
    isImageProposalTool &&
      isCompleted &&
      ((block.output as Record<string, unknown> | undefined)?.status ===
        "awaiting_confirmation" ||
        (block.output as Record<string, unknown> | undefined)?.error ===
          "confirmation_required"),
  );
  const isInternalImageConfirmation =
    block.toolName === "confirm_image_generation" &&
    ((block.status === "failed" && !block.output) ||
      (block.output as Record<string, unknown> | undefined)?.status === "awaiting_ui_confirmation");
  const confirmation = readConfirmation(block);
  const hasForegroundDisclosure = confirmation?.kind === "image_generation"
    && confirmation.details.foregroundPolicy !== undefined;
  const designResult = readDesignToolResult(block);
  const generatedDesignTarget = readGeneratedDesignTarget(block);
  const designFinalizationNotice = readDesignFinalizationNotice(block);
  const displayStatus =
    designResult?.status === "failed" || designResult?.status === "conflict"
      ? "failed"
      : status;
  const billing = readBillingSummary(block.output);
  const imageCostReceipt = readImageCostReceipt(block.output);
  const generation = readGenerationRecovery(block);
  const [observedJob, setObservedJob] = useState<BackgroundJob | null>(null);
  const [recoveryState, setRecoveryState] = useState<
    "idle" | "waiting" | "restoring" | "restored" | "error"
  >("idle");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [readRetryState, setReadRetryState] = useState<
    "idle" | "retrying" | "completed" | "failed"
  >("idle");
  const [readRetryError, setReadRetryError] = useState<string | null>(null);
  const canRetryRead = Boolean(
    block.toolName === "inspect_canvas" &&
      block.status === "failed" &&
      block.retryable === true &&
      block.toolExecutionId &&
      onRetryRead,
  );

  const handleRetryRead = useCallback(async () => {
    if (!canRetryRead || !block.toolExecutionId || !onRetryRead) return;
    if (readRetryState === "retrying" || readRetryState === "completed") return;
    setReadRetryState("retrying");
    setReadRetryError(null);
    try {
      const result = await onRetryRead(block.toolExecutionId);
      if (result.status === "completed") {
        setReadRetryState("completed");
      } else {
        setReadRetryState("failed");
        setReadRetryError(result.message ?? "重新读取失败");
      }
    } catch (error) {
      setReadRetryState("failed");
      setReadRetryError(
        error instanceof Error ? error.message : "重新读取失败",
      );
    }
  }, [block.toolExecutionId, canRetryRead, onRetryRead, readRetryState]);

  useEffect(() => {
    setObservedJob(null);
    setRecoveryState("idle");
    setRecoveryError(null);
  }, [generation.jobId]);

  const observedElementId = observedJob
    ? readGenerationJobElementId(observedJob)
    : null;
  const effectiveElementId =
    recoveryState === "restored"
      ? generation.jobId
      : (observedElementId ?? generation.elementId);
  const terminalFailure = observedJob
    ? ["failed", "dead_letter", "canceled"].includes(observedJob.status)
    : generation.terminalFailure || status === "failed" || status === "canceled";
  const generationCanceled = observedJob ? observedJob.status === "canceled" : generation.canceled || status === "canceled";
  const terminalError = terminalFailure
    ? generationCanceled ? "任务已取消，不会将后续结果放入画布" : observedJob?.error_message || String(block.output?.error || "生成失败，任务已停止")
    : null;
  // The card body is server-authored copy: the server writes `summary` next to
  // the decision it describes, while `error` is a machine code. The code only
  // survives as a fallback for receipts persisted before summaries existed.
  // A cancellation keeps its own fixed copy and is never rewritten from a summary.
  const mediaErrorBody =
    (generationCanceled ? undefined : readNonEmptyString(mediaErrorOutput?.summary)) ??
    terminalError ??
    mediaError ??
    "生成失败，任务已停止";
  // `refused` is an explicit server field for a receipt returned before any
  // submission attempt. Nothing was created and nothing was charged, so this is
  // not a generation failure. The field is only ever honored when it is exactly
  // `true`; a missing field means "not a refusal".
  const mediaErrorRefused =
    !generationCanceled && mediaErrorOutput?.refused === true;
  const succeeded = observedJob?.status === "succeeded" || generation.succeeded;
  const observedResult = observedJob?.result as Record<string, unknown> | null | undefined;
  const attachmentRejected =
    (block.output as Record<string, unknown> | undefined)?.attachment_status ===
      "superseded" || observedResult?.attachment_status === "superseded";
  const isDesignGeneration =
    observedJob?.target_kind === "design" ||
    generatedDesignTarget !== null ||
    designFinalizationNotice !== null ||
    Boolean(
      readNonEmptyString(
        (block.output as Record<string, unknown> | undefined)?.design_id,
      ),
    );
  const showContinueWaiting = Boolean(
    isMediaTool &&
      generation.jobId &&
      !effectiveElementId &&
      !terminalFailure &&
      !succeeded &&
      generation.canContinue,
  );
  const canvasPresence = readCanvasPresence();
  const showRestore = Boolean(
    isMediaTool &&
      generation.jobId &&
      succeeded &&
      !effectiveElementId &&
      canvasPresence !== null &&
      !canvasPresence.has(generation.jobId) &&
      !terminalFailure &&
      !attachmentRejected &&
      !isDesignGeneration,
  );

  const handleContinueWaiting = useCallback(async () => {
    if (!generation.jobId || !onWaitGeneration || recoveryState !== "idle")
      return;
    setRecoveryState("waiting");
    setRecoveryError(null);
    try {
      const job = await onWaitGeneration(generation.jobId);
      setObservedJob(job);
      setRecoveryState("idle");
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : "等待生成结果失败",
      );
      setRecoveryState("error");
    }
  }, [generation.jobId, onWaitGeneration, recoveryState]);

  const handleRestore = useCallback(async () => {
    if (!generation.jobId || !onRestoreGeneration) return;
    if (recoveryState === "restoring" || recoveryState === "restored") return;
    const presence = readCanvasPresence();
    if (!presence || presence.has(generation.jobId)) return;
    setRecoveryState("restoring");
    setRecoveryError(null);
    try {
      await onRestoreGeneration(generation.jobId);
      setRecoveryState("restored");
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : "恢复到画布失败",
      );
      setRecoveryState("error");
    }
  }, [generation.jobId, onRestoreGeneration, recoveryState, readCanvasPresence]);

  const handleOpenPanel = useCallback(() => {
    const rect = findSidebarRect(containerRef.current);
    if (rect) {
      setPanelRight(window.innerWidth - rect.left + 12);
    }
    setPanelOpen(true);
  }, []);

  const handleClosePanel = useCallback(() => setPanelOpen(false), []);
  const handleRefreshImage = useCallback(async () => {
    if (!imageArtifact?.jobId || !onWaitGeneration) return null;
    const job = await onWaitGeneration(imageArtifact.jobId);
    const refreshedUrl = job.result?.signed_url;
    return typeof refreshedUrl === "string" && refreshedUrl
      ? refreshedUrl
      : null;
  }, [imageArtifact?.jobId, onWaitGeneration]);

  // Image preparation is intentionally represented by the assistant's natural
  // language reply. Hiding the internal tool block avoids presenting a proposal
  // as a failed generation or as a technical parameter card.
  // An extra paid stage must be visible in the actual generate_image path;
  // a conversational summary alone is not a reliable cost disclosure.
  if ((isConversationalImageProposal && !hasForegroundDisclosure) || isInternalImageConfirmation) return null;
  if (isConversationalImageProposal && hasForegroundDisclosure
    && !readImageForegroundPolicyDisclosure(confirmation?.details.foregroundPolicy)) {
    return <p role="alert" className="text-xs text-amber-800">图片处理步骤或费用信息不完整，请重新创建方案后确认；本次未提交生成。</p>;
  }
  if (block.toolName === "delegate_design_tasks" || block.toolName === "record_task_workflow" || block.toolName === "select_next_workflow_step") return null;
  // Read-only catalog output is not a generation artifact or confirmation.
  // Never expose generic raw JSON, download controls or action callbacks here.
  if (isPromptLibraryTool(block.toolName)) return (
    <div ref={containerRef} className={`space-y-1.5 rounded-lg ${highlighted ? "bg-accent/10 shadow-[0_0_0_2px_hsl(var(--accent))]" : ""}`}>
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><ToolStatusIcon status={status} /><span className="font-medium">{config.label}{status === "failed" ? " · 失败" : status === "canceled" ? " · 已取消" : ""}</span></div>
      {isCompleted ? <PromptLibraryResult toolName={block.toolName} output={block.output} /> : status === "failed" || status === "canceled" ? <p className="text-xs text-muted-foreground">{status === "failed" ? "提示词读取未完成，请稍后重试。" : "已取消本次提示词读取。"}</p> : null}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`space-y-1.5 rounded-lg transition-[box-shadow,background-color] ${
        highlighted ? "bg-accent/10 shadow-[0_0_0_2px_hsl(var(--accent))]" : ""
      }`}
    >
      {/* Layer 1: Status line */}
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ToolStatusIcon status={displayStatus} />
        <span className="font-medium text-muted-foreground truncate">
          {isPreparingImageProposal
            ? "正在准备图片方案（尚未生成）"
            : isMediaTool && modelName
              ? formatModelDisplayName(modelName)
              : config.label}
          {designResult?.status === "conflict"
            ? " · 冲突"
            : status === "failed"
              ? " · 失败"
              : status === "canceled"
                ? " · 已取消"
                : ""}
        </span>
      </div>

      {confirmation && (
        <ConfirmationCard
          confirmation={confirmation}
          {...(onConfirmAction ? { onConfirmAction } : {})}
        />
      )}

      {canRetryRead && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          {readRetryState === "completed" ? (
            <p className="text-xs font-medium text-emerald-700">
              已重新读取画布
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void handleRetryRead()}
              disabled={readRetryState === "retrying"}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
            >
              {readRetryState === "retrying" ? "正在重新读取…" : "重新读取"}
            </button>
          )}
          {readRetryError && (
            <p className="mt-1 text-xs text-red-600">{readRetryError}</p>
          )}
        </div>
      )}

      {/* Layer 2a: Media generation shimmer placeholder */}
      {isMediaTool && !isCompleted && !isPreparingImageProposal && !terminalFailure && (
        <MediaShimmer
          isVideoTool={isVideoTool}
          aspectRatio={aspectRatio}
          modelName={modelName}
        />
      )}

      {/* Layer 2b-err: Media generation failed */}
      {inputValidationFailure && (
        <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
          <p className="font-medium">参数需要调整</p>
          <p className="mt-1 text-xs text-muted-foreground">本次调用尚未提交生图，未调用图片接口。Agent 可修正参数后继续。</p>
        </div>
      )}
      {!inputValidationFailure && isMediaTool && (terminalError || (isCompleted && !imageArtifact && (mediaError || mediaErrorRefused))) && (
        <MediaErrorCard isVideoTool={isVideoTool} canceled={generationCanceled} refused={mediaErrorRefused} error={mediaErrorBody} />
      )}

      {/* Layer 2b: Image generation card with inline preview */}
      {designResult && !confirmation ? (
        <DesignToolResultCard
          result={designResult}
          {...(onOpenDesign ? { onOpenDesign } : {})}
        />
      ) : isImageTool && isCompleted && imageArtifact && !terminalFailure ? (
        <ImageArtifactCard
          artifact={imageArtifact}
          cardTitle={cardTitle}
          modelName={modelName}
          hasDetails={!!hasDetails}
          onOpenPanel={handleOpenPanel}
          onRefreshImage={handleRefreshImage}
        />
      ) : showCard && !mediaErrorRefused ? (
        /* Layer 2: Generic output card (non-image tools) */
        <div className="rounded-xl border-[0.5px] border-border p-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 rounded-lg bg-muted p-1.5 text-muted-foreground">
              <ToolIcon type={config.icon} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground line-clamp-1">
                {cardTitle}
              </div>
              {previewLines.length > 0 && (
                <div className="mt-0.5 space-y-px">
                  {previewLines.map((line, i) => (
                    <div
                      key={i}
                      className="text-[11px] text-muted-foreground truncate"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {hasDetails && (
            <button
              type="button"
              onClick={handleOpenPanel}
              className="mt-2 flex items-center gap-0.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.78 11.78a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 0-1.06l3.5-3.5a.75.75 0 0 1 1.06 1.06L6.56 8l3.22 3.22a.75.75 0 0 1 0 1.06Z" />
              </svg>
              查看详情
            </button>
          )}
        </div>
      ) : null}

      {isMediaTool && billing && <BillingSummary billing={billing} />}
      {isMediaTool && imageCostReceipt && <ImageCostReceipt receipt={imageCostReceipt} />}

      {generatedDesignTarget ? (
        <GeneratedDesignTargetCard
          target={generatedDesignTarget}
          {...(onOpenDesign ? { onOpenDesign } : {})}
        />
      ) : null}

      {designFinalizationNotice ? (
        <DesignFinalizationNoticeCard
          notice={designFinalizationNotice}
          {...(onOpenDesign ? { onOpenDesign } : {})}
        />
      ) : null}

      {(showContinueWaiting ||
        showRestore ||
        recoveryState === "restoring") && (
        <div className="rounded-lg border border-border bg-muted/40 p-2.5">
          <button
            type="button"
            onClick={() =>
              void (showRestore ? handleRestore() : handleContinueWaiting())
            }
            disabled={
              recoveryState === "waiting" ||
              recoveryState === "restoring" ||
              (showRestore ? !onRestoreGeneration : !onWaitGeneration)
            }
            className="w-full rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {recoveryState === "waiting"
              ? "等待生成结果…"
              : recoveryState === "restoring"
                ? "正在恢复到画布…"
                : showRestore
                  ? "放入画布"
                  : "继续等待"}
          </button>
        </div>
      )}

      {recoveryState === "restored" && (
        <p className="text-xs font-medium text-emerald-700">已恢复到画布</p>
      )}
      {recoveryError && (
        <p role="alert" className="text-xs text-red-600">
          {recoveryError}
        </p>
      )}

      {/* Floating detail panel */}
      {panelOpen &&
        hasDetails &&
        createPortal(
          <ToolDetailPanel
            block={block}
            rightOffset={panelRight}
            onClose={handleClosePanel}
          />,
          document.body,
        )}
    </div>
  );
});

/**
 * A tool step that produced nothing the user must see or act on: a canvas read, a
 * submitted-but-pending image task, its cost receipt, a plan step's bookkeeping.
 *
 * The transcript groups exactly these into a collapsed process row so the chat
 * reads as text plus the media that was delivered. Everything that would be
 * dishonest or unusable to hide stays in the open:
 * a confirmation the user must answer, delivered media, a delivered design, and
 * every failure, cancellation, refusal or invalid-input receipt.
 */
export function isProcessOnlyToolBlock(block: ToolBlock): boolean {
  if (readConfirmation(block)) return false;
  if ((block.artifacts ?? []).some(artifact => artifact.type === "image" || artifact.type === "video")) return false;
  if (readGeneratedDesignTarget(block) || readDesignFinalizationNotice(block)) return false;
  // A failure is a fact about the user's request, not process detail.
  if (block.status === "failed" || block.status === "canceled") return false;
  const designResult = readDesignToolResult(block);
  if (designResult && designResult.status !== "completed") return false;
  const output = block.output as Record<string, unknown> | undefined;
  if (readNonEmptyString(output?.error)) return false;
  if (output?.refused === true) return false;
  if (output?.validationErrors) return false;
  return true;
}

/**
 * Tool blocks this transcript never renders: their work is already represented by
 * the assistant's own words (or by a pending confirmation elsewhere). Grouping has
 * to skip them too, otherwise a collapsed process row would open onto nothing.
 */
export function isUnrenderedToolBlock(block: ToolBlock): boolean {
  if (
    block.toolName === "delegate_design_tasks" ||
    block.toolName === "record_task_workflow" ||
    block.toolName === "select_next_workflow_step"
  ) {
    return true;
  }
  const output = block.output as Record<string, unknown> | undefined;
  const confirmation = readConfirmation(block);
  const hasForegroundDisclosure =
    confirmation?.kind === "image_generation" &&
    confirmation.details.foregroundPolicy !== undefined;
  const isConversationalImageProposal = Boolean(
    block.toolName === "generate_image" &&
      block.status === "completed" &&
      (output?.status === "awaiting_confirmation" ||
        output?.error === "confirmation_required"),
  );
  if (isConversationalImageProposal && !hasForegroundDisclosure) return true;
  return (
    block.toolName === "confirm_image_generation" &&
    ((block.status === "failed" && !block.output) ||
      output?.status === "awaiting_ui_confirmation")
  );
}

/**
 * A grouped step whose job is still running. The collapsed row keeps a live label
 * from this, because that row is the only place the pending work is described.
 */
export function isToolBlockInProgress(block: ToolBlock): boolean {
  if (block.status === "running") return true;
  const output = block.output as Record<string, unknown> | undefined;
  const reported =
    typeof output?.jobStatus === "string"
      ? output.jobStatus
      : typeof output?.status === "string"
        ? output.status
        : null;
  return (
    reported === "queued" ||
    reported === "processing" ||
    reported === "running" ||
    reported === "submitting"
  );
}

const DESIGN_TOOL_NAMES = new Set([
  "inspect_design",
  "get_design_objects",
  "manipulate_design",
  "search_design_resources",
  "apply_design_template",
  "export_design",
]);

type DesignToolResultDetails = {
  toolName: string;
  status: "completed" | "conflict" | "failed" | "queued";
  title: string;
  detail: string | null;
  designId: string | null;
};

function readDesignToolResult(
  block: ToolBlock,
): DesignToolResultDetails | null {
  if (!DESIGN_TOOL_NAMES.has(block.toolName) || block.status === "running")
    return null;
  const output = block.output ?? {};
  const outputStatus = readNonEmptyString(output.status);
  const nestedDesign = readRecord(output.design) ?? output;
  const designId =
    readNonEmptyString(output.design_id) ??
    readNonEmptyString(nestedDesign?.id) ??
    readNonEmptyString(block.input?.design_id) ??
    null;
  const revision =
    readFiniteNumber(output.revision) ??
    readFiniteNumber(output.latest_revision) ??
    readFiniteNumber(output.current_revision) ??
    readFiniteNumber(nestedDesign?.revision);
  const message = readNonEmptyString(output.message);

  // Confirmation is still pending. The inline confirmation card is the only
  // source of truth until the server returns a later applied result.
  if (outputStatus === "confirmation_required") return null;

  if (
    outputStatus === "conflict" ||
    output.code === "design_conflict" ||
    output.code === "design_revision_conflict" ||
    output.code === "design_object_version_conflict" ||
    output.code === "template_revision_conflict"
  ) {
    const conflicts = Array.isArray(output.conflict_object_ids)
      ? output.conflict_object_ids.length
      : 0;
    return {
      toolName: block.toolName,
      status: "conflict",
      title: "设计版本冲突",
      detail: `服务器已是版本 ${revision ?? "更新版本"}${conflicts > 0 ? ` · ${conflicts} 个对象冲突` : ""}。请让 Agent 重新读取设计后再修改。`,
      designId,
    };
  }

  if (
    block.status === "failed" ||
    outputStatus === "failed" ||
    outputStatus === "dead_letter" ||
    outputStatus === "error"
  ) {
    return {
      toolName: block.toolName,
      status: "failed",
      title: "设计操作失败",
      detail: message ?? "设计工具未完成，请重试。",
      designId,
    };
  }

  if (block.toolName === "inspect_design") {
    const summary = readRecord(output.summary);
    const count =
      readFiniteNumber(output.object_count) ??
      readFiniteNumber(summary?.object_count);
    const size =
      readFiniteNumber(nestedDesign?.width) !== undefined &&
      readFiniteNumber(nestedDesign?.height) !== undefined
        ? `${nestedDesign?.width} × ${nestedDesign?.height}`
        : null;
    return {
      toolName: block.toolName,
      status: "completed",
      title: `已读取设计${readNonEmptyString(nestedDesign?.name) ? `「${readNonEmptyString(nestedDesign?.name)}」` : ""}`,
      detail:
        [
          revision !== undefined ? `版本 ${revision}` : null,
          size,
          count !== undefined ? `${count} 个对象` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      designId,
    };
  }

  if (block.toolName === "get_design_objects") {
    const count = Array.isArray(output.objects) ? output.objects.length : null;
    return {
      toolName: block.toolName,
      status: "completed",
      title: "已读取设计对象",
      detail:
        [
          revision !== undefined ? `版本 ${revision}` : null,
          count !== null ? `本页 ${count} 个对象` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      designId,
    };
  }

  if (block.toolName === "manipulate_design") {
    const changed = Array.isArray(output.changed_object_ids)
      ? output.changed_object_ids.length
      : null;
    return {
      toolName: block.toolName,
      status: "completed",
      title: output.replayed === true ? "设计修改已安全重放" : "设计修改完成",
      detail:
        [
          revision !== undefined ? `版本 ${revision}` : null,
          changed !== null ? `${changed} 个对象已更新` : null,
          output.replayed === true ? "未重复执行" : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      designId,
    };
  }

  if (block.toolName === "search_design_resources") {
    const count = Array.isArray(output.items) ? output.items.length : 0;
    return {
      toolName: block.toolName,
      status: "completed",
      title: `找到 ${count} 个可用资源`,
      detail: output.next_cursor ? "还有更多结果" : "已显示本次搜索结果",
      designId: null,
    };
  }

  if (block.toolName === "export_design") {
    const exportState = outputStatus ?? "queued";
    const exportTitle =
      exportState === "succeeded"
        ? "设计导出完成"
        : exportState === "canceled"
          ? "设计导出已取消"
          : exportState === "running"
            ? "正在导出设计"
            : "设计导出已排队";
    return {
      toolName: block.toolName,
      status:
        exportState === "queued" || exportState === "running"
          ? "queued"
          : "completed",
      title: exportTitle,
      detail:
        [
          readNonEmptyString(output.job_id)
            ? `任务 ${readNonEmptyString(output.job_id)}`
            : null,
          revision !== undefined ? `版本 ${revision}` : null,
          output.replayed === true ? "未重复创建任务" : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      designId,
    };
  }

  return {
    toolName: block.toolName,
    status: "completed",
    title: "设计模板已套用",
    detail: revision !== undefined ? `当前版本 ${revision}` : null,
    designId,
  };
}

function DesignToolResultCard({
  result,
  onOpenDesign,
}: {
  result: DesignToolResultDetails;
  onOpenDesign?: (designId: string) => void;
}) {
  const isProblem = result.status === "conflict" || result.status === "failed";
  const openableDesignId = result.designId;
  return (
    <div
      role={isProblem ? "alert" : undefined}
      className={`rounded-xl border p-3 ${
        result.status === "conflict"
          ? "border-amber-300 bg-amber-50"
          : result.status === "failed"
            ? "border-red-300 bg-red-50"
            : "border-border bg-card"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-lg bg-muted p-1.5 text-muted-foreground">
          <ToolIcon
            type={getToolConfig(result.toolName).icon}
            className="h-4 w-4"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {result.title}
          </div>
          {result.detail ? (
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {result.detail}
            </p>
          ) : null}
        </div>
      </div>
      {openableDesignId && onOpenDesign ? (
        <button
          type="button"
          onClick={() => onOpenDesign(openableDesignId)}
          className="mt-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          打开设计
        </button>
      ) : null}
    </div>
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

type GeneratedDesignTarget = {
  designId: string;
  objectId: string | null;
  revision: number | null;
};

function readGeneratedDesignTarget(
  block: ToolBlock,
): GeneratedDesignTarget | null {
  if (
    block.status !== "completed" ||
    (block.toolName !== "generate_image" && block.toolName !== "edit_image" &&
      block.toolName !== "confirm_image_generation")
  )
    return null;
  const output = block.output;
  if (!output) return null;
  if (
    typeof output.finalization_status === "string" &&
    output.finalization_status !== "completed"
  )
    return null;
  const finalization = readRecord(output.finalization);
  const result = readRecord(output.result);
  const designId =
    readNonEmptyString(output.design_id) ??
    readNonEmptyString(output.designId) ??
    readNonEmptyString(finalization?.design_id) ??
    readNonEmptyString(finalization?.designId) ??
    readNonEmptyString(result?.design_id) ??
    readNonEmptyString(result?.designId);
  if (!designId) return null;
  return {
    designId,
    objectId:
      readNonEmptyString(output.object_id) ??
      readNonEmptyString(output.objectId) ??
      readNonEmptyString(finalization?.object_id) ??
      readNonEmptyString(result?.object_id) ??
      null,
    revision:
      readFiniteNumber(output.revision) ??
      readFiniteNumber(finalization?.revision) ??
      readFiniteNumber(result?.revision) ??
      null,
  };
}

type DesignFinalizationNotice = {
  designId: string;
  status: "needs_attention" | "failed";
  message: string;
};

function readDesignFinalizationNotice(
  block: ToolBlock,
): DesignFinalizationNotice | null {
  if (
    block.status !== "completed" ||
    (block.toolName !== "generate_image" && block.toolName !== "edit_image" &&
      block.toolName !== "confirm_image_generation")
  )
    return null;
  const output = block.output;
  if (!output) return null;
  const status = output.finalization_status;
  if (status !== "needs_attention" && status !== "failed") return null;
  const designId =
    readNonEmptyString(output.design_id) ??
    readNonEmptyString(readRecord(output.finalization)?.design_id);
  if (!designId) return null;
  return {
    designId,
    status,
    message:
      readNonEmptyString(output.error) ??
      "图片素材已保存，但没有应用到原生设计。请打开原设计并根据当前版本重新放置；不要重新生成图片。",
  };
}

function DesignFinalizationNoticeCard({
  notice,
  onOpenDesign,
}: {
  notice: DesignFinalizationNotice;
  onOpenDesign?: (designId: string) => void;
}) {
  return (
    <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="text-sm font-semibold text-amber-950">
        {notice.status === "failed"
          ? "图片已生成，但应用到设计失败"
          : "图片已生成，但尚未应用到设计"}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-900">
        {notice.message}
      </p>
      {onOpenDesign ? (
        <button
          type="button"
          onClick={() => onOpenDesign(notice.designId)}
          className="mt-2 rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 transition-colors hover:bg-amber-100"
        >
          打开原设计
        </button>
      ) : null}
    </div>
  );
}

function GeneratedDesignTargetCard({
  target,
  onOpenDesign,
}: {
  target: GeneratedDesignTarget;
  onOpenDesign?: (designId: string) => void;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
      <div className="text-sm font-semibold text-emerald-950">
        图片已插入设计
      </div>
      <p className="mt-1 text-[11px] text-emerald-800">
        {[
          target.revision !== null ? `版本 ${target.revision}` : null,
          target.objectId ? `对象 ${target.objectId}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "设计已通过服务端同步更新"}
      </p>
      {onOpenDesign ? (
        <button
          type="button"
          onClick={() => onOpenDesign(target.designId)}
          className="mt-2 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-950 transition-colors hover:bg-emerald-100"
        >
          打开设计
        </button>
      ) : null}
    </div>
  );
}

type GenerationRecoveryDetails = {
  jobId: string | null;
  elementId: string | null;
  canContinue: boolean;
  succeeded: boolean;
  terminalFailure: boolean;
  canceled: boolean;
};

function readGenerationRecovery(block: ToolBlock): GenerationRecoveryDetails {
  const output = block.output as Record<string, unknown> | undefined;
  const jobId =
    typeof output?.jobId === "string" && output.jobId ? output.jobId : null;
  const elementId =
    typeof output?.elementId === "string" && output.elementId
      ? output.elementId
      : null;
  const error = typeof output?.error === "string" ? output.error : "";
  const reportedStatus =
    typeof output?.jobStatus === "string"
      ? output.jobStatus
      : typeof output?.status === "string"
        ? output.status
        : null;
  const terminalFailure =
    reportedStatus === "failed" ||
    reportedStatus === "dead_letter" ||
    reportedStatus === "canceled";
  const hasGeneratedMedia =
    typeof output?.imageUrl === "string" ||
    typeof output?.videoUrl === "string";
  const succeeded =
    reportedStatus === "succeeded" || (hasGeneratedMedia && !error);
  return {
    jobId,
    elementId,
    canContinue:
      reportedStatus === "processing" ||
      reportedStatus === "queued" ||
      block.status === "running" ||
      error.toLowerCase().includes("timed out") ||
      error.toLowerCase().includes("still being generated"),
    succeeded,
    terminalFailure,
    canceled: reportedStatus === "canceled",
  };
}

type BillingDetails = {
  estimate: number;
  charged: number;
  balanceAfter: number;
  currency: "credits";
};

function readBillingSummary(
  output: Record<string, unknown> | undefined,
): BillingDetails | null {
  if (!output) return null;
  const raw = output.billing;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const billing = raw as Record<string, unknown>;
  if (
    typeof billing.estimate !== "number" ||
    !Number.isFinite(billing.estimate) ||
    typeof billing.charged !== "number" ||
    !Number.isFinite(billing.charged) ||
    typeof billing.balanceAfter !== "number" ||
    !Number.isFinite(billing.balanceAfter) ||
    billing.currency !== "credits"
  ) {
    return null;
  }

  return {
    estimate: billing.estimate,
    charged: billing.charged,
    balanceAfter: billing.balanceAfter,
    currency: "credits",
  };
}

function BillingSummary({ billing }: { billing: BillingDetails }) {
  return (
    <div
      aria-label="生成积分明细"
      className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground"
    >
      <span>预计 {billing.estimate} 积分</span>
      <span className="font-medium text-foreground">
        已扣 {billing.charged} 积分
      </span>
      <span>余额 {billing.balanceAfter}</span>
    </div>
  );
}

type ImageCostReceipt =
  | { state: "known"; creditsCost: number; pricingVersion: string; actualQuality: string; actualResolution: string }
  | { state: "unavailable" };

/** Direct image tools return this only after durable submission. It is a cost
 * receipt, not a claim that a preflight failure, cancellation or refund charged.
 *
 * An INCOMPLETE receipt is reported as unavailable rather than as nothing. The old
 * reader returned `null` whenever a field was missing, so a submitted job's card
 * simply had no cost line at all — and a user can reasonably read that silence as
 * "this one was free". A campaign turn hit exactly that shape: the assistant said
 * it could not confirm the cost while the card showed no cost information
 * whatsoever. Silence is only correct for a result that never had a receipt
 * (preflight failure, cancellation, refund), which is the `null` branch below. */
function readImageCostReceipt(output: Record<string, unknown> | undefined): ImageCostReceipt | null {
  if (!output || !["queued", "processing", "succeeded", "finished"].includes(String(output.status))) return null;
  const creditsCost = readFiniteNumber(output.creditsCost);
  const pricingVersion = readNonEmptyString(output.pricingVersion);
  const actualQuality = readNonEmptyString(output.actualQuality);
  const actualResolution = readNonEmptyString(output.actualResolution);
  if (creditsCost === undefined || creditsCost < 0 || !Number.isInteger(creditsCost) || !pricingVersion || !actualQuality || !actualResolution)
    return { state: "unavailable" };
  return { state: "known", creditsCost, pricingVersion, actualQuality, actualResolution };
}

function ImageCostReceipt({ receipt }: { receipt: ImageCostReceipt }) {
  if (receipt.state === "unavailable")
    return <div aria-label="图片任务成本回执" className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
      {/* No number, no price basis, no implied zero: the job was submitted, so a
          cost exists somewhere, and claiming one we cannot read would be worse
          than saying so. */}
      <span>费用数据暂不可用</span>
    </div>;
  return <div aria-label="图片任务成本回执" className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
    <span>本次任务 {receipt.creditsCost} 积分</span><span>计价 {receipt.pricingVersion}</span><span>质量 {receipt.actualQuality}</span><span>分辨率 {receipt.actualResolution}</span>
  </div>;
}

export type ToolConfirmationKind =
  | "delete"
  | "image_generation"
  | "design_mutation"
  | "design_template_apply";

type ConfirmationDetails = {
  confirmationId: string;
  kind: ToolConfirmationKind;
  details: Record<string, unknown>;
  targets: unknown[];
};

function readConfirmation(block: ToolBlock): ConfirmationDetails | null {
  const output = block.output;
  if (!output) return null;
  if (
    output.error !== "confirmation_required" &&
    output.status !== "confirmation_required" &&
    output.status !== "awaiting_confirmation"
  )
    return null;
  const raw = output.confirmation;
  const structured = readRecord(raw);
  const confirmationId =
    readNonEmptyString(structured?.confirmationId) ??
    readNonEmptyString(output.confirmation_id);
  if (typeof confirmationId !== "string" || !confirmationId) return null;
  const targets = structured?.targets;
  const rawKind = readNonEmptyString(structured?.kind);
  const kind =
    rawKind === "image_generation"
      ? "image_generation"
      : block.toolName === "apply_design_template"
        ? "design_template_apply"
        : block.toolName === "manipulate_design"
          ? "design_mutation"
          : "delete";
  const details = structured?.details ?? output;
  return {
    confirmationId,
    kind,
    details:
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : {},
    targets: Array.isArray(targets) ? targets : [],
  };
}

function ToolStatusIcon({
  status,
}: { status: "running" | "completed" | "failed" | "canceled" }) {
  if (status === "running") {
    return (
      <span
        aria-label="执行中"
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground"
      />
    );
  }
  if (status === "failed") {
    return (
      <svg
        aria-label="失败"
        className="h-3.5 w-3.5 shrink-0 text-red-600"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path d="m4 4 8 8m0-8-8 8" />
      </svg>
    );
  }
  if (status === "canceled") {
    return (
      <svg
        aria-label="已取消"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <circle cx="8" cy="8" r="5.5" />
        <path d="M5 8h6" />
      </svg>
    );
  }
  return (
    <svg
      aria-label="已完成"
      className="h-3.5 w-3.5 shrink-0 text-emerald-600"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function ConfirmationCard({
  confirmation,
  onConfirmAction,
}: {
  confirmation: ConfirmationDetails;
  onConfirmAction?: (
    confirmationId: string,
    decision: "confirm" | "cancel",
    kind?: ConfirmationDetails["kind"],
  ) => Promise<{ status: string; message?: string }> | undefined;
}) {
  const [confirmationStatus, setConfirmationStatus] = useState<
    "pending" | "submitting" | "applied" | "canceled" | "failed"
  >("pending");
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const isImageGeneration = confirmation.kind === "image_generation";
  const isDesignConfirmation =
    confirmation.kind === "design_mutation" ||
    confirmation.kind === "design_template_apply";

  const submitDecision = async (decision: "confirm" | "cancel") => {
    if (!onConfirmAction || confirmationStatus !== "pending") return;
    setConfirmationStatus("submitting");
    const result = await (isDesignConfirmation
      ? onConfirmAction(
          confirmation.confirmationId,
          decision,
          confirmation.kind,
        )
      : onConfirmAction(confirmation.confirmationId, decision));
    const status = result?.status;
    if (status === "accepted" || status === "applied") {
      setConfirmationStatus("applied");
    } else if (status === "canceled") setConfirmationStatus("canceled");
    else {
      setConfirmationStatus("failed");
      setFailureMessage(result?.message ?? "操作未执行，请重新发起。 ");
    }
  };

  return (
    <div
      className={`rounded-xl border p-3 ${
        isImageGeneration || isDesignConfirmation
          ? "border-amber-300 bg-amber-50 text-amber-950"
          : "border-red-300 bg-red-50 text-red-950"
      }`}
    >
      <div className="text-sm font-semibold">
        {isImageGeneration
          ? "生成前确认"
          : confirmation.kind === "design_template_apply"
            ? "确认套用设计模板"
            : confirmation.kind === "design_mutation"
              ? "确认修改设计"
              : "需要确认危险操作"}
      </div>
      <p
        className={`mt-1 text-xs leading-5 ${
          isImageGeneration || isDesignConfirmation
            ? "text-amber-800"
            : "text-red-800"
        }`}
      >
        {isImageGeneration
          ? "请检查下面的图片描述与生成参数。只有点击确认后才会调用图片模型。"
          : confirmation.kind === "design_template_apply"
            ? "套用模板会替换当前设计场景。确认后由服务端按当前版本执行，并保留审计记录。"
            : confirmation.kind === "design_mutation"
              ? "此操作会删除或替换设计内容。确认后由服务端按当前版本执行。"
              : "将删除下列画布内容。新生成结果不会覆盖旧内容；只有点击确认后才会执行删除。"}
      </p>
      {isImageGeneration ? (
        <ImageGenerationConfirmationDetails details={confirmation.details} />
      ) : isDesignConfirmation ? (
        <DesignConfirmationDetails
          kind={confirmation.kind}
          details={confirmation.details}
        />
      ) : confirmation.targets.length > 0 ? (
        <div className="mt-2 max-h-24 overflow-y-auto rounded-lg bg-white/70 px-2 py-1.5 text-[11px] text-red-800">
          {confirmation.targets.slice(0, 5).map((target, index) => (
            <div key={index} className="truncate">
              {formatConfirmationTarget(target)}
            </div>
          ))}
        </div>
      ) : null}
      {confirmationStatus === "applied" ? (
        <p className="mt-3 text-xs font-medium text-emerald-700">
          {isImageGeneration
            ? "已确认，图片生成任务已提交"
            : isDesignConfirmation
              ? "已确认，正在应用设计更改"
              : "已确认并删除"}
        </p>
      ) : confirmationStatus === "canceled" ? (
        <p className="mt-3 text-xs font-medium text-muted-foreground">
          {isImageGeneration
            ? "已取消，未生成图片"
            : isDesignConfirmation
              ? "已取消，设计未修改"
              : "已取消，画布未修改"}
        </p>
      ) : confirmationStatus === "failed" ? (
        <p className="mt-3 text-xs font-medium text-red-700">
          {failureMessage}
        </p>
      ) : null}
      {(confirmationStatus === "pending" ||
        confirmationStatus === "submitting") && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void submitDecision("cancel")}
            disabled={!onConfirmAction || confirmationStatus === "submitting"}
            className={`rounded-lg border bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
              isImageGeneration || isDesignConfirmation
                ? "border-amber-200"
                : "border-red-200"
            }`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submitDecision("confirm")}
            disabled={!onConfirmAction || confirmationStatus === "submitting"}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
              isImageGeneration || isDesignConfirmation
                ? "bg-amber-600"
                : "bg-red-600"
            }`}
          >
            {isImageGeneration
              ? "确认生成"
              : confirmation.kind === "design_template_apply"
                ? "确认套用"
                : confirmation.kind === "design_mutation"
                  ? "确认修改"
                  : "确认删除"}
          </button>
        </div>
      )}
    </div>
  );
}

function ImageGenerationConfirmationDetails({
  details,
}: {
  details: Record<string, unknown>;
}) {
  const destination = imageProposalDestination(details);
  const foregroundPolicy = readImageForegroundPolicyDisclosure(
    details.foregroundPolicy,
  );
  const rows = [
    ["输出位置", destination],
    ["标题", details.title],
    ["详细描述", details.description],
    ["模型", details.model],
    ["画面比例", details.aspectRatio],
    ["质量", details.quality],
    ["格式", details.outputFormat],
    ["参考图数量", details.referenceImageCount],
  ].filter((row) => row[1] !== undefined && row[1] !== null);

  return (
    <div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-lg bg-white/75 px-3 py-2 text-[11px] text-amber-900">
      {rows.map(([label, value]) => (
        <div key={String(label)}>
          <div className="font-semibold">{String(label)}</div>
          <div className="mt-0.5 whitespace-pre-wrap break-words leading-5">
            {String(value)}
          </div>
        </div>
      ))}
      {foregroundPolicy ? (
        <div
          aria-label="前景处理与费用"
          className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2"
        >
          <div className="font-semibold">前景处理与费用</div>
          <div className="mt-1 whitespace-pre-wrap break-words leading-5">
            {foregroundPolicy.summary}
          </div>
          <div className="mt-1 font-medium">
            服务调用（{foregroundPolicy.providerCalls} 次）：
            {foregroundPolicy.mode === "api_matting"
              ? `${foregroundPolicy.generationModel} → ${foregroundPolicy.mattingModel}`
              : foregroundPolicy.generationModel}
          </div>
          <div className="mt-1 font-semibold">
            合计 {foregroundPolicy.totalCredits} 积分
          </div>
          <div className="mt-1 text-amber-800">
            {foregroundPolicy.billingNote}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ImageForegroundPolicyDisclosure = {
  mode: "native_transparent" | "api_matting";
  generationModel: string;
  mattingModel: string;
  totalCredits: number;
  providerCalls: 1 | 2;
  summary: string;
  billingNote: string;
};

/** Confirmation output is untrusted JSON. Only render a complete, internally
 * consistent server disclosure; React then treats every value as plain text. */
function readImageForegroundPolicyDisclosure(
  value: unknown,
): ImageForegroundPolicyDisclosure | null {
  const policy = readRecord(value);
  if (!policy) return null;
  const mode = policy.mode;
  const generationModel = readNonEmptyString(policy.generationModel);
  const mattingModel = readNonEmptyString(policy.mattingModel);
  const summary = readNonEmptyString(policy.summary);
  const billingNote = readNonEmptyString(policy.billingNote);
  const generationCredits = readFiniteNumber(policy.generationCredits);
  const mattingCredits = readFiniteNumber(policy.mattingCredits);
  const totalCredits = readFiniteNumber(policy.totalCredits);
  const providerCalls = readFiniteNumber(policy.providerCalls);
  if (
    policy.version !== 1 ||
    (mode !== "native_transparent" && mode !== "api_matting") ||
    policy.pricingVersion !== "credits-v1" ||
    !generationModel ||
    !mattingModel ||
    !summary ||
    !billingNote ||
    generationCredits === undefined ||
    mattingCredits === undefined ||
    totalCredits === undefined ||
    !Number.isInteger(generationCredits) ||
    !Number.isInteger(mattingCredits) ||
    !Number.isInteger(totalCredits) ||
    generationCredits < 0 ||
    mattingCredits < 0 ||
    totalCredits !== generationCredits + mattingCredits ||
    providerCalls !== (mode === "api_matting" ? 2 : 1) ||
    (mode === "native_transparent" &&
      (generationModel !== mattingModel || mattingCredits !== 0))
  )
    return null;
  return {
    mode,
    generationModel,
    mattingModel,
    totalCredits,
    providerCalls,
    summary,
    billingNote,
  };
}

function DesignConfirmationDetails({
  kind,
  details,
}: {
  kind: ToolConfirmationKind;
  details: Record<string, unknown>;
}) {
  const designId = readNonEmptyString(details.design_id);
  const templateId = readNonEmptyString(details.template_id);
  const revision = readFiniteNumber(details.expected_revision);
  const actions = Array.isArray(details.actions)
    ? details.actions.filter(
        (action): action is string => typeof action === "string",
      )
    : [];
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-white/75 px-3 py-2 text-[11px] text-amber-900">
      <div>
        {kind === "design_template_apply" ? "替换当前设计场景" : "修改设计内容"}
      </div>
      {revision !== undefined ? <div>基于版本 {revision}</div> : null}
      {actions.length > 0 ? <div>操作：{actions.join("、")}</div> : null}
      {designId ? <div className="truncate">设计：{designId}</div> : null}
      {templateId ? <div className="truncate">模板：{templateId}</div> : null}
    </div>
  );
}

function formatConfirmationTarget(target: unknown): string {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object" || Array.isArray(target))
    return "未知画布元素";
  const record = target as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label : null;
  const type = typeof record.type === "string" ? record.type : "元素";
  const id = typeof record.elementId === "string" ? record.elementId : null;
  return label ?? (id ? `${type} · ${id}` : type);
}

/* ------------------------------------------------------------------ */
/*  MediaShimmer — shimmer placeholder during media generation         */
/* ------------------------------------------------------------------ */

const MediaShimmer = React.memo(function MediaShimmer({
  isVideoTool,
  aspectRatio,
  modelName,
}: {
  isVideoTool: boolean;
  aspectRatio: string;
  modelName: string | undefined;
}) {
  return (
    <div className="rounded-xl border-[0.5px] border-border overflow-hidden">
      <div
        className="relative w-full max-h-[280px] overflow-hidden"
        style={{ aspectRatio: aspectRatio.replace(":", " / ") }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted">
          {isVideoTool ? (
            <svg
              className="h-10 w-10 text-muted-foreground/50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          ) : (
            <svg
              className="h-10 w-10 text-muted-foreground/50"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          )}
        </div>
        {/* Shimmer scan effect */}
        <div className="absolute inset-0 animate-shimmer-scan">
          <div
            className="h-full w-1/2"
            style={{
              background:
                "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)",
            }}
          />
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="text-[12px] font-medium text-muted-foreground/70">
          {isVideoTool
            ? "\u89c6\u9891\u751f\u6210\u4e2d..."
            : "\u56fe\u7247\u751f\u6210\u4e2d..."}
        </div>
        {modelName && (
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
            {formatModelDisplayName(modelName)}
          </div>
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  MediaErrorCard                                                     */
/* ------------------------------------------------------------------ */

const MediaErrorCard = React.memo(function MediaErrorCard({
  isVideoTool,
  error,
  canceled = false,
  refused = false,
}: {
  isVideoTool: boolean;
  error: string;
  canceled?: boolean;
  refused?: boolean;
}) {
  // A refusal is not a failure. The receipt comes back before any submission
  // attempt — nothing created, nothing charged — so it is a warning about the
  // remaining budget, and it must not be dressed as a red generation failure.
  const cardClass = canceled
    ? "rounded-xl border-[0.5px] border-border bg-muted/30 p-3"
    : refused
      ? "rounded-xl border-[0.5px] border-amber-200 bg-amber-50 p-3"
      : "rounded-xl border-[0.5px] border-destructive/30 bg-destructive/5 p-3";
  const iconClass = canceled
    ? "mt-0.5 shrink-0 rounded-lg bg-muted p-1.5 text-muted-foreground"
    : refused
      ? "mt-0.5 shrink-0 rounded-lg bg-amber-100 p-1.5 text-amber-700"
      : "mt-0.5 shrink-0 rounded-lg bg-destructive/10 p-1.5 text-destructive";
  const title = canceled
    ? isVideoTool ? "视频生成已取消" : "图片生成已取消"
    : refused
      ? "\u672a\u63d0\u4ea4\u751f\u6210"
      : isVideoTool
        ? "\u89c6\u9891\u751f\u6210\u5931\u8d25"
        : "\u56fe\u7247\u751f\u6210\u5931\u8d25";
  return (
    <div className={cardClass}>
      <div className="flex items-start gap-2.5">
        <div className={iconClass}>
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
            {error}
          </div>
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  ImageArtifactCard                                                  */
/* ------------------------------------------------------------------ */

const ImageArtifactCard = React.memo(function ImageArtifactCard({
  artifact,
  cardTitle,
  modelName,
  hasDetails,
  onOpenPanel,
  onRefreshImage,
}: {
  artifact: ImageArtifact;
  cardTitle: string;
  modelName: string | undefined;
  hasDetails: boolean;
  onOpenPanel: () => void;
  onRefreshImage?: () => Promise<string | null>;
}) {
  const [imageUrl, setImageUrl] = useState(artifact.url);
  const refreshAttemptedRef = useRef(false);

  useEffect(() => {
    setImageUrl(artifact.url);
    refreshAttemptedRef.current = false;
  }, [artifact.url]);

  const handleImageError = useCallback(() => {
    if (!onRefreshImage || refreshAttemptedRef.current) return;
    refreshAttemptedRef.current = true;
    void onRefreshImage()
      .then((refreshedUrl) => {
        if (refreshedUrl) setImageUrl(refreshedUrl);
      })
      .catch(() => {});
  }, [onRefreshImage]);

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      fetch(artifact.url)
        .then((res) => res.blob())
        .then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = artifact.title ?? "generated-image.png";
          a.click();
          URL.revokeObjectURL(a.href);
        })
        .catch(() => window.open(artifact.url, "_blank"));
    },
    [artifact.url, artifact.title],
  );

  return (
    <div
      className="group cursor-pointer rounded-xl border-[0.5px] border-border overflow-hidden transition-shadow hover:shadow-md"
      onClick={onOpenPanel}
    >
      {/* Image preview */}
      <div className="relative w-full overflow-hidden bg-muted">
        <img
          src={imageUrl}
          alt={artifact.title ?? "Generated image"}
          className="block h-auto max-h-[280px] w-full object-contain"
          loading="lazy"
          onError={handleImageError}
        />
        {/* Gradient overlay with download button */}
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={handleDownload}
            className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-white/20 backdrop-blur-sm text-white hover:bg-white/30 transition-colors"
            title="\u4e0b\u8f7d\u56fe\u7247"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z" />
            </svg>
          </button>
        </div>
      </div>
      {/* Title + model info */}
      <div className="px-3 py-2.5">
        <div className="text-sm font-semibold text-foreground line-clamp-1">
          {artifact.title ?? cardTitle}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {modelName && (
            <span className="truncate">
              {formatModelDisplayName(modelName)}
            </span>
          )}
          {hasDetails && (
            <>
              <span>&middot;</span>
              <span className="hover:text-foreground transition-colors">
                查看详情
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  ToolDetailPanel — floating panel to the left of chatbar            */
/* ------------------------------------------------------------------ */

function ToolDetailPanel({
  block,
  rightOffset,
  onClose,
}: {
  block: ToolBlock;
  rightOffset: number;
  onClose: () => void;
}) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const hasInput = block.input && Object.keys(block.input).length > 0;
  const config = getToolConfig(block.toolName);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[1000]"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, x: 24, scale: 0.97 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        transition={{
          duration: 0.25,
          ease: [0.25, 0.46, 0.45, 0.94],
        }}
        className="fixed top-1/2 -translate-y-1/2 w-[520px] max-h-[640px] min-h-[240px] rounded-2xl bg-card shadow-lg overflow-hidden flex flex-col"
        style={{ right: rightOffset }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <ToolIcon
              type={config.icon}
              className="h-4 w-4 text-muted-foreground"
            />
            <h3 className="text-sm font-semibold text-foreground">
              {config.label}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          {/* Input -- collapsible */}
          {hasInput && (
            <div>
              <button
                type="button"
                onClick={() => setInputExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={inputExpanded}
              >
                <svg
                  className={`h-3 w-3 transition-transform duration-200 ${inputExpanded ? "rotate-90" : ""}`}
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L9.44 8 6.22 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
                输入参数
              </button>
              {inputExpanded && (
                <div className="mt-2 space-y-1.5">
                  {Object.entries(block.input!).map(([key, value]) => (
                    <div key={key} className="rounded-lg bg-muted px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {formatParamName(key)}
                      </div>
                      <div className="mt-0.5 text-xs text-foreground break-all whitespace-pre-wrap">
                        {formatParamValue(value)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Output */}
          {block.output ? (
            <ToolOutputRenderer
              toolName={block.toolName}
              output={block.output}
            />
          ) : block.outputSummary ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                输出
              </div>
              <div className="rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {block.outputSummary}
              </div>
            </div>
          ) : null}

          {/* Image artifacts */}
          {block.artifacts && block.artifacts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                附件
              </div>
              <div className="flex flex-wrap gap-2">
                {block.artifacts.map((artifact) =>
                  artifact.type === "image" ? (
                    <ChatImage
                      key={artifact.url}
                      src={artifact.url}
                      alt={artifact.title ?? "Generated image"}
                      className="max-w-[200px] rounded-lg border border-border"
                    />
                  ) : null,
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool-specific output renderers                                     */
/* ------------------------------------------------------------------ */

function ToolOutputRenderer({
  toolName,
  output,
}: {
  toolName: string;
  output: Record<string, unknown>;
}) {
  if (toolName === "get_brand_kit" && isBrandKitOutput(output)) {
    return <BrandKitOutput data={output} />;
  }

  const entries = Object.entries(output);
  const isSimple = entries.every(
    ([, v]) =>
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean",
  );

  if (isSimple && entries.length > 0) {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-2">
          输出
        </div>
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="rounded-lg bg-muted px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {formatParamName(key)}
              </div>
              <div className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">
                {value === null ? "\u2014" : String(value)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Complex objects / arrays -- formatted JSON
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2">输出</div>
      <div className="rounded-xl bg-muted px-4 py-3 overflow-x-auto max-h-[360px] overflow-y-auto">
        <pre className="text-[12px] leading-5 text-muted-foreground whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(output, null, 2)}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BrandKit output renderer                                           */
/* ------------------------------------------------------------------ */

type BrandKitData = {
  kit_name?: string;
  design_guidance?: string;
  colors?: { name?: string; hex?: string; role?: string | null }[];
  fonts?: {
    name?: string;
    family?: string;
    weight?: string;
    role?: string | null;
  }[];
  logos?: { name?: string; url?: string; role?: string | null }[];
  images?: { name?: string; url?: string; role?: string | null }[];
};

function isBrandKitOutput(
  output: Record<string, unknown>,
): output is BrandKitData {
  return (
    "colors" in output ||
    "fonts" in output ||
    "logos" in output ||
    "kit_name" in output
  );
}

function BrandKitOutput({ data }: { data: BrandKitData }) {
  const colors = data.colors?.filter((c) => c.hex) ?? [];
  const fonts = data.fonts?.filter((f) => f.name) ?? [];
  const logos = data.logos?.filter((l) => l.url) ?? [];
  const images = data.images?.filter((i) => i.url) ?? [];

  return (
    <div className="space-y-4">
      {data.kit_name && (
        <div>
          <div className="text-base font-semibold text-foreground">
            {data.kit_name}
          </div>
          {data.design_guidance && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {data.design_guidance}
            </div>
          )}
        </div>
      )}

      {/* Colors */}
      {colors.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Color
          </div>
          <div className="flex flex-wrap gap-3">
            {colors.map((color, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <div
                  className="h-16 w-16 rounded-xl border border-border shadow-sm"
                  style={{ backgroundColor: color.hex }}
                />
                <span className="text-[10px] font-medium text-muted-foreground">
                  {color.hex}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fonts */}
      {fonts.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Fonts
          </div>
          <div className="grid grid-cols-2 gap-2">
            {fonts.map((font, i) => (
              <div key={i} className="rounded-xl bg-muted px-3 py-3">
                <div className="text-[10px] text-muted-foreground mb-1">
                  {font.name}
                </div>
                <div
                  className="text-sm text-foreground"
                  style={{ fontFamily: font.family }}
                >
                  ABCDEFGHIJKLM
                </div>
                <div
                  className="text-xs text-foreground mt-0.5"
                  style={{ fontFamily: font.family }}
                >
                  abcdefghijklmnopqrstuvwxyz
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Logos & Images */}
      {(logos.length > 0 || images.length > 0) && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Photography
          </div>
          <div className="grid grid-cols-2 gap-2">
            {logos.map((logo, i) => (
              <div
                key={`logo-${i}`}
                className="overflow-hidden rounded-xl border border-border"
              >
                <img
                  src={logo.url}
                  alt={logo.name ?? "Logo"}
                  className="h-auto w-full object-cover"
                  loading="lazy"
                />
                {logo.name && (
                  <div className="px-2 py-1.5 text-[10px] text-muted-foreground truncate">
                    {logo.name}
                  </div>
                )}
              </div>
            ))}
            {images.map((img, i) => (
              <div
                key={`img-${i}`}
                className="overflow-hidden rounded-xl border border-border"
              >
                <img
                  src={img.url}
                  alt={img.name ?? "Image"}
                  className="h-auto w-full object-cover"
                  loading="lazy"
                />
                {img.name && (
                  <div className="px-2 py-1.5 text-[10px] text-muted-foreground truncate">
                    {img.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
