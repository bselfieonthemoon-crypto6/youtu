import { z } from "zod";
import { runCreateRequestSchema } from "./contracts.js";
import { designSyncEventSchema } from "./design-contracts.js";
import { streamEventSchema } from "./events.js";

// --- Server → Client: Push Event (replaces SSE) ---

export const wsServerEventSchema = z.object({
  type: z.literal("event"),
  event: streamEventSchema,
});

// --- Server → Client: RPC Request ---

export const wsRpcRequestSchema = z.object({
  type: z.literal("rpc.request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

// --- Server → Client: Command Ack ---

export const wsCommandAckSchema = z.object({
  type: z.literal("command.ack"),
  action: z.string().min(1),
  requestId: z.string().min(1).max(128).optional(),
  payload: z.record(z.unknown()),
});

// --- Client → Server: Command ---

const commandCredentials = {
  accessToken: z.string().min(1).max(16384).optional(),
  requestId: z.string().min(1).max(128).optional(),
};

export const wsRunCommandSchema = z.object({
  ...commandCredentials,
  type: z.literal("command"),
  action: z.literal("agent.run"),
  // Reuse the HTTP contract, including bounded, evidence-only canvasSelection.
  payload: runCreateRequestSchema,
});

export const wsCancelCommandSchema = z.object({
  ...commandCredentials,
  type: z.literal("command"),
  action: z.literal("agent.cancel"),
  payload: z.object({ runId: z.string().min(1) }),
});

export const wsConfirmActionCommandSchema = z
  .object({
    ...commandCredentials,
    type: z.literal("command"),
    action: z.literal("agent.confirm_action"),
    payload: z
      .object({
        confirmationId: z.string().uuid(),
        decision: z.enum(["confirm", "cancel"]),
      })
      .strict(),
  })
  .strict();

export const wsRetryToolCommandSchema = z.object({
  ...commandCredentials,
  type: z.literal("command"),
  action: z.literal("agent.retry_tool"),
  payload: z
    .object({
      toolExecutionId: z.string().uuid(),
      requestId: z.string().uuid(),
    })
    .strict(),
});

export const wsResumeCommandSchema = z.object({
  ...commandCredentials,
  type: z.literal("command"),
  action: z.literal("canvas.resume"),
  payload: z.object({
    canvasId: z.string().min(1),
    lastSeq: z.number().int().min(0).default(0),
  }),
});

export const wsCommandSchema = z.discriminatedUnion("action", [
  wsRunCommandSchema,
  wsCancelCommandSchema,
  wsConfirmActionCommandSchema,
  wsRetryToolCommandSchema,
  wsResumeCommandSchema,
]);

// --- Client → Server: RPC Response ---

export const wsRpcResponseSchema = z.object({
  type: z.literal("rpc.response"),
  id: z.string().min(1),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

// --- Union: Client → Server ---
// Uses z.union instead of z.discriminatedUnion because wsCommandSchema is itself
// a discriminated union (by "action"), which Zod v3 does not support as a nested
// element in another discriminatedUnion.

export const wsClientMessageSchema = z.union([
  wsRunCommandSchema,
  wsCancelCommandSchema,
  wsConfirmActionCommandSchema,
  wsRetryToolCommandSchema,
  wsResumeCommandSchema,
  wsRpcResponseSchema,
]);

// --- Union: Server → Client ---

export const wsServerMessageSchema = z.union([
  wsServerEventSchema,
  wsRpcRequestSchema,
  wsCommandAckSchema,
  designSyncEventSchema,
]);

// --- Type exports ---

export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
export type WsRpcRequest = z.infer<typeof wsRpcRequestSchema>;
export type WsCommandAck = z.infer<typeof wsCommandAckSchema>;
export type WsRunCommand = z.infer<typeof wsRunCommandSchema>;
export type WsCancelCommand = z.infer<typeof wsCancelCommandSchema>;
export type WsConfirmActionCommand = z.infer<
  typeof wsConfirmActionCommandSchema
>;
export type WsRetryToolCommand = z.infer<typeof wsRetryToolCommandSchema>;
export type WsResumeCommand = z.infer<typeof wsResumeCommandSchema>;
export type WsCommand = z.infer<typeof wsCommandSchema>;
export type WsRpcResponse = z.infer<typeof wsRpcResponseSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

// --- Screenshot-specific params/result ---

export const screenshotParamsSchema = z.object({
  mode: z.enum(["full", "region", "viewport"]),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  max_dimension: z.number().default(1024),
});

export const screenshotResultSchema = z.object({
  url: z.string().min(1),
  width: z.number(),
  height: z.number(),
});

export type ScreenshotParams = z.infer<typeof screenshotParamsSchema>;
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;
