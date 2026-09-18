import { randomUUID } from "node:crypto";
import { z } from "zod";

import { designSyncEventSchema } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { DesignSyncBroadcaster } from "../designs/design-outbox-service.js";

const realtimeEventSchema = z.object({
  event_id: z.string().regex(/^\d+$/),
  event_type: z.enum(["design.sync", "workspace.membership.changed"]),
  aggregate_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  payload: z.unknown(),
  created_at: z.string(),
});

const membershipChangedSchema = z.object({
  type: z.literal("workspace.membership.changed"),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  change: z.enum(["removed", "role_changed"]),
});

export type RealtimeFanoutEvent = z.infer<typeof realtimeEventSchema>;

export type RealtimeFanoutRepository = {
  register(consumerId: string): Promise<void>;
  poll(consumerId: string, limit: number): Promise<RealtimeFanoutEvent[]>;
  acknowledge(consumerId: string, eventId: string): Promise<boolean>;
  unregister(consumerId: string): Promise<void>;
};

export class RealtimeFanoutService {
  readonly consumerId: string;
  private registered = false;

  constructor(
    private readonly repository: RealtimeFanoutRepository,
    private readonly designBroadcaster: DesignSyncBroadcaster,
    private readonly connections: ConnectionManager,
    consumerId = randomUUID(),
  ) {
    this.consumerId = consumerId;
  }

  async initialize(): Promise<void> {
    if (this.registered) return;
    await this.repository.register(this.consumerId);
    this.registered = true;
  }

  async publishBatch(limit = 25): Promise<{ delivered: number; failed: number }> {
    if (!this.registered) throw new Error("realtime_consumer_not_registered");
    const rows = await this.repository.poll(
      this.consumerId,
      Math.min(100, Math.max(1, limit)),
    );
    let delivered = 0;

    // Process and acknowledge strictly in sequence. A failure stops the batch,
    // leaving the cursor before that event so a later tick retries it. If the
    // send succeeded but acknowledgement was lost, redelivery is intentional.
    for (const rawRow of rows) {
      const row = realtimeEventSchema.parse(rawRow);
      try {
        await this.deliver(row);
        const acknowledged = await this.repository.acknowledge(
          this.consumerId,
          row.event_id,
        );
        if (!acknowledged) throw new Error("realtime_cursor_lost");
        delivered += 1;
      } catch {
        return { delivered, failed: 1 };
      }
    }
    return { delivered, failed: 0 };
  }

  async dispose(): Promise<void> {
    if (!this.registered) return;
    this.registered = false;
    await this.repository.unregister(this.consumerId);
  }

  private async deliver(row: RealtimeFanoutEvent): Promise<void> {
    if (row.event_type === "design.sync") {
      const event = designSyncEventSchema.parse(row.payload);
      if (event.designId !== row.aggregate_id) {
        throw new Error("design_fanout_scope_mismatch");
      }
      await this.designBroadcaster.broadcast(
        row.aggregate_id,
        event,
      );
      return;
    }

    const event = membershipChangedSchema.parse(row.payload);
    if (
      event.workspaceId !== row.workspace_id ||
      event.workspaceId !== row.aggregate_id
    ) {
      throw new Error("membership_fanout_scope_mismatch");
    }
    this.connections.revokeWorkspaceUser(event.workspaceId, event.userId);
  }
}

export function startRealtimeFanoutDispatcher(
  service: Pick<RealtimeFanoutService, "publishBatch">,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const intervalMs = Math.max(100, options.intervalMs ?? 500);
  const onError =
    options.onError ??
    ((error) => console.error("Realtime fanout dispatch failed:", error));
  let active = true;
  let running = false;
  const tick = async () => {
    if (!active || running) return;
    running = true;
    try {
      const result = await service.publishBatch(25);
      if (result.failed > 0) onError(new Error("realtime_fanout_delivery_failed"));
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => {
    active = false;
    clearInterval(timer);
  };
}

type RpcResult = { data: unknown; error: { message?: string } | null };

function callRpc(
  admin: AdminSupabaseClient,
  name: string,
  parameters: Record<string, unknown>,
): Promise<RpcResult> {
  return (
    admin.rpc as unknown as (
      functionName: string,
      args: Record<string, unknown>,
    ) => Promise<RpcResult>
  )(name, parameters);
}

export function createSupabaseRealtimeFanoutRepository(
  getAdminClient: () => AdminSupabaseClient,
): RealtimeFanoutRepository {
  return {
    async register(consumerId) {
      const { error } = await callRpc(
        getAdminClient(),
        "loomic_realtime_consumer_register",
        { p_consumer_id: consumerId },
      );
      if (error) throw new Error(error.message ?? "realtime_register_failed");
    },
    async poll(consumerId, limit) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_realtime_consumer_poll",
        { p_consumer_id: consumerId, p_limit: limit },
      );
      if (error) throw new Error(error.message ?? "realtime_poll_failed");
      return realtimeEventSchema.array().parse(data ?? []);
    },
    async acknowledge(consumerId, eventId) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_realtime_consumer_ack",
        { p_consumer_id: consumerId, p_event_id: eventId },
      );
      if (error) throw new Error(error.message ?? "realtime_ack_failed");
      return data === true;
    },
    async unregister(consumerId) {
      const { error } = await callRpc(
        getAdminClient(),
        "loomic_realtime_consumer_unregister",
        { p_consumer_id: consumerId },
      );
      if (error) throw new Error(error.message ?? "realtime_unregister_failed");
    },
  };
}

export function createSupabaseCanvasAuthorizationCheck(
  getAdminClient: () => AdminSupabaseClient,
) {
  return async (input: { userId: string; canvasId: string }): Promise<boolean> => {
    const { data, error } = await callRpc(
      getAdminClient(),
      "loomic_realtime_canvas_authorized",
      { p_user_id: input.userId, p_canvas_id: input.canvasId },
    );
    if (error) throw new Error(error.message ?? "canvas_authorization_failed");
    return data === true;
  };
}
