import { z } from "zod";

const uuid = z.string().uuid();

export type MastraHistoricalUpload = {
  assetId: string;
  messageId: string;
  name?: string;
  promptExcerpt?: string;
  createdAt: string;
};

/** The signed URL in a chat block is display data, never an image carrier. */
export function historicalUploadsFromRows(rows: unknown, currentUserMessageId?: string): MastraHistoricalUpload[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const message = row as Record<string, unknown>;
    if (message.role !== "user" || !uuid.safeParse(message.id).success ||
      message.id === currentUserMessageId || typeof message.created_at !== "string" ||
      Number.isNaN(Date.parse(message.created_at)) || !Array.isArray(message.content_blocks)) return [];
    return message.content_blocks.flatMap(block => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const image = block as Record<string, unknown>;
      if (image.type !== "image" || image.source !== "upload" || !uuid.safeParse(image.assetId).success ||
        seen.has(image.assetId as string)) return [];
      seen.add(image.assetId as string);
      return [{ assetId: image.assetId as string, messageId: message.id as string,
        ...(typeof image.name === "string" && image.name.trim() ? { name: image.name.trim().slice(0, 160) } : {}),
        ...(typeof message.content === "string" && message.content.trim()
          ? { promptExcerpt: message.content.trim().slice(0, 500) } : {}),
        createdAt: new Date(message.created_at as string).toISOString() }];
    });
  });
}

/** Query only the authenticated session's actual user uploads. */
export async function loadMastraHistoricalUploads(input: {
  client: any;
  sessionId: string;
  currentUserMessageId?: string;
  assetIds?: readonly string[];
}): Promise<MastraHistoricalUpload[]> {
  const query = input.client.from("chat_messages")
    .select("id,role,content,content_blocks,created_at")
    .eq("session_id", input.sessionId).eq("role", "user")
    .contains("content_blocks", JSON.stringify([{ type: "image", source: "upload" }]));
  if (input.assetIds?.length) {
    const results = await Promise.all(input.assetIds.map(assetId =>
      queryForUpload(input.client, input.sessionId, assetId)));
    if (results.some(result => result.error)) throw new Error("historical_upload_history_unavailable");
    return historicalUploadsFromRows(results.flatMap(result => result.data ?? []), input.currentUserMessageId)
      .filter(upload => input.assetIds!.includes(upload.assetId));
  }
  const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(80);
  if (result.error) throw new Error("historical_upload_history_unavailable");
  return historicalUploadsFromRows(result.data, input.currentUserMessageId).slice(0, 8);
}

async function queryForUpload(client: any, sessionId: string, assetId: string) {
  return client.from("chat_messages").select("id,role,content,content_blocks,created_at")
    .eq("session_id", sessionId).eq("role", "user")
    .contains("content_blocks", JSON.stringify([{ type: "image", source: "upload", assetId }]))
    .order("created_at", { ascending: false }).limit(1);
}

/** Recheck the original message immediately before a paid image request. */
export async function verifyMastraHistoricalUpload(input: {
  client: any;
  sessionId: string;
  messageId: string;
  assetId: string;
}): Promise<void> {
  const result = await input.client.from("chat_messages").select("id,role,content_blocks")
    .eq("id", input.messageId).eq("session_id", input.sessionId).eq("role", "user").maybeSingle();
  if (result.error) throw new Error("historical_upload_history_unavailable");
  if (!result.data || !Array.isArray(result.data.content_blocks) ||
    !result.data.content_blocks.some((block: any) => block?.type === "image" &&
      block.source === "upload" && block.assetId === input.assetId))
    throw new Error("historical_upload_removed_or_out_of_scope");
}
