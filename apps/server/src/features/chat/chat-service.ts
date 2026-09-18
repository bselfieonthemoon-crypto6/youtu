import type {
  ChatMessage,
  ChatMessageCreateRequest,
  ChatSessionSummary,
  ContentBlock,
  Json,
} from "@loomic/shared";

import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import type { ThreadService } from "./thread-service.js";

export class ChatServiceError extends Error {
  readonly statusCode: number;
  readonly code: "chat_error" | "session_not_found" | "chat_message_not_found";

  constructor(
    code: "chat_error" | "session_not_found" | "chat_message_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ChatService = {
  listSessions(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<ChatSessionSummary[]>;
  createSession(
    user: AuthenticatedUser,
    canvasId: string,
    title?: string,
  ): Promise<ChatSessionSummary>;
  updateSessionTitle(
    user: AuthenticatedUser,
    sessionId: string,
    title: string,
  ): Promise<void>;
  deleteSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<void>;
  listMessages(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<ChatMessage[]>;
  createMessage(
    user: AuthenticatedUser,
    sessionId: string,
    input: ChatMessageCreateRequest,
  ): Promise<ChatMessage>;
  /**
   * Drop a message and every later message in the session.
   *
   * This is the server half of "edit and resend": the replacement turn must not
   * leave the superseded attempt (its assistant reply, and any generation card
   * inside it) visible above the new one. Returns the removed ids so the caller
   * can also stop the jobs those messages projected — an assistant placeholder's
   * id IS its job id.
   */
  truncateFrom(
    user: AuthenticatedUser,
    sessionId: string,
    fromMessageId: string,
  ): Promise<{ deleted: number; deletedIds: string[] }>;
};

/**
 * Synthesize content blocks from legacy `content` + `tool_activities` columns.
 * Produces the same ordering the old client saw: text first, then tool blocks.
 */
function synthesizeLegacyBlocks(
  content: string | null,
  toolActivities: unknown[] | null,
): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  if (content) {
    blocks.push({ type: "text", text: content });
  }
  if (toolActivities && Array.isArray(toolActivities)) {
    for (const t of toolActivities) {
      blocks.push({ type: "tool", ...(t as Omit<ContentBlock & { type: "tool" }, "type">) });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

export function createChatService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  threadService: Pick<ThreadService, "createThreadId">;
}): ChatService {
  async function requireVisibleRow(
    client: UserSupabaseClient,
    table: "canvases" | "chat_sessions",
    id: string,
  ): Promise<void> {
    const { data, error } = await client
      .from(table)
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new ChatServiceError("chat_error", "Failed to verify chat access.", 500);
    }
    if (!data) {
      // RLS deliberately makes an inaccessible row indistinguishable from a
      // missing one. Keep that boundary in the API response as well.
      throw new ChatServiceError("session_not_found", "Chat target not found.", 404);
    }
  }

  function writeAccessRace(error: { code?: string } | null | undefined): ChatServiceError | null {
    // A membership/canvas change can occur after the RLS read above. Supabase
    // reports that write-side policy race as 42501; do not turn it into a
    // retryable server failure or reveal whether the target previously existed.
    if (error?.code === "42501") {
      return new ChatServiceError("session_not_found", "Chat target not found.", 404);
    }
    return null;
  }

  return {
    async listSessions(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .select("id, title, updated_at")
        .eq("canvas_id", canvasId)
        .order("updated_at", { ascending: false });

      if (error) {
        throw new ChatServiceError("chat_error", "Failed to list sessions.", 500);
      }

      return (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },

    async createSession(user, canvasId, title) {
      const client = options.createUserClient(user.accessToken);
      await requireVisibleRow(client, "canvases", canvasId);
      const { data, error } = await client
        .from("chat_sessions")
        .insert({
          canvas_id: canvasId,
          created_by: user.id,
          thread_id: options.threadService.createThreadId(),
          ...(title ? { title } : {}),
        })
        .select("id, title, updated_at")
        .single();

      const accessRace = writeAccessRace(error);
      if (accessRace) throw accessRace;
      if (error || !data) {
        throw new ChatServiceError("chat_error", "Failed to create session.", 500);
      }

      return {
        id: data.id,
        title: data.title,
        updatedAt: data.updated_at,
      };
    },

    async updateSessionTitle(user, sessionId, title) {
      const client = options.createUserClient(user.accessToken);
      const { error, count } = await client
        .from("chat_sessions")
        .update({ title }, { count: "exact" })
        .eq("id", sessionId);

      if (error) {
        throw new ChatServiceError("chat_error", "Failed to update session title.", 500);
      }
      if (count === 0) {
        throw new ChatServiceError("session_not_found", "Session not found.", 404);
      }
    },

    async deleteSession(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { error, count } = await client
        .from("chat_sessions")
        .delete({ count: "exact" })
        .eq("id", sessionId);

      if (error || count === 0) {
        throw new ChatServiceError("session_not_found", "Session not found.", 404);
      }
    },

    async listMessages(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_messages")
        .select("id, role, content, tool_activities, content_blocks, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (error) {
        throw new ChatServiceError("chat_error", "Failed to list messages.", 500);
      }

      const rows = (data ?? []).map((row) => {
        const contentBlocks =
          Array.isArray(row.content_blocks) && row.content_blocks.length > 0
            ? (row.content_blocks as ContentBlock[])
            : synthesizeLegacyBlocks(
                row.content,
                row.tool_activities as unknown[] | null,
              );

        return {
          id: row.id,
          role: row.role as "user" | "assistant",
          content: row.content,
          toolActivities: row.tool_activities as ChatMessage["toolActivities"],
          contentBlocks,
          createdAt: row.created_at,
        };
      });

      // Deduplicate consecutive messages with same role + content
      // (caused by dual client+server save in earlier versions)
      return rows.filter(
        (msg, i) =>
          i === 0 ||
          msg.role !== rows[i - 1]!.role ||
          msg.content !== rows[i - 1]!.content,
      );
    },

    async createMessage(user, sessionId, input) {
      const client = options.createUserClient(user.accessToken);
      await requireVisibleRow(client, "chat_sessions", sessionId);
      const inserted = await client
        .from("chat_messages")
        .insert({
          ...(input.id ? { id: input.id } : {}),
          session_id: sessionId,
          role: input.role,
          content: input.content,
          ...(input.toolActivities
            ? { tool_activities: input.toolActivities as unknown as Json }
            : {}),
          ...(input.contentBlocks
            ? { content_blocks: input.contentBlocks as unknown as Json }
            : {}),
        })
        .select("id, role, content, tool_activities, content_blocks, created_at")
        .single();
      let data = inserted.data;
      if (inserted.error?.code === "23505" && input.id) {
        const existing = await client
          .from("chat_messages")
          .select("id, role, content, tool_activities, content_blocks, created_at")
          .eq("id", input.id)
          .eq("session_id", sessionId)
          .maybeSingle();
        if (!existing.error && existing.data?.role === input.role && existing.data.content === input.content)
          data = existing.data;
      }
      const accessRace = writeAccessRace(inserted.error);
      if (accessRace) throw accessRace;
      if (!data) {
        throw new ChatServiceError("chat_error", "Failed to save message.", 500);
      }

      // Touch session updated_at
      await client
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId);

      const contentBlocks =
        Array.isArray(data.content_blocks) && data.content_blocks.length > 0
          ? (data.content_blocks as ContentBlock[])
          : synthesizeLegacyBlocks(
              data.content,
              data.tool_activities as unknown[] | null,
            );

      return {
        id: data.id,
        role: data.role as "user" | "assistant",
        content: data.content,
        toolActivities: data.tool_activities as ChatMessage["toolActivities"],
        contentBlocks,
        createdAt: data.created_at,
      };
    },

    async truncateFrom(user, sessionId, fromMessageId) {
      const client = options.createUserClient(user.accessToken);
      await requireVisibleRow(client, "chat_sessions", sessionId);
      // Resolve the cut from conversation ORDER rather than a timestamp
      // comparison: `now()` is stable inside a transaction, so two rows inserted
      // by the same RPC can share created_at and a `>` filter would silently keep
      // the superseded reply.
      const { data, error } = await client
        .from("chat_messages")
        .select("id")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) {
        throw new ChatServiceError("chat_error", "Failed to read messages.", 500);
      }
      const ids = (data ?? []).map((row) => row.id);
      const start = ids.indexOf(fromMessageId);
      // RLS makes a foreign message indistinguishable from a missing one; keep
      // that boundary instead of revealing whether it exists elsewhere.
      if (start === -1) {
        throw new ChatServiceError("chat_message_not_found", "Message not found.", 404);
      }
      const doomed = ids.slice(start);
      // Chunk the id list: a long conversation would otherwise overflow the
      // PostgREST URL, and a partial delete is worse than a retried one.
      const CHUNK = 100;
      let deleted = 0;
      for (let index = 0; index < doomed.length; index += CHUNK) {
        const { error: deleteError, count } = await client
          .from("chat_messages")
          .delete({ count: "exact" })
          .in("id", doomed.slice(index, index + CHUNK));
        const accessRace = writeAccessRace(deleteError);
        if (accessRace) throw accessRace;
        if (deleteError) {
          throw new ChatServiceError("chat_error", "Failed to truncate messages.", 500);
        }
        deleted += count ?? 0;
      }
      return { deleted, deletedIds: doomed };
    },
  };
}
