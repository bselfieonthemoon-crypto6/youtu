"use client";
import { agentStartErrorMessage } from "../lib/agent-start-error";
import { agentContextErrorMessage } from "../lib/agent-run-error";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectGenerationMessages } from "../lib/chat-generation-presentation";
import { messageResendReferences } from "../lib/chat-message-resend";

import { useBreakpoint } from "../hooks/use-breakpoint";
import type {
  ContentBlock,
  AgentExecutionMode,
  DesignTaskTarget,
  ImageArtifact,
  ImageGenerationPreference,
  MessageMention,
  StreamEvent,
  VideoArtifact,
} from "@loomic/shared";
import { useAgentModel } from "../hooks/use-agent-model";
import {
  mapServerMessages,
  type Message,
  useChatSessions,
} from "../hooks/use-chat-sessions";
import { useChatStream } from "../hooks/use-chat-stream";
import { useDesignRoutingNotice } from "../hooks/use-design-routing-notice";
import { useWorkspaceSkills } from "../hooks/use-workspace-skills";
import type { CanvasSelectionSnapshot } from "../lib/canvas-selection-snapshot";
import {
  resolveFreshAuthorizedDesignScope,
  resolveFreshTaskTarget,
} from "../lib/chat-submission-scope";
import {
  INITIAL_AGENT_MODEL_KEY,
  INITIAL_ATTACHMENTS_KEY,
  INITIAL_EXECUTION_MODE_KEY,
  INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
} from "../hooks/use-create-project";
import type { ReadyAttachment } from "../hooks/use-image-attachments";
import { useImageAttachments } from "../hooks/use-image-attachments";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import { waitForGenerationJob } from "../hooks/use-job-fallback-polling";
import type { WebSocketHandle } from "../hooks/use-websocket";
import { fetchBrandKit } from "../lib/brand-kit-api";
import { claimDailyCredits } from "../lib/credits-api";
import { preserveChatCopy } from "../lib/chat-clipboard";
import {
  fetchImageModels,
  restoreJobToCanvas,
  saveMessage,
  truncateMessagesFrom,
} from "../lib/server-api";
import type { CanvasSelectedElement } from "./canvas-editor";
import type { CanvasImageChatCommand } from "./canvas/image-toolbar-types";
import {
  type BrandKitMentionItem,
  type CanvasImageItem,
  type ImageModelMentionItem,
  type SkillMentionItem,
  MessageMentionPicker,
  type MessageMentionPickerItem,
} from "./canvas-image-picker";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { ChatSkills } from "./chat-skills";
import { CreditInsufficientDialog } from "./credits/credit-insufficient-dialog";
import { useTierLimitToast } from "./credits/tier-limit-toast";
import { useToast } from "./toast";
import { ErrorBoundary } from "./error-boundary";
import { SessionSelector } from "./session-selector";
import { RunHistoryPanel } from "./chat/run-history-panel";
import type { ToolConfirmationKind } from "./chat/tool-block-view";
import {
  ClarificationDialog,
  ConfirmationDialog,
  hasImageExecutionReceipt,
  parseClarificationQuestions,
  parseStructuredClarificationQuestions,
  parseConfirmationRequest,
  parseToolConfirmationRequest,
  type ClarificationQuestion,
  type ConfirmationRequest,
} from "./chat/clarification-dialog";

type ChatSidebarProps = {
  accessToken: string;
  canvasId: string;
  open: boolean;
  onToggle: () => void;
  onImageGenerated?: (artifact: ImageArtifact) => void;
  onVideoGenerated?: (artifact: VideoArtifact) => void;
  onCanvasSync?: () => void;
  /** Called for every stream event — used by job fallback polling to detect timed-out jobs */
  onStreamEvent?: (event: StreamEvent) => void;
  initialPrompt?: string | undefined;
  initialSessionId?: string | undefined;
  onSessionChange?: (sessionId: string) => void;
  onRequestCanvasImages?: () => CanvasImageItem[];
  onRequestCanvasSelection?: (canvasId: string) => CanvasSelectionSnapshot;
  currentBrandKitId?: string | null;
  ws: WebSocketHandle;
  selectedCanvasElements?: CanvasSelectedElement[];
  imageChatCommand?: CanvasImageChatCommand | null;
  onOpenDesign?: (designId: string) => void;
  activeDesignId?: string;
  beforeDesignSend?: () => Promise<void>;
};

const HANDLED_CONFIRMATION_STORAGE_PREFIX = "loomic:handled-confirmation:";

function wasConfirmationHandled(confirmationId: string): boolean {
  try {
    return (
      window.localStorage.getItem(
        `${HANDLED_CONFIRMATION_STORAGE_PREFIX}${confirmationId}`,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function markConfirmationHandled(confirmationId: string): void {
  try {
    window.localStorage.setItem(
      `${HANDLED_CONFIRMATION_STORAGE_PREFIX}${confirmationId}`,
      "1",
    );
  } catch {
    // The in-memory message guard still prevents the dialog from reopening
    // when storage is unavailable (for example, in a restricted browser).
  }
}

export function ChatSidebar({
  activeDesignId,
  beforeDesignSend,
  accessToken,
  canvasId,
  open,
  onToggle,
  onImageGenerated,
  onVideoGenerated,
  onCanvasSync,
  onStreamEvent,
  initialPrompt,
  initialSessionId,
  onSessionChange,
  onRequestCanvasImages,
  onRequestCanvasSelection,
  currentBrandKitId,
  ws,
  selectedCanvasElements,
  imageChatCommand,
  onOpenDesign,
}: ChatSidebarProps) {
  const breakpoint = useBreakpoint();
  const designSendRef = useRef({ activeDesignId, beforeDesignSend });
  designSendRef.current = { activeDesignId, beforeDesignSend };
  const isOverlay = breakpoint !== "desktop";

  // ── Session & message management (extracted hook with LRU cache) ──
  const {
    sessions,
    activeSessionId,
    activeSessionIdRef,
    messages,
    messagesRef,
    setMessages,
    sessionsLoading,
    messagesLoading,
    streaming,
    setStreaming,
    updateSessionMessages,
    handleSelectSession,
    handleNewChat,
    handleDeleteSession,
    autoTitleSession,
    reloadMessages,
    accessTokenRef,
  } = useChatSessions({
    canvasId,
    accessToken,
    initialSessionId,
    onSessionChange,
  });

  // ── Stream event handler (extracted hook, shared between send & reconnect) ──
  const { applyStreamEvent } = useChatStream(updateSessionMessages);

  // ── Mention & attachment state ──
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [messageMentions, setMessageMentions] = useState<MessageMention[]>([]);
  const [brandKitMentionItems, setBrandKitMentionItems] = useState<
    BrandKitMentionItem[]
  >([]);
  const [imageModelMentionItems, setImageModelMentionItems] = useState<
    ImageModelMentionItem[]
  >([]);
  const [skillMentionItems, setSkillMentionItems] = useState<
    SkillMentionItem[]
  >([]);
  const [creditDialog, setCreditDialog] = useState<{
    open: boolean;
    currentBalance: number;
    requiredAmount: number;
    plan: string;
    dailyClaimed: boolean;
  } | null>(null);
  const chatInputRef = useRef<import("./chat-input").ChatInputHandle>(null);
  const chatSidebarRef = useRef<HTMLDivElement>(null);

  const initialPromptSent = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const submissionVersionRef = useRef(0);
  const submissionStartingVersionRef = useRef<number | null>(null);
  const completedRunIdsRef = useRef(new Set<string>());
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalRecoveryRef = useRef(false);
  const completedResumeRetriesRef = useRef(new Set<string>());
  const detachLiveStreamRef = useRef<(() => void) | null>(null);
  const detachResumedStreamRef = useRef<(() => void) | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [resumeRequest, setResumeRequest] = useState(0);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [clarificationQuestions, setClarificationQuestions] = useState<
    ClarificationQuestion[]
  >([]);
  const [confirmationRequest, setConfirmationRequest] =
    useState<ConfirmationRequest | null>(null);
  const [confirmedGenerationPending, setConfirmedGenerationPending] =
    useState(false);
  const [floatingDialogClearance, setFloatingDialogClearance] = useState(0);
  const handledClarificationMessageIdsRef = useRef(new Set<string>());
  const cancelRequestedRef = useRef(false);
  const messageMentionsRef = useRef(messageMentions);
  messageMentionsRef.current = messageMentions;
  const selectedCanvasElementsRef = useRef(selectedCanvasElements);
  selectedCanvasElementsRef.current = selectedCanvasElements;

  const prevConnectedRef = useRef(false);
  const scheduleActiveRunRecovery = useCallback(() => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    const sessionId = activeSessionIdRef.current;
    const version = submissionVersionRef.current;
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (activeSessionIdRef.current !== sessionId || submissionVersionRef.current !== version) return;
      terminalRecoveryRef.current = true;
      prevConnectedRef.current = false;
      setResumeRequest(current => current + 1);
    }, 150);
  }, [activeSessionIdRef]);
  useEffect(() => () => { if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current); }, []);
  const consumedImageCommandRef = useRef<string | null>(null);
  const canvasSyncTimersRef = useRef<number[]>([]);
  const completedConfirmationIdsRef = useRef(new Set<string>());

  const scheduleCanvasSyncBurst = useCallback(() => {
    if (!onCanvasSync) return;
    for (const timer of canvasSyncTimersRef.current) window.clearTimeout(timer);
    canvasSyncTimersRef.current = [];
    onCanvasSync();
    // The confirmation ACK intentionally arrives before the durable job and
    // placeholder. Retry a few bounded refreshes so a missed websocket event
    // cannot leave the canvas blank while generation continues.
    for (const delay of [400, 1_200, 3_000, 8_000, 20_000, 60_000]) {
      canvasSyncTimersRef.current.push(
        window.setTimeout(() => onCanvasSync(), delay),
      );
    }
  }, [onCanvasSync]);

  useEffect(
    () => () => {
      for (const timer of canvasSyncTimersRef.current)
        window.clearTimeout(timer);
      canvasSyncTimersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const root = chatSidebarRef.current;
      if (root) preserveChatCopy(event, root);
    };
    document.addEventListener("copy", handleCopy, true);
    return () => document.removeEventListener("copy", handleCopy, true);
  }, []);

  const {
    attachments: imageAttachments,
    addFiles,
    addCanvasRef,
    retryUpload,
    removeAttachment,
    clearAll: clearAttachments,
    isUploading,
    readyAttachments,
  } = useImageAttachments(accessToken);

  const { activeImageGenerationPreference } = useImageModelPreference();
  const activeImageGenerationPreferenceRef = useRef(
    activeImageGenerationPreference,
  );
  activeImageGenerationPreferenceRef.current = activeImageGenerationPreference;

  const { activeVideoGenerationPreference } = useVideoModelPreference();
  const activeVideoGenerationPreferenceRef = useRef(
    activeVideoGenerationPreference,
  );
  activeVideoGenerationPreferenceRef.current = activeVideoGenerationPreference;

  const { model: agentModel } = useAgentModel();
  const agentModelRef = useRef(agentModel);
  agentModelRef.current = agentModel;

  const { showTierLimit } = useTierLimitToast();
  const { toast: showToast } = useToast();
  // Part ①: one transient toast per turn describing the routing decision the
  // server already made (selected Skill, reason, preloaded guides, size enable).
  const { present: presentRoutingNotice } = useDesignRoutingNotice();
  const handleSkillSelect = useCallback((invitation: string) => {
    chatInputRef.current?.prependInvitation(invitation);
  }, []);

  // ── Sidebar resize ──
  const SIDEBAR_MIN = 300;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_KEYBOARD_STEP = 20;
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const isResizing = useRef(false);

  const clampWidth = useCallback(
    (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
    [],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = startX - moveEvent.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth, clampWidth],
  );

  // Touch support for resize handle (mobile / tablet)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      isResizing.current = true;
      const startX = touch.clientX;
      const startWidth = sidebarWidth;

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (!isResizing.current) return;
        const t = moveEvent.touches[0];
        if (!t) return;
        moveEvent.preventDefault(); // prevent scroll during resize
        const delta = startX - t.clientX;
        setSidebarWidth(clampWidth(startWidth + delta));
      };

      const handleTouchEnd = () => {
        isResizing.current = false;
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.removeEventListener("touchcancel", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
      document.addEventListener("touchcancel", handleTouchEnd);
    },
    [sidebarWidth, clampWidth],
  );

  // Keyboard support for resize handle (ArrowLeft/ArrowRight)
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev + SIDEBAR_KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSidebarWidth((prev) => clampWidth(prev - SIDEBAR_KEYBOARD_STEP));
      }
    },
    [clampWidth],
  );

  // ── Auto-scroll to bottom ──
  const scrollToBottom = useCallback(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;
    messageList.scrollTo({ top: messageList.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // The guided prompt remains visually floating above the composer, but its
  // height is mirrored as scrollable clearance so it never hides the tail of
  // the assistant's proposal.
  useEffect(() => {
    const dialog = chatSidebarRef.current?.querySelector<HTMLElement>(
      "[data-chat-floating-dialog]",
    );
    if (!dialog) {
      setFloatingDialogClearance(0);
      return;
    }

    const updateClearance = () => {
      const composer = dialog.closest<HTMLElement>("[data-chat-composer-shell]");
      const coveredComposerHeight = composer?.getBoundingClientRect().height ?? 0;
      setFloatingDialogClearance(
        Math.max(
          0,
          Math.ceil(dialog.getBoundingClientRect().height - coveredComposerHeight),
        ) + 24,
      );
    };
    updateClearance();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateClearance);
    observer.observe(dialog);
    return () => observer.disconnect();
  }, [clarificationQuestions.length, confirmationRequest]);

  useEffect(() => {
    if (floatingDialogClearance <= 0) return;
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [floatingDialogClearance, scrollToBottom]);

  // ── Fetch image models for @mention picker ──
  useEffect(() => {
    let cancelled = false;

    fetchImageModels(accessToken)
      .then((data) => {
        if (cancelled) return;
        setImageModelMentionItems(
          data.models.map((model) => ({
            kind: "image-model",
            id: model.id,
            label: model.displayName,
            description: model.description,
            ...(model.iconUrl ? { iconUrl: model.iconUrl } : {}),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setImageModelMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // Share authoritative install/toggle refreshes with the Skills page and cards.
  const { skills: workspaceSkills } = useWorkspaceSkills(accessToken);
  useEffect(() => {
    setSkillMentionItems(workspaceSkills
      .filter((skill) => skill.installed === true && skill.enabled === true && skill.readiness && skill.readiness.status !== "unavailable")
      .map((s) => ({
            kind: "skill" as const,
            id: s.id,
            label: s.name,
            slug: s.slug,
            description: s.description,
      })));
  }, [workspaceSkills]);

  // ── Fetch brand kit items for @mention picker ──
  useEffect(() => {
    if (!currentBrandKitId) {
      setBrandKitMentionItems([]);
      return;
    }

    let cancelled = false;
    fetchBrandKit(accessTokenRef.current, currentBrandKitId)
      .then((kit) => {
        if (cancelled) return;
        setBrandKitMentionItems(
          kit.assets.map((asset) => ({
            kind: "brand-kit-asset" as const,
            id: asset.id,
            label: asset.display_name,
            assetType: asset.asset_type,
            textContent: asset.text_content,
            fileUrl: asset.file_url,
            thumbnailUrl:
              asset.asset_type === "logo" || asset.asset_type === "image"
                ? asset.file_url
                : null,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setBrandKitMentionItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [currentBrandKitId, accessTokenRef]);

  const clearActiveRun = useCallback(() => {
    activeRunIdRef.current = null;
    setActiveRunId(null);
    cancelRequestedRef.current = false;
    setCancelRequested(false);
  }, []);

  const handleCancelRun = useCallback(() => {
    if (!streaming || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    setCancelRequested(true);
    if (activeRunIdRef.current) {
      ws.cancelRun(activeRunIdRef.current);
    }
  }, [streaming, ws]);

  const handleNewChatClick = useCallback(() => {
    handleCancelRun();
    setClarificationQuestions([]);
    setConfirmationRequest(null);
    void handleNewChat();
  }, [handleCancelRun, handleNewChat]);

  const handleConfirmAction = useCallback(
    (
      confirmationId: string,
      decision: "confirm" | "cancel",
      confirmationKind: ToolConfirmationKind = "delete",
    ) => {
      // During the initial session load React state can already contain the
      // visible session while the ref observed by this callback is one render
      // behind. Fall back to state so a confirmed proposal still gets its
      // optimistic chat placeholder immediately.
      const confirmationSessionId =
        activeSessionIdRef.current ?? activeSessionId;
      return new Promise<{ status: string; message?: string }>((resolve) => {
        const timeout = window.setTimeout(
          () =>
            resolve({
              status: "failed",
              message: "确认请求超时，请重新发起。",
            }),
          10_000,
        );
        ws.confirmAction(confirmationId, decision, (ack) => {
          window.clearTimeout(timeout);
          const payload = ack.payload as {
            status?: unknown;
            message?: unknown;
            result?: unknown;
          };
          const result =
            payload.result &&
            typeof payload.result === "object" &&
            !Array.isArray(payload.result)
              ? (payload.result as Record<string, unknown>)
              : null;
          if (
            payload.status === "accepted" ||
            payload.status === "applied" ||
            payload.status === "canceled"
          ) {
            markConfirmationHandled(confirmationId);
          }
          if (
            decision === "confirm" &&
            (payload.status === "accepted" || payload.status === "applied")
          ) {
            scheduleCanvasSyncBurst();
          }
          if (
            decision === "confirm" &&
            confirmationKind === "image_generation"
          ) {
            if (payload.status === "accepted") {
              setConfirmedGenerationPending(true);
              if (confirmationSessionId) {
                const appendPendingMessage = (
                  previous: Message[],
                ): Message[] => {
                  const optimisticId = `confirmation-pending-${confirmationId}`;
                  if (previous.some((message) => message.id === optimisticId)) {
                    return previous;
                  }
                  return [
                    ...previous,
                    {
                      id: optimisticId,
                      role: "assistant",
                      contentBlocks: [
                        {
                          type: "tool",
                          toolCallId: optimisticId,
                          toolName: "generate_image",
                          status: "running",
                          output: { status: "submitting" },
                          outputSummary: "正在生成图片",
                        },
                      ],
                    },
                  ];
                };
                updateSessionMessages(
                  confirmationSessionId,
                  appendPendingMessage,
                );
                // Keep the currently rendered list in lockstep as well. The
                // session cache can briefly lag during initial auto-confirm.
                if (
                  activeSessionIdRef.current === confirmationSessionId ||
                  activeSessionId === confirmationSessionId
                ) {
                  setMessages(appendPendingMessage);
                }
                window.setTimeout(
                  () => void reloadMessages(confirmationSessionId),
                  8_000,
                );
              }
            } else if (
              payload.status === "applied" ||
              payload.status === "failed" ||
              payload.status === "canceled"
            ) {
              setConfirmedGenerationPending(false);
            }
          }
          if (
            decision === "confirm" &&
            payload.status === "applied" &&
            !completedConfirmationIdsRef.current.has(confirmationId)
          ) {
            if (
              result &&
              typeof result.imageUrl === "string" &&
              result.imageUrl &&
              typeof result.width === "number" &&
              typeof result.height === "number"
            ) {
              completedConfirmationIdsRef.current.add(confirmationId);
              const artifact: ImageArtifact = {
                type: "image",
                url: result.imageUrl,
                mimeType:
                  typeof result.mimeType === "string"
                    ? result.mimeType
                    : "image/png",
                width: result.width,
                height: result.height,
                ...(typeof result.title === "string"
                  ? { title: result.title }
                  : {}),
                ...(typeof result.jobId === "string"
                  ? { jobId: result.jobId }
                  : {}),
                ...(result.placement &&
                typeof result.placement === "object" &&
                !Array.isArray(result.placement)
                  ? {
                      placement: result.placement as ImageArtifact["placement"],
                    }
                  : {}),
              };
              const completionBlocks: ContentBlock[] = [
                {
                  type: "tool",
                  toolCallId: `confirmation-${confirmationId}`,
                  toolName: "generate_image",
                  status: "completed",
                  output: {
                    status: "succeeded",
                    ...(artifact.jobId ? { jobId: artifact.jobId } : {}),
                    ...(typeof result.design_id === "string"
                      ? { design_id: result.design_id }
                      : typeof result.designId === "string"
                        ? { design_id: result.designId }
                        : {}),
                    ...(typeof result.object_id === "string"
                      ? { object_id: result.object_id }
                      : typeof result.objectId === "string"
                        ? { object_id: result.objectId }
                        : {}),
                    ...(typeof result.revision === "number"
                      ? { revision: result.revision }
                      : {}),
                    ...(result.finalization &&
                    typeof result.finalization === "object" &&
                    !Array.isArray(result.finalization)
                      ? { finalization: result.finalization }
                      : {}),
                    ...(result.billing &&
                    typeof result.billing === "object" &&
                    !Array.isArray(result.billing)
                      ? { billing: result.billing }
                      : {}),
                  },
                  outputSummary: "图片生成完成",
                  artifacts: [artifact],
                },
              ];
              if (
                confirmationSessionId &&
                activeSessionIdRef.current === confirmationSessionId
              ) {
                updateSessionMessages(confirmationSessionId, (previous) => [
                  ...previous.filter(
                    (message) =>
                      message.id !== `confirmation-pending-${confirmationId}`,
                  ),
                  {
                    id: `confirmation-result-${confirmationId}`,
                    role: "assistant",
                    contentBlocks: completionBlocks,
                  },
                ]);
              }
              if (confirmationSessionId) {
                window.setTimeout(
                  () => void reloadMessages(confirmationSessionId),
                  1_000,
                );
              }
            }
          }
          if (
            decision === "confirm" &&
            payload.status === "failed" &&
            result &&
            typeof result.jobId === "string" &&
            result.jobId
          ) {
            // The agent-side wait can time out while the durable worker is
            // retrying. Keep following that same paid job instead of leaving
            // the chat and canvas on a permanent loading placeholder.
            setConfirmedGenerationPending(true);
            void waitForGenerationJob(accessTokenRef.current, result.jobId)
              .then((job) => {
                setConfirmedGenerationPending(false);
                if (job.status !== "succeeded") return;
                scheduleCanvasSyncBurst();
                if (confirmationSessionId) {
                  for (const delay of [500, 1_500, 4_000]) {
                    window.setTimeout(
                      () => void reloadMessages(confirmationSessionId),
                      delay,
                    );
                  }
                }
              })
              .catch((error) => {
                setConfirmedGenerationPending(false);
                console.error(
                  "[chat] Failed to follow image job retry:",
                  error,
                );
              });
          }
          resolve({
            status:
              typeof payload.status === "string" ? payload.status : "failed",
            ...(typeof payload.message === "string"
              ? { message: payload.message }
              : {}),
          });
        });
      });
    },
    [
      accessTokenRef,
      activeSessionId,
      activeSessionIdRef,
      scheduleCanvasSyncBurst,
      reloadMessages,
      setMessages,
      updateSessionMessages,
      ws,
    ],
  );

  const handleRetryRead = useCallback(
    (toolExecutionId: string) =>
      new Promise<{ status: string; message?: string }>((resolve) => {
        const requestId = crypto.randomUUID();
        const timeout = window.setTimeout(
          () =>
            resolve({
              status: "failed",
              message: "重新读取请求超时，请稍后再试。",
            }),
          15_000,
        );
        ws.retryTool(toolExecutionId, requestId, (ack) => {
          window.clearTimeout(timeout);
          const payload = ack.payload as {
            status?: unknown;
          };
          const status =
            typeof payload.status === "string" ? payload.status : "failed";
          if (status === "completed") {
            const sessionId = activeSessionIdRef.current;
            if (sessionId) void reloadMessages(sessionId);
          }
          resolve({
            status,
            ...(status === "failed"
              ? { message: "重新读取失败，请稍后再试。" }
              : {}),
          });
        });
      }),
    [activeSessionIdRef, reloadMessages, ws],
  );

  const handleWaitGeneration = useCallback(
    (jobId: string) => waitForGenerationJob(accessToken, jobId),
    [accessToken],
  );

  // Resume persisted queued jobs on refresh too; a completed Agent turn is not
  // the completion of its background generation job.
  const observedGenerationJobs = useRef(new Set<string>());
  useEffect(() => {
    if (!accessToken || !activeSessionId) return;
    const session = activeSessionId;
    for (const message of messages)
      for (const block of message.contentBlocks ?? []) {
        if (block.type !== "tool") continue;
        const output = block.output as Record<string, unknown> | undefined;
        const jobId = output?.jobId;
        if (
          typeof jobId !== "string" ||
          !["processing", "queued"].includes(String(output?.status))
        )
          continue;
        const key = `${session}:${jobId}`;
        if (observedGenerationJobs.current.has(key)) continue;
        observedGenerationJobs.current.add(key);
        void waitForGenerationJob(accessToken, jobId)
          .then(async (job) => {
            if (job.status === "succeeded") {
              if (activeSessionIdRef.current === session) {
                await reloadMessages(session);
                onCanvasSync?.();
              } else {
                observedGenerationJobs.current.delete(key);
              }
            } else {
              // A concurrent successful job can reload persisted messages and
              // restore this old queued projection. Allow re-observation then;
              // the terminal status below prevents polling our own update.
              observedGenerationJobs.current.delete(key);
              updateSessionMessages(session, (previous) =>
                previous.map((item) => ({
                  ...item,
                  contentBlocks:
                    item.contentBlocks?.map((b) =>
                      b.type === "tool" && b.output?.jobId === jobId
                        ? {
                            ...b,
                            status: job.status === "canceled" ? "canceled" as const : "failed" as const,
                            output: {
                              ...b.output,
                              status: job.status,
                              error: job.status === "canceled" ? "任务已取消，不会将后续结果放入画布" : job.error_message ?? "生成任务未完成",
                            },
                            outputSummary:
                              job.status === "canceled" ? "任务已取消，不会将后续结果放入画布" : job.error_message ?? "生成任务未完成",
                          }
                        : b,
                    ) ?? [],
                })),
              );
            }
          })
          .catch(() => {
            // Keep the saved job and the card's manual wait action; never regenerate.
            observedGenerationJobs.current.delete(key);
          });
      }
  }, [
    accessToken,
    activeSessionId,
    messages,
    activeSessionIdRef,
    reloadMessages,
    updateSessionMessages,
    onCanvasSync,
  ]);

  const handleRestoreGeneration = useCallback(
    async (jobId: string) => {
      const restored = await restoreJobToCanvas(accessToken, jobId);
      await onCanvasSync?.();
      return restored;
    },
    [accessToken, onCanvasSync],
  );

  // ── Send message ──
  const handleSend = useCallback(
    async (
      text: string,
      attachmentsOverride?: ReadyAttachment[],
      imageGenerationPreferenceOverride?: ImageGenerationPreference,
      mentionsOverride?: MessageMention[],
      executionModeOverride?: AgentExecutionMode,
      preserveComposer = false,
    ) => {
      const currentSessionId = activeSessionIdRef.current;
      if (!currentSessionId) return;
      const selectedEls = [...(selectedCanvasElementsRef.current ?? [])];
      const designContext = { ...designSendRef.current };
      const explicitAttachments = attachmentsOverride ?? readyAttachments;
      // Only a fresh, all-design multi-selection can add secondary targets. A
      // selected/open object is useful read context even for consultation; the
      // task's write guards still decide effects.
      const freshAuthorizedScope = resolveFreshAuthorizedDesignScope({
        attachments: explicitAttachments,
        selection: selectedEls,
      });
      const target: DesignTaskTarget | undefined = freshAuthorizedScope?.target ?? resolveFreshTaskTarget({
        attachments: explicitAttachments,
        canvasImages: onRequestCanvasImages?.() ?? [], selection: selectedEls,
      });
      // Copy synchronously before any save/ACK wait. Explicit attachment and
      // design targets have their own evidence and cannot inherit stale selection.
      const canvasSelection = explicitAttachments.length === 0
        ? { elementIds: [...new Set(onRequestCanvasSelection?.(canvasId).elementIds ?? [])] }
        : undefined;
      // Capture scope and references synchronously. Later canvas clicks never retarget a run.
      const boundDesignId = target?.kind === "design" ? target.designId : undefined;
      let executionFailed = false;
      let settledRunId: string | null = null;
      let designPreflightError: string | null = null;

      // Explicit attachments take precedence over a stale canvas selection.
      let currentAttachments = attachmentsOverride ?? readyAttachments;
      const selectedImageEls = selectedEls.filter(
        (el) =>
          el.type === "image" && el.fileId && (el.storageUrl || el.dataUrl),
      );
      const referenceImageEls = selectedImageEls;
      if (referenceImageEls.length > 0 && !attachmentsOverride && currentAttachments.length === 0) {
        const existingIds = new Set(currentAttachments.map((a) => a.assetId));
        const selectionAttachments: ReadyAttachment[] = referenceImageEls
          .filter((el) => !existingIds.has(el.assetId ?? el.id))
          .map((el) => ({
            assetId: el.assetId ?? el.id,
            url: el.storageUrl ?? el.dataUrl!,
            mimeType: el.mimeType ?? "image/png",
            source: "canvas-ref" as const,
            name: el.name ?? `Canvas selection ${el.id.slice(0, 6)}`,
          }));
        if (selectionAttachments.length > 0) {
          currentAttachments = [...currentAttachments, ...selectionAttachments];
        }
      }
      const currentImageGenerationPreference = imageGenerationPreferenceOverride ??
        activeImageGenerationPreferenceRef.current;
      const currentVideoGenerationPreference = activeVideoGenerationPreferenceRef.current;
      const currentModel = agentModelRef.current;
      // Model mentions are current-message instructions. Replaying a previous
      // task's mention can resurrect a removed workspace alias and override the
      // model mode currently shown in the UI.
      const currentMentions = mentionsOverride ?? messageMentionsRef.current;
      // The product now has one execution policy: always use the deliberate
      // Thinking path. Keep the optional argument only for call compatibility
      // with older stored home-page payloads, but never let it downgrade a run.
      void executionModeOverride;
      const currentExecutionMode: AgentExecutionMode = "thinking";
      // React state is not synchronous: two clicks can otherwise both pass the
      // `streaming` check before its render. Close that window before creating
      // either the durable message identity or the run.
      if (submissionStartingVersionRef.current !== null) return { status: "failed" as const };
      const submissionVersion = ++submissionVersionRef.current;
      submissionStartingVersionRef.current = submissionVersion;
      detachLiveStreamRef.current?.();
      detachResumedStreamRef.current?.();
      detachResumedStreamRef.current = null;
      setClarificationQuestions([]);
      setConfirmationRequest(null);

      // Add user message locally
      const imageBlocks: ContentBlock[] = currentAttachments.map((a) => ({
        type: "image" as const,
        assetId: a.assetId,
        url: a.url,
        mimeType: a.mimeType,
        source: a.source,
        ...(a.name ? { name: a.name } : {}),
      }));
      const mentionBlocks: ContentBlock[] = currentMentions.map((mention) => {
        if (mention.mentionType === "image-model") {
          return {
            type: "mention" as const,
            mentionType: "image-model" as const,
            id: mention.id,
            label: mention.label,
          };
        }
        if (mention.mentionType === "skill") {
          return {
            type: "mention" as const,
            mentionType: "skill" as const,
            id: mention.id,
            label: mention.label,
            slug: mention.slug,
          };
        }
        return {
          type: "mention" as const,
          mentionType: "brand-kit-asset" as const,
          id: mention.id,
          label: mention.label,
          assetType: mention.assetType,
          ...(mention.textContent !== undefined
            ? { textContent: mention.textContent }
            : {}),
          ...(mention.fileUrl !== undefined
            ? { fileUrl: mention.fileUrl }
            : {}),
        };
      });
      const userMessageId = crypto.randomUUID();
      const userMsg = {
        id: userMessageId,
        role: "user" as const,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      };
      updateSessionMessages(currentSessionId, (prev) => [...prev, userMsg]);

      // Persist before starting the run. The returned run is durably bound to
      // this exact user message, so confirmation cannot drift to older prose.
      const persistedUserMessage = saveMessage(accessTokenRef.current, currentSessionId, {
        id: userMessageId,
        role: "user",
        content: text,
        contentBlocks: [
          { type: "text" as const, text },
          ...mentionBlocks,
          ...imageBlocks,
        ],
      });

      // Auto-title from first user message
      autoTitleSession(text);

      // Create assistant placeholder
      const assistantId = `assistant-${Date.now()}`;
      updateSessionMessages(currentSessionId, (prev) => [
        ...prev,
        { id: assistantId, role: "assistant" as const, contentBlocks: [] },
      ]);
      setStreaming(true);
      clearActiveRun();
      let unsubscribeRun: (() => void) | undefined;
      let cancelStartWait: (() => void) | undefined;

      try {
        await persistedUserMessage;
        const perf = {
          t0Send: performance.now(),
          tAck: 0,
          tFirstToken: 0,
          gotFirstToken: false,
        };
        if (boundDesignId && boundDesignId === designContext.activeDesignId) {
          try {
            await designContext.beforeDesignSend?.();
          } catch (e) {
            designPreflightError =
              e instanceof Error
                ? e.message
                : "画板保存失败，请先处理后再发送。";
            throw e;
          }
        }
        let resolveStream: () => void;
        const streamDone = new Promise<void>((r) => {
          resolveStream = r;
        });
        const runIdRef = { current: "" };

        const cleanup = ws.onEvent((event) => {
          if (submissionVersionRef.current !== submissionVersion || !runIdRef.current || event.runId !== runIdRef.current) return;

          // Track first token timing
          if (!perf.gotFirstToken && event.type === "message.delta") {
            perf.tFirstToken = performance.now();
            perf.gotFirstToken = true;
            console.log(
              `[perf] send → first token: ${(perf.tFirstToken - perf.t0Send).toFixed(0)}ms` +
                ` (ack→token: ${(perf.tFirstToken - perf.tAck).toFixed(0)}ms)`,
            );
          }

          // Part ①: the runtime's routing decision for THIS turn, shown once as
          // a non-blocking notice. Deduplicated per runId by the hook, so a
          // reconnect replay cannot repeat it.
          if (event.type === "design.routing") {
            presentRoutingNotice(event);
          }

          // Billing error: route to appropriate UI, run.canceled will follow
          if (event.type === "billing.error") {
            if (event.code === "insufficient_credits") {
              setCreditDialog({
                open: true,
                currentBalance: event.currentBalance ?? 0,
                requiredAmount: event.requiredAmount ?? 0,
                plan: event.plan ?? "free",
                dailyClaimed: event.dailyClaimed ?? false,
              });
            } else {
              // model_not_accessible, resolution_not_allowed, concurrency_limit
              showTierLimit({ code: event.code, message: event.message });
            }
          }

          // Apply event to messages (single source of truth — shared with reconnect)
          applyStreamEvent(event, assistantId, currentSessionId);

          // Forward event to parent for fallback job polling (timed-out generation recovery)
          onStreamEvent?.(event);

          // Fire canvas insertion callbacks for image/video artifacts.
          // Skip if the backend already inserted the element (elementId in output).
          const backendInserted =
            event.type === "tool.completed" &&
            event.output &&
            (typeof (event.output as Record<string, unknown>).elementId === "string" ||
              typeof (event.output as Record<string, unknown>).design_id === "string");
          if (
            event.type === "tool.completed" &&
            event.artifacts &&
            event.toolName !== "screenshot_canvas" &&
            !backendInserted
          ) {
            for (const artifact of event.artifacts) {
              if (artifact.type === "image" && onImageGenerated) {
                onImageGenerated(artifact as ImageArtifact);
              }
              if (artifact.type === "video" && onVideoGenerated) {
                onVideoGenerated(artifact as VideoArtifact);
              }
            }
          }

          if (event.type === "canvas.sync" && onCanvasSync) {
            onCanvasSync();
          }

          // Preview model hint: suggest switching when run fails
          if (event.type === "run.failed") {
            const currentModel = agentModelRef.current ?? "";
            if (currentModel.includes("preview") && !agentContextErrorMessage(event.error)) {
              showToast(
                "当前 Preview 模型请求不稳定，建议切换模型后重试",
                "error",
              );
            }
          }

          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.canceled"
          ) {
            completedRunIdsRef.current.add(event.runId);
            settledRunId = event.runId;
            clearActiveRun();
            resolveStream();
          }
        });

        // Start run via WebSocket
        unsubscribeRun = cleanup;
        const detachStream = () => {
          cleanup();
          executionFailed = true;
          resolveStream();
        };
        detachLiveStreamRef.current = detachStream;
        const runId = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            cancelStartWait?.();
            reject(new Error("Agent 启动确认超时，请检查任务状态后再试，避免重复提交。"));
          }, 30_000);

          const stopWaiting = ws.startRun(
            {
              sessionId: currentSessionId,
              conversationId: canvasId,
              userMessageId,
              prompt: text,
              ...(boundDesignId
                ? { activeDesignId: boundDesignId }
                : {}),
              ...(canvasSelection ? { canvasSelection } : {}),
              canvasId,
              accessToken: accessTokenRef.current,
              ...(currentAttachments.length > 0
                ? { attachments: currentAttachments }
                : {}),
              ...(currentMentions.length > 0
                ? { mentions: currentMentions }
                : {}),
              ...(currentImageGenerationPreference
                ? {
                    imageGenerationPreference: currentImageGenerationPreference,
                  }
                : {}),
              ...(currentVideoGenerationPreference
                ? {
                    videoGenerationPreference: currentVideoGenerationPreference,
                  }
                : {}),
              ...(currentModel
                ? { model: currentModel }
                : {}),
              executionMode: currentExecutionMode,
            },
            (ack) => {
              clearTimeout(timeout);
              if (submissionStartingVersionRef.current === submissionVersion)
                submissionStartingVersionRef.current = null;
              perf.tAck = performance.now();
              console.log(
                `[perf] send → ack: ${(perf.tAck - perf.t0Send).toFixed(0)}ms`,
              );
              const id = ack.payload.runId as string;
              runIdRef.current = id;
              if (submissionVersionRef.current === submissionVersion) {
                activeRunIdRef.current = id;
                setActiveRunId(id);
                if (cancelRequestedRef.current) ws.cancelRun(id);
              }
              resolve(id);
            },
            (error) => {
              clearTimeout(timeout);
              if (submissionStartingVersionRef.current === submissionVersion)
                submissionStartingVersionRef.current = null;
              reject(error);
            },
          );
          if (typeof stopWaiting === "function") cancelStartWait = stopWaiting;
        });
        if (submissionVersionRef.current === submissionVersion && !preserveComposer) {
          clearAttachments();
          setMessageMentions([]);
        }

        await streamDone;
        cleanup();
      } catch (error) {
        executionFailed = true;
        updateSessionMessages(currentSessionId, (prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const hasText = m.contentBlocks.some((b) => b.type === "text");
            if (hasText) return m;
            return {
              ...m,
              contentBlocks: [
                ...m.contentBlocks,
                {
                  type: "text" as const,
                  text: designPreflightError ?? agentStartErrorMessage(error),
                },
              ],
            };
          }),
        );
      } finally {
        if (submissionStartingVersionRef.current === submissionVersion)
          submissionStartingVersionRef.current = null;
        unsubscribeRun?.();
        cancelStartWait?.();
        if (submissionVersionRef.current === submissionVersion) {
          detachLiveStreamRef.current = null;
          setStreaming(false);
          clearActiveRun();
          if (settledRunId) scheduleActiveRunRecovery();
        }
      }
      return { status: executionFailed ? "failed" : "accepted" };
    },
    [
      streaming,
      canvasId,
      applyStreamEvent,
      updateSessionMessages,
      onImageGenerated,
      onVideoGenerated,
      onCanvasSync,
      onStreamEvent,
      readyAttachments,
      clearAttachments,
      ws,
      autoTitleSession,
      accessTokenRef,
      activeSessionIdRef,
      clearActiveRun,
      scheduleActiveRunRecovery,
      onRequestCanvasImages,
      onRequestCanvasSelection,
    ],
  );

  const editingSendRef = useRef(false);
  const handleEditSend = useCallback(async (message: Message, text: string, sessionId: string | null) => {
    if (!sessionId || activeSessionIdRef.current !== sessionId) throw new Error("会话已切换，请在当前会话重新编辑。");
    if (streaming || editingSendRef.current) throw new Error("请等待当前回复结束后再发送。");
    if (!ws.connected) throw new Error("连接已断开，请连接恢复后重试。");
    if (!text.trim()) throw new Error("请输入消息内容。");
    const references = messageResendReferences(message.contentBlocks);
    editingSendRef.current = true;
    try {
      // "重新编辑" replaces this turn, not adds a parallel one. Drop this message
      // and everything after it first, otherwise the superseded attempt — its
      // assistant reply and any generation card inside it — stays visible above
      // the replacement. The server resolves the cut by conversation order.
      const token = accessTokenRef.current;
      if (!token) throw new Error("登录状态已失效，请重新登录。");
      await truncateMessagesFrom(token, sessionId, message.id);
      // allowEmpty: truncating the first message leaves an empty session, and the
      // default guard would keep the superseded turn on screen.
      await reloadMessages(sessionId, { allowEmpty: true });
      const result = await handleSend(text, references.attachments, references.imageGenerationPreference,
        references.mentions, undefined, true);
      if (!result || result.status === "failed") throw new Error("请求未能完成，请查看错误提示后重试。");
    } finally { editingSendRef.current = false; }
  }, [accessTokenRef, activeSessionIdRef, handleSend, reloadMessages, streaming, ws.connected]);

  // Explicit commands from the selected-image toolbar survive deselection.
  // Agent actions pass an attachment override directly, avoiding a state race
  // between adding the attachment pill and starting the run.
  useEffect(() => {
    if (
      !imageChatCommand ||
      consumedImageCommandRef.current === imageChatCommand.id
    )
      return;
    if (
      imageChatCommand.mode === "run-agent" &&
      (!activeSessionId || streaming)
    )
      return;
    consumedImageCommandRef.current = imageChatCommand.id;
    const attachment: ReadyAttachment = {
      assetId: imageChatCommand.image.assetId,
      url: imageChatCommand.image.url,
      mimeType: imageChatCommand.image.mimeType,
      source: "canvas-ref",
      ...(imageChatCommand.image.name
        ? { name: imageChatCommand.image.name }
        : {}),
    };
    if (imageChatCommand.mode === "attach") {
      addCanvasRef(imageChatCommand.image);
      chatInputRef.current?.focus();
      return;
    }
    if (imageChatCommand.prompt) {
      void handleSend(imageChatCommand.prompt, [attachment]);
    }
  }, [activeSessionId, addCanvasRef, handleSend, imageChatCommand, streaming]);

  // Hot reloads and late receipt merges can leave a questionnaire opened from
  // prose that belongs to an already submitted image task. Close that stale UI
  // as soon as the authoritative receipt is present.
  useEffect(() => {
    if (clarificationQuestions.length === 0) return;
    const lastMessage = messages[messages.length - 1];
    if (
      lastMessage?.role === "assistant" &&
      hasImageExecutionReceipt(lastMessage.contentBlocks)
    ) {
      setClarificationQuestions([]);
    }
  }, [clarificationQuestions.length, messages]);

  // Turn settled, numbered assistant questions into a guided answer dialog.
  useEffect(() => {
    if (streaming || clarificationQuestions.length > 0 || confirmationRequest)
      return;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;
    if (handledClarificationMessageIdsRef.current.has(lastMessage.id)) return;

    const text = lastMessage.contentBlocks
      .filter(
        (block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    const hasImageReceipt = hasImageExecutionReceipt(lastMessage.contentBlocks);
    const structuredQuestions = hasImageReceipt
      ? []
      : parseStructuredClarificationQuestions(lastMessage.contentBlocks);
    const questions = structuredQuestions.length > 0
      ? structuredQuestions
      : (hasImageReceipt ? [] : parseClarificationQuestions(text));
    const confirmation =
      questions.length === 0 && !hasImageReceipt
        ? (parseToolConfirmationRequest(lastMessage.contentBlocks) ??
          parseConfirmationRequest(text))
        : null;
    if (questions.length === 0 && !confirmation) return;
    if (
      confirmation?.confirmationId &&
      wasConfirmationHandled(confirmation.confirmationId)
    ) {
      handledClarificationMessageIdsRef.current.add(lastMessage.id);
      return;
    }
    if (
      confirmation?.kind === "design_mutation" ||
      confirmation?.kind === "design_template_apply"
    ) {
      // Design confirmations requiring authoritative target details are rendered
      // inside their exact tool result. This avoids a duplicate generic dialog
      // that could bypass those details.
      handledClarificationMessageIdsRef.current.add(lastMessage.id);
      return;
    }

    handledClarificationMessageIdsRef.current.add(lastMessage.id);
    if (questions.length > 0) setClarificationQuestions(questions);
    else setConfirmationRequest(confirmation);
  }, [
    clarificationQuestions.length,
    confirmationRequest,
    messages,
    streaming,
  ]);

  const clarificationDialogEl = clarificationQuestions.length > 0 && (
    <ClarificationDialog
      questions={clarificationQuestions}
      onClose={() => setClarificationQuestions([])}
      onSubmit={(answer) => {
        setClarificationQuestions([]);
        // Unbound chat questions are ordinary conversation.
        void handleSend(answer);
      }}
    />
  );
  const confirmationDialogEl = confirmationRequest && (
    <ConfirmationDialog
      request={confirmationRequest}
      onClose={() => setConfirmationRequest(null)}
      {...(confirmationRequest.confirmationId
        ? {
            onConfirmAction: () =>
              handleConfirmAction(
                confirmationRequest.confirmationId!,
                "confirm",
                confirmationRequest.kind ?? "delete",
              ),
          }
        : {})}
      onSubmit={(answer) => {
        setConfirmationRequest(null);
        void handleSend(answer);
      }}
    />
  );

  // ── Mention picker ──
  const mentionPickerItems: MessageMentionPickerItem[] = [
    ...(onRequestCanvasImages ? onRequestCanvasImages() : []),
    ...brandKitMentionItems,
    ...imageModelMentionItems,
    ...skillMentionItems,
  ];

  const handleMentionSelect = useCallback(
    (item: MessageMentionPickerItem) => {
      if (item.kind === "canvas-image") {
        addCanvasRef({
          assetId: item.assetId,
          url: item.url,
          mimeType: item.mimeType,
          name: item.name,
        });
        return;
      }

      setMessageMentions((prev) => {
        let nextMention: MessageMention;
        if (item.kind === "image-model") {
          nextMention = {
            mentionType: "image-model",
            id: item.id,
            label: item.label,
          };
        } else if (item.kind === "skill") {
          nextMention = {
            mentionType: "skill",
            id: item.id,
            label: item.label,
            slug: item.slug,
          };
        } else {
          nextMention = {
            mentionType: "brand-kit-asset",
            id: item.id,
            label: item.label,
            assetType: item.assetType,
            ...(item.textContent !== undefined
              ? { textContent: item.textContent }
              : {}),
            ...(item.fileUrl !== undefined ? { fileUrl: item.fileUrl } : {}),
          };
        }

        if (
          prev.some(
            (m) =>
              m.mentionType === nextMention.mentionType &&
              m.id === nextMention.id,
          )
        ) {
          return prev;
        }
        return [...prev, nextMention];
      });
    },
    [addCanvasRef],
  );

  const handleRemoveMention = useCallback((mention: MessageMention) => {
    setMessageMentions((prev) =>
      prev.filter(
        (item) =>
          !(item.mentionType === mention.mentionType && item.id === mention.id),
      ),
    );
  }, []);

  // ── Auto-send initial prompt ──
  useEffect(() => {
    if (
      !initialPrompt ||
      sessionsLoading ||
      !ws.connected ||
      initialPromptSent.current
    )
      return;

    let storedAttachments: ReadyAttachment[] | undefined;
    let storedImageGenerationPreference: ImageGenerationPreference | undefined;
    let storedAgentModel: string | undefined;
    try {
      const raw = sessionStorage.getItem(INITIAL_ATTACHMENTS_KEY);
      if (raw) {
        storedAttachments = JSON.parse(raw) as ReadyAttachment[];
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      const preferenceRaw = sessionStorage.getItem(
        INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
      );
      if (preferenceRaw) {
        storedImageGenerationPreference = JSON.parse(
          preferenceRaw,
        ) as ImageGenerationPreference;
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      const modelRaw = sessionStorage.getItem(INITIAL_AGENT_MODEL_KEY);
      if (modelRaw) {
        storedAgentModel = modelRaw;
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }

      // Discard legacy mode state now that every run uses Thinking.
      sessionStorage.removeItem(INITIAL_EXECUTION_MODE_KEY);
    } catch {
      // Malformed JSON or unavailable storage
    }

    if (storedAgentModel) {
      agentModelRef.current = storedAgentModel;
    }

    const timer = setTimeout(() => {
      if (!activeSessionIdRef.current) return;
      initialPromptSent.current = true;
      void handleSend(
        initialPrompt,
        storedAttachments,
        storedImageGenerationPreference,
        undefined,
        "thinking",
      );
    }, 0);

    return () => clearTimeout(timer);
  }, [
    initialPrompt,
    sessionsLoading,
    ws.connected,
    handleSend,
    activeSessionIdRef,
  ]);

  // ── Reconnection: resume canvas binding + reload messages ──
  // Uses the shared applyStreamEvent to handle live events — no duplicated logic.
  useEffect(() => {
    if (!ws.connected || sessionsLoading) {
      if (!ws.connected) {
        prevConnectedRef.current = false;
        // The server keeps running. Detach this obsolete local stream so
        // reconnect can restore it once, without leaving an unresolved send.
        detachLiveStreamRef.current?.();
        detachResumedStreamRef.current?.();
        detachResumedStreamRef.current = null;
        setStreaming(false);
      }
      return;
    }
    if (prevConnectedRef.current) return;
    prevConnectedRef.current = true;

    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;

    // Skip if initialPrompt effect will handle binding
    if (initialPrompt && !initialPromptSent.current) return;

    void (async () => {
      const resumeVersion = submissionVersionRef.current;
      // Reload messages from DB (server may have persisted while disconnected)
      // Terminal events can precede server persistence. Keep the complete local
      // transcript while restoring another live run; true reconnects still reload.
      const terminalRecovery = terminalRecoveryRef.current;
      terminalRecoveryRef.current = false;
      if (!terminalRecovery) await reloadMessages(sessionId);
      if (resumeVersion !== submissionVersionRef.current || activeSessionIdRef.current !== sessionId) return;

      // Resume canvas binding (after DB messages are set)
      ws.resumeCanvas(canvasId, (ack) => {
        if (resumeVersion !== submissionVersionRef.current || activeSessionIdRef.current !== sessionId) return;
        const activeRunId = (ack.payload as Record<string, unknown>)
          .activeRunId;
        const activeRunSessionId = (ack.payload as Record<string, unknown>).activeSessionId;
        // A canvas may have live runs from several chats. Require server-proven
        // conversation identity before appending a resumed run's events here.
        if (typeof activeRunId === "string" && activeRunSessionId !== sessionId) {
          clearActiveRun();
          setStreaming(false);
          return;
        }
        if (typeof activeRunId === "string" && completedRunIdsRef.current.has(activeRunId)) {
          clearActiveRun();
          setStreaming(false);
          if (!completedResumeRetriesRef.current.has(activeRunId)) {
            completedResumeRetriesRef.current.add(activeRunId);
            scheduleActiveRunRecovery();
          }
          return;
        }
        if (activeRunId && typeof activeRunId === "string") {
          setStreaming(true);
          activeRunIdRef.current = activeRunId;
          setActiveRunId(activeRunId);
          cancelRequestedRef.current = false;
          setCancelRequested(false);

          const assistantId = `resumed_${activeRunId}`;
          // Must use updateSessionMessages (not setMessages) so the placeholder
          // lands in msgCacheRef as well as React state. applyStreamEvent reads
          // from the cache — if the placeholder only lives in React state, stream
          // events can't find it and the first updateSessionMessages call
          // overwrites state back to the stale cache (losing the placeholder).
          updateSessionMessages(sessionId, (prev) => {
            if (prev.some((m) => m.id === assistantId)) return prev;
            return [
              ...prev,
              {
                id: assistantId,
                role: "assistant" as const,
                contentBlocks: [],
              },
            ];
          });

          // Reuse the shared stream event handler — eliminates ~70 lines of duplication
          const unsub = ws.onEvent((evt) => {
            if (submissionVersionRef.current !== resumeVersion || evt.runId !== activeRunId) return;

            // A resumed run may still be before its first token, so the routing
            // notice can arrive here for the first time.
            if (evt.type === "design.routing") {
              presentRoutingNotice(evt);
            }

            applyStreamEvent(evt, assistantId, sessionId);
            onStreamEvent?.(evt);

            // Fire canvas insertion callbacks for artifacts arriving after reconnect.
            // Skip if the backend already inserted the element (elementId in output).
            const wsBackendInserted =
              evt.type === "tool.completed" &&
              evt.output &&
              (typeof (evt.output as Record<string, unknown>).elementId === "string" ||
                typeof (evt.output as Record<string, unknown>).design_id === "string");
            if (
              evt.type === "tool.completed" &&
              evt.artifacts &&
              evt.toolName !== "screenshot_canvas" &&
              !wsBackendInserted
            ) {
              completedRunIdsRef.current.add(evt.runId);
              for (const artifact of evt.artifacts) {
                if (artifact.type === "image" && onImageGenerated) {
                  onImageGenerated(artifact as ImageArtifact);
                }
                if (artifact.type === "video" && onVideoGenerated) {
                  onVideoGenerated(artifact as VideoArtifact);
                }
              }
            }

            if (evt.type === "canvas.sync" && onCanvasSync) {
              onCanvasSync();
            }

            if (
              evt.type === "run.completed" ||
              evt.type === "run.failed" ||
              evt.type === "run.canceled"
            ) {
              clearActiveRun();
              setStreaming(false);
              unsub();
              detachResumedStreamRef.current = null;
              scheduleActiveRunRecovery();
            }
          });
          detachResumedStreamRef.current = unsub;
        } else {
          clearActiveRun();
          setStreaming(false);
        }
      });
    })();
  }, [
    ws.connected,
    ws,
    canvasId,
    sessionsLoading,
    applyStreamEvent,
    presentRoutingNotice,
    onStreamEvent,
    onImageGenerated,
    onVideoGenerated,
    onCanvasSync,
    activeSessionIdRef,
    reloadMessages,
    updateSessionMessages,
    setStreaming,
    initialPrompt,
    clearActiveRun,
    resumeRequest,
    scheduleActiveRunRecovery,
  ]);

  const displayedMessages = useMemo(() => projectGenerationMessages(messages), [messages]);

  // ── Collapsed state ──
  if (!open) {
    return (
      <div className="absolute right-3 top-3 z-20">
        <button
          onClick={onToggle}
          type="button"
          className="group inline-flex items-center gap-1 rounded-xl bg-card/80 backdrop-blur-sm border border-border px-2.5 py-1.5 text-xs text-foreground/60 shadow-sm hover:bg-card hover:text-foreground transition-colors cursor-pointer md:px-2.5 md:py-1.5 min-h-[36px] md:min-h-0"
        >
          <svg className="size-4 md:size-3.5" viewBox="0 0 24 24" fill="none">
            <path
              fill="currentColor"
              fillOpacity={0.9}
              d="M18.25 3c2.071 0 3.946 2.16 3.946 4.23L22 15.75a3.75 3.75 0 0 1-3.75 3.75h-2.874a.25.25 0 0 0-.16.058l-2.098 1.738a1.75 1.75 0 0 1-2.24-.007l-2.065-1.73a.25.25 0 0 0-.162-.059H5.75A3.75 3.75 0 0 1 2 15.75v-9A3.75 3.75 0 0 1 5.75 3zM7.5 10q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 7.5 10m4.5 0q-.053 0-.104.005a1.25 1.25 0 0 0-1.14 1.117l-.006.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 12 10m4.5 0q-.053 0-.105.005a1.25 1.25 0 0 0-1.138 1.117l-.007.128.007.128a1.25 1.25 0 1 0 1.37-1.371l-.02-.002A1 1 0 0 0 16.5 10"
            />
          </svg>
          对话
        </button>
      </div>
    );
  }

  // Shared event isolation — prevent keyboard/clipboard events from bleeding
  // into Excalidraw canvas when the sidebar has focus.
  const eventIsolationProps = {
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onKeyUp: (e: React.KeyboardEvent) => e.stopPropagation(),
    onCopy: (e: React.ClipboardEvent) => e.stopPropagation(),
    onCut: (e: React.ClipboardEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  };

  // The inner panel content is shared across all breakpoints.
  // Extracted as a variable to avoid duplicating the chat UI tree
  // between overlay (mobile/tablet) and inline (desktop) render paths.
  const panelContent = (
    <>
      {activeDesignId && (
        <div className="border-b px-4 py-2 text-xs text-muted-foreground">
          新设计目标：当前画板 · {activeDesignId.slice(0, 8)}
          （确认按钮仍执行原方案）
        </div>
      )}
      {/* Header */}
      <div className="flex min-h-[48px] items-center justify-between pl-4 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h2 className="text-sm font-semibold text-foreground shrink-0">
            Cromic Agent
          </h2>
          {!sessionsLoading && (
            <SessionSelector
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelectSession}
              onNewChat={handleNewChatClick}
              onDelete={handleDeleteSession}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setRunHistoryOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="运行历史"
            aria-label="打开运行历史"
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5m4-3v6l4 2"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            title="Collapse panel"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 3.25a.75.75 0 0 1 .75.75v16a.75.75 0 0 1-1.5 0V4A.75.75 0 0 1 4 3.25m9.47 2.22a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06l4.72-4.72H8a.75.75 0 0 1 0-1.5h10.19l-4.72-4.72a.75.75 0 0 1 0-1.06"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Disconnected banner */}
      {!ws.connected && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted border-b border-border">
          <div className="h-2 w-2 rounded-full bg-red-500 animate-[pulse_1.2s_ease-in-out_infinite]" />
          <span className="text-[11px] text-muted-foreground">
            连接已断开，正在重连...
          </span>
        </div>
      )}

      {/* Messages */}
      <ErrorBoundary
        onError={(err) =>
          console.error("[chat-sidebar] message area render crashed:", err)
        }
      >
        <div
          ref={messageListRef}
          className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-6 px-4 py-4"
          aria-live="polite"
          aria-relevant="additions"
        >
          {sessionsLoading || messagesLoading ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <ChatSkills onSelectSkill={handleSkillSelect} accessToken={accessToken} />
          ) : (
            displayedMessages.map((msg) => (
              <ChatMessage
                key={`${activeSessionId}:${msg.id}`}
                role={msg.role}
                contentBlocks={msg.contentBlocks}
                isStreaming={
                  streaming &&
                  msg.role === "assistant" &&
                  msg.id === messages[messages.length - 1]?.id
                }
                onConfirmAction={handleConfirmAction}
                onWaitGeneration={handleWaitGeneration}
                onRestoreGeneration={handleRestoreGeneration}
                onRetryRead={handleRetryRead}
                {...(msg.role === "user" ? {
                  onEditSend: (text: string) => handleEditSend(msg, text, activeSessionId),
                  editDisabled: streaming || !ws.connected,
                } : {})}
                {...(onOpenDesign ? { onOpenDesign } : {})}
              />
            ))
          )}
          {confirmedGenerationPending &&
            !messages.some((message) =>
              message.contentBlocks.some(
                (block) =>
                  block.type === "tool" &&
                  block.toolName === "generate_image" &&
                  block.status === "running",
              ),
            ) && (
              <ChatMessage
                role="assistant"
                contentBlocks={[
                  {
                    type: "tool",
                    toolCallId: "confirmed-generation-pending",
                    toolName: "generate_image",
                    status: "running",
                    output: { status: "submitting" },
                    outputSummary: "正在生成图片",
                  },
                ]}
                onWaitGeneration={handleWaitGeneration}
                onRestoreGeneration={handleRestoreGeneration}
                {...(onOpenDesign ? { onOpenDesign } : {})}
              />
            )}
          {floatingDialogClearance > 0 && (
            <div
              data-chat-dialog-clearance
              aria-hidden="true"
              className="shrink-0"
              style={{ height: floatingDialogClearance }}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
      </ErrorBoundary>

      {/* Input */}
      <div className="relative" data-chat-composer-shell>
        {clarificationDialogEl}
        {confirmationDialogEl}
        {atQuery !== null && mentionPickerItems.length > 0 && (
          <MessageMentionPicker
            items={mentionPickerItems}
            query={atQuery}
            onSelect={(item) => {
              handleMentionSelect(item);
              chatInputRef.current?.clearAtQuery();
              setAtQuery(null);
            }}
            onClose={() => setAtQuery(null)}
          />
        )}
        <ChatInput
          ref={chatInputRef}
          accessToken={accessToken}
          onSend={handleSend}
          disabled={streaming || sessionsLoading || messagesLoading || !ws.connected}
          running={streaming}
          canceling={cancelRequested}
          onCancel={handleCancelRun}
          attachments={imageAttachments}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          onRetryAttachment={retryUpload}
          isUploading={isUploading}
          onAtQuery={setAtQuery}
          mentions={messageMentions}
          onRemoveMention={handleRemoveMention}
          {...(selectedCanvasElements ? { selectedCanvasElements } : {})}
        />
      </div>
      {runHistoryOpen && (
        <RunHistoryPanel
          accessToken={accessToken}
          sessionId={activeSessionId}
          onClose={() => setRunHistoryOpen(false)}
        />
      )}
    </>
  );

  const creditDialogEl = creditDialog && (
    <CreditInsufficientDialog
      open={creditDialog.open}
      onClose={() => setCreditDialog(null)}
      currentBalance={creditDialog.currentBalance}
      requiredAmount={creditDialog.requiredAmount}
      plan={creditDialog.plan}
      dailyClaimed={creditDialog.dailyClaimed}
      onClaimDaily={async () => {
        await claimDailyCredits(accessTokenRef.current);
      }}
    />
  );

  // ── Mobile / Tablet: full-screen overlay with backdrop ──
  if (isOverlay) {
    return (
      <>
        {/* Semi-transparent backdrop — click to close */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop is a non-interactive dismissal layer, keyboard close is handled via Escape */}
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onClick={onToggle}
        />
        {/* Chat panel — full screen on mobile, fixed-width drawer on tablet */}
        <div
          ref={chatSidebarRef}
          className={
            breakpoint === "mobile"
              ? "fixed inset-0 z-50 flex flex-col bg-card animate-in slide-in-from-right duration-250"
              : "fixed inset-y-0 right-0 z-50 flex w-[400px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-250"
          }
          {...eventIsolationProps}
        >
          {panelContent}
        </div>
        {creditDialogEl}
      </>
    );
  }

  // ── Desktop: inline side-by-side with resize handle ──
  return (
    <div
      ref={chatSidebarRef}
      className="flex h-full shrink-0"
      style={{ width: sidebarWidth }}
      {...eventIsolationProps}
    >
      {/* Resize handle -- supports mouse, touch, and keyboard (ArrowLeft/ArrowRight) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        className="w-2 shrink-0 cursor-col-resize bg-gradient-to-r from-transparent via-border to-transparent shadow-[1px_0_10px_rgba(15,23,42,0.06)] transition-all hover:via-muted-foreground/40 hover:shadow-[1px_0_14px_rgba(15,23,42,0.1)] active:via-muted-foreground/60 active:shadow-[1px_0_16px_rgba(15,23,42,0.14)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="relative flex flex-1 flex-col bg-card min-w-0">
        {panelContent}
      </div>
      {creditDialogEl}
    </div>
  );
}
