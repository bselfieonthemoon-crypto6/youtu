import type {
  AgentExecutionMode,
  ImageAttachment,
  ImageGenerationPreference,
  MessageMention,
  StreamEvent,
  VideoGenerationPreference,
} from "@loomic/shared";

/**
 * The authenticated, server-owned input for one Mastra turn.
 *
 * This deliberately excludes legacy task, autonomy, proposal-confirmation and
 * continuation runtime state.  The access token is an in-memory capability
 * for authenticated tool dependencies only; implementations must never place
 * it in prompts, events, errors, metrics or logs.
 */
export type MastraRunInput = {
  runId: string;
  conversationId: string;
  sessionId: string;
  canvasId?: string;
  userMessageId?: string;
  userId?: string;
  workspaceId?: string;
  accessToken?: string;
  threadId?: string;
  prompt: string;
  model?: string;
  executionMode: AgentExecutionMode;
  attachments: ImageAttachment[];
  mentions: MessageMention[];
  canvasSelection?: { elementIds: string[] };
  activeDesignId?: string;
  imageGenerationPreference?: ImageGenerationPreference;
  videoGenerationPreference?: VideoGenerationPreference;
  signal: AbortSignal;
};

/** A framework boundary: Mastra emits the existing public StreamEvent format. */
export type MastraRunFactory = (
  input: MastraRunInput,
) => AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>;
