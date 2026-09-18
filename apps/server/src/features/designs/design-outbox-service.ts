import { randomUUID } from "node:crypto";

import {
  type DesignEventOutboxDto,
  type DesignSyncEvent,
  designEventOutboxDtoSchema,
  designSyncEventSchema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";

export type DesignOutboxRepository = {
  claim(input: {
    claimToken: string;
    limit: number;
    now: string;
  }): Promise<DesignEventOutboxDto[]>;
  markPublished(input: {
    eventId: string;
    claimToken: string;
    publishedAt: string;
  }): Promise<boolean>;
  markFailed(input: {
    eventId: string;
    claimToken: string;
    error: string;
    now: string;
  }): Promise<boolean>;
  reconcile(now: string): Promise<number>;
};

export type DesignSyncBroadcaster = {
  broadcast(designId: string, event: DesignSyncEvent): Promise<void>;
};

export type DesignOutboxRun = {
  claimed: number;
  published: number;
  failed: number;
};

export class DesignOutboxService {
  constructor(
    private readonly repository: DesignOutboxRepository,
    private readonly broadcaster: DesignSyncBroadcaster,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<number> {
    return this.repository.reconcile(this.now().toISOString());
  }

  async publishBatch(limit = 25): Promise<DesignOutboxRun> {
    const claimToken = randomUUID();
    const claimedAt = this.now().toISOString();
    const events = await this.repository.claim({
      claimToken,
      limit: Math.min(100, Math.max(1, limit)),
      now: claimedAt,
    });
    let published = 0;
    let failed = 0;

    for (const row of events) {
      try {
        // WebSocket accepts only the top-level design.sync envelope. Keeping
        // the parse here prevents malformed durable payloads from escaping.
        const event = designSyncEventSchema.parse(row.payload);
        await this.broadcaster.broadcast(row.design_id, event);
        const marked = await this.repository.markPublished({
          eventId: row.id,
          claimToken,
          publishedAt: this.now().toISOString(),
        });
        if (!marked) throw new Error("outbox_claim_lost");
        published += 1;
      } catch (error) {
        failed += 1;
        await this.repository.markFailed({
          eventId: row.id,
          claimToken,
          error: error instanceof Error ? error.message : String(error),
          now: this.now().toISOString(),
        });
      }
    }

    return { claimed: events.length, published, failed };
  }
}

export function startDesignOutboxDispatcher(
  service: Pick<DesignOutboxService, "publishBatch" | "reconcile">,
  options: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  const onError =
    options.onError ??
    ((error) => console.error("Design outbox dispatch failed:", error));
  let active = true;
  let running = false;

  const tick = async () => {
    if (!active || running) return;
    running = true;
    try {
      await service.reconcile();
      await service.publishBatch(25);
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
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<RpcResult> {
  return (
    admin.rpc as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<RpcResult>
  )(functionName, parameters);
}

export function createSupabaseDesignOutboxRepository(
  getAdminClient: () => AdminSupabaseClient,
): DesignOutboxRepository {
  return {
    async claim(input) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_design_outbox_claim",
        {
          p_limit: input.limit,
          p_claim_token: input.claimToken,
          p_now: input.now,
        },
      );
      if (error) throw new Error(error.message ?? "outbox_claim_failed");
      return designEventOutboxDtoSchema.array().parse(data ?? []);
    },
    async markPublished(input) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_design_outbox_mark_published",
        {
          p_event_id: input.eventId,
          p_claim_token: input.claimToken,
          p_published_at: input.publishedAt,
        },
      );
      if (error)
        throw new Error(error.message ?? "outbox_mark_published_failed");
      return data === true;
    },
    async markFailed(input) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_design_outbox_mark_failed",
        {
          p_event_id: input.eventId,
          p_claim_token: input.claimToken,
          p_error: input.error,
          p_now: input.now,
        },
      );
      if (error) throw new Error(error.message ?? "outbox_mark_failed_failed");
      return data === true;
    },
    async reconcile(now) {
      const { data, error } = await callRpc(
        getAdminClient(),
        "loomic_design_outbox_reconcile",
        { p_now: now },
      );
      if (error) throw new Error(error.message ?? "outbox_reconcile_failed");
      return typeof data === "number" ? data : 0;
    },
  };
}

export function createConnectionManagerDesignBroadcaster(options: {
  getAdminClient: () => AdminSupabaseClient;
  connections: ConnectionManager;
}): DesignSyncBroadcaster {
  return {
    async broadcast(designId, rawEvent) {
      const event = designSyncEventSchema.parse(rawEvent);
      const { data, error } = await options
        .getAdminClient()
        .from("design_nodes")
        .select("canvas_id")
        .eq("design_id", designId);
      if (error) throw new Error(`design_node_lookup_failed:${error.message}`);
      const canvasIds = new Set((data ?? []).map((row) => row.canvas_id));
      for (const canvasId of canvasIds) {
        await options.connections.sendToCanvas(canvasId, event);
      }
    },
  };
}
