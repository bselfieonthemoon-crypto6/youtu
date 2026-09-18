import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { StreamEvent } from "@loomic/shared";

type PendingRPC = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  connectionId: string;
  ws: WebSocket;
};
type ActiveRun = { runId: string; startedAt: number; sessionId?: string };

export type ConnectionEntry = {
  ws: WebSocket;
  userId: string;
  /** Opaque, server-issued identity for this exact socket instance. */
  connectionId: string;
  /** Untrusted client hint retained for diagnostics only; never used for lookup. */
  requestedConnectionId: string;
  canvasId: string | null;
  workspaceId: string | null;
};

export type CanvasAuthorizationCheck = (input: {
  userId: string;
  canvasId: string;
}) => Promise<boolean>;

export type ConnectionManagerOptions = {
  authorizeCanvas?: CanvasAuthorizationCheck;
  onAuthorizationError?: (error: unknown) => void;
};

export class ConnectionManager {
  /** Primary store: connectionId -> entry */
  private connections = new Map<string, ConnectionEntry>();
  /** User-level index: userId -> set of connectionIds */
  private userIndex = new Map<string, Set<string>>();
  /** Canvas-level index: canvasId -> set of connectionIds */
  private canvasIndex = new Map<string, Set<string>>();
  /** Insertion order retains older in-flight runs beneath a newer conversation. */
  private activeRuns = new Map<string, Map<string, ActiveRun>>();
  /** Pending RPC calls, keyed by unique request UUID (unchanged) */
  private pendingRPCs = new Map<string, PendingRPC>();
  /** Preserve stream order even though legacy producers fire-and-forget. */
  private canvasSendQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ConnectionManagerOptions = {}) {}

  // ---------------------------------------------------------------------------
  // Registration & removal
  // ---------------------------------------------------------------------------

  /**
   * Register a socket under a fresh server identity. The client-provided ID is
   * never an ownership token: duplicate IDs (including same-user reconnects)
   * remain separate generations until their own sockets are removed.
   */
  register(requestedConnectionId: string, userId: string, ws: WebSocket): string {
    let connectionId = randomUUID();
    while (this.connections.has(connectionId)) connectionId = randomUUID();

    const entry: ConnectionEntry = {
      ws,
      userId,
      connectionId,
      requestedConnectionId,
      canvasId: null,
      workspaceId: null,
    };
    this.connections.set(connectionId, entry);

    let userSet = this.userIndex.get(userId);
    if (!userSet) {
      userSet = new Set();
      this.userIndex.set(userId, userSet);
    }
    userSet.add(connectionId);
    return connectionId;
  }

  /** Remove a connection from all indexes. */
  remove(connectionId: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;
    this.removeFromIndexes(connectionId, entry);
    this.connections.delete(connectionId);
    this.rejectPendingForConnection(connectionId);
  }

  /**
   * Associate a connection with a canvas.
   * Updates the canvasIndex so events can be broadcast to all viewers of that canvas.
   */
  bindCanvas(connectionId: string, canvasId: string, workspaceId?: string): void {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    // Remove from previous canvas index if switching canvases
    if (entry.canvasId && entry.canvasId !== canvasId) {
      const prevSet = this.canvasIndex.get(entry.canvasId);
      if (prevSet) {
        prevSet.delete(connectionId);
        if (prevSet.size === 0) this.canvasIndex.delete(entry.canvasId);
      }
    }

    entry.canvasId = canvasId;
    entry.workspaceId = workspaceId ?? null;

    let canvasSet = this.canvasIndex.get(canvasId);
    if (!canvasSet) {
      canvasSet = new Set();
      this.canvasIndex.set(canvasId, canvasSet);
    }
    canvasSet.add(connectionId);
  }

  /** Mark a run as active for a canvas. */
  setActiveRun(canvasId: string, runId: string, sessionId?: string): void {
    let runs = this.activeRuns.get(canvasId);
    if (!runs) {
      runs = new Map();
      this.activeRuns.set(canvasId, runs);
    }
    // Duplicate notifications do not promote an older run or reset its age.
    if (!runs.has(runId)) runs.set(runId, { runId, startedAt: Date.now(), ...(sessionId ? { sessionId } : {}) });
  }

  /** Remove exactly one completed/canceled run, restoring any older live run. */
  clearActiveRun(canvasId: string, runId: string): void {
    const runs = this.activeRuns.get(canvasId);
    if (!runs) return;
    runs.delete(runId);
    if (runs.size === 0) this.activeRuns.delete(canvasId);
  }

  /** Get active run info for a canvas, if any. */
  getActiveRun(canvasId: string): ActiveRun | null {
    const runs = this.activeRuns.get(canvasId);
    if (!runs) return null;
    const newest = [...runs.values()].at(-1);
    return newest ? { ...newest } : null;
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /** Get the WebSocket for a specific connection. */
  get(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId)?.ws;
  }

  /** Get the full ConnectionEntry for a specific connection. */
  getEntry(connectionId: string): ConnectionEntry | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get ANY open WebSocket for a user (backward compat).
   * Picks the first connection whose socket is still open.
   */
  getByUser(userId: string): WebSocket | undefined {
    const ids = this.userIndex.get(userId);
    if (!ids) return undefined;
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) return entry.ws;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Broadcasting (StreamEvent)
  // ---------------------------------------------------------------------------

  /** Send a StreamEvent to ALL connections viewing a specific canvas. */
  pushToCanvas(canvasId: string, event: StreamEvent): Promise<void> {
    const payload = JSON.stringify({ type: "event", event });
    return this.enqueueCanvasSend(canvasId, payload).then(() => undefined);
  }

  /** Send a StreamEvent to ALL connections for a user. */
  pushToUser(userId: string, event: StreamEvent): void {
    const ids = this.userIndex.get(userId);
    if (!ids) return;
    const payload = JSON.stringify({ type: "event", event });
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) {
        entry.ws.send(payload);
      }
    }
  }

  /**
   * Backward-compatible push: send a StreamEvent to ANY connection for a user.
   * Delegates to pushToUser (broadcasts to all).
   */
  push(userId: string, event: StreamEvent): void {
    this.pushToUser(userId, event);
  }

  // ---------------------------------------------------------------------------
  // Direct messaging
  // ---------------------------------------------------------------------------

  /** Send a raw JSON message to a specific connection. */
  sendTo(connectionId: string, message: Record<string, unknown>): boolean {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.ws.readyState !== 1) return false;
    entry.ws.send(JSON.stringify(message));
    return true;
  }

  /** Send sensitive direct data only after revalidating the current binding. */
  async sendToAuthorized(
    connectionId: string,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    const candidate = this.connections.get(connectionId);
    if (!candidate || candidate.ws.readyState !== 1) return false;
    if (!candidate.canvasId) return this.sendTo(connectionId, message);
    const entry = await this.authorizedEntry(connectionId, candidate.canvasId);
    if (!entry || entry.ws.readyState !== 1) return false;
    try {
      entry.ws.send(JSON.stringify(message));
      return true;
    } catch {
      this.remove(connectionId);
      return false;
    }
  }

  /**
   * Send a raw JSON message to ANY open connection for a user (backward compat).
   * Broadcasts to all open connections for the user and returns true if at least
   * one was delivered.
   */
  sendToUser(userId: string, message: Record<string, unknown>): boolean {
    const ids = this.userIndex.get(userId);
    if (!ids) return false;
    const payload = JSON.stringify(message);
    let delivered = false;
    for (const cid of ids) {
      const entry = this.connections.get(cid);
      if (entry && entry.ws.readyState === 1) {
        entry.ws.send(payload);
        delivered = true;
      }
    }
    return delivered;
  }

  /** Send a protocol-level message to every open connection viewing a canvas. */
  sendToCanvas(canvasId: string, message: Record<string, unknown>): Promise<boolean> {
    return this.enqueueCanvasSend(canvasId, JSON.stringify(message));
  }

  /**
   * Backward-compatible send: delegates to sendToUser.
   */
  send(userId: string, message: Record<string, unknown>): boolean {
    return this.sendToUser(userId, message);
  }

  // ---------------------------------------------------------------------------
  // RPC (unchanged semantics, keyed by UUID)
  // ---------------------------------------------------------------------------

  /**
   * RPC to a specific connection by connectionId.
   */
  async rpc<T = unknown>(
    connectionId: string,
    method: string,
    params: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<T> {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.ws.readyState !== 1) {
      throw new Error(`Connection ${connectionId} not available`);
    }
    if (entry.canvasId) {
      const authorized = await this.authorizedEntry(connectionId, entry.canvasId);
      if (!authorized) {
        throw new Error(`Connection ${connectionId} is no longer authorized`);
      }
    }

    const id = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRPCs.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRPCs.set(id, {
        resolve,
        reject,
        timer,
        connectionId,
        ws: entry.ws,
      });

      entry.ws.send(
        JSON.stringify({
          type: "rpc.request",
          id,
          method,
          params,
        }),
      );
    });
  }

  /**
   * Send an RPC only to a browser connection that is currently bound to the
   * requested canvas. This avoids selecting a home/settings tab for users who
   * have several Loomic tabs open.
   */
  async rpcToCanvas<T = unknown>(
    canvasId: string,
    method: string,
    params: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<T> {
    const ids = this.canvasIndex.get(canvasId);
    if (!ids) throw new Error(`Canvas connection ${canvasId} not available`);
    for (const connectionId of ids) {
      const entry = await this.authorizedEntry(connectionId, canvasId);
      if (entry?.ws.readyState === 1) {
        return this.rpc<T>(connectionId, method, params, timeout);
      }
    }
    throw new Error(`Canvas connection ${canvasId} not available`);
  }

  /**
   * Handle a response only when it comes from the exact socket generation that
   * received the request. Knowing another request UUID is not authorization.
   */
  handleRpcResponse(
    connectionId: string,
    msg: { type: "rpc.response"; id: string; result?: unknown; error?: string },
    sourceSocket?: WebSocket,
  ): boolean {
    const pending = this.pendingRPCs.get(msg.id);
    if (!pending) return false;

    const sourceEntry = this.connections.get(connectionId);
    if (
      !sourceEntry ||
      pending.connectionId !== connectionId ||
      pending.ws !== sourceEntry.ws ||
      (sourceSocket !== undefined && pending.ws !== sourceSocket)
    ) {
      return false;
    }

    this.pendingRPCs.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const pending of this.pendingRPCs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ConnectionManager disposed"));
    }
    this.pendingRPCs.clear();
    this.connections.clear();
    this.userIndex.clear();
    this.canvasIndex.clear();
    this.activeRuns.clear();
    this.canvasSendQueues.clear();
  }

  /** Apply a membership invalidation delivered by the durable fanout log. */
  revokeWorkspaceUser(workspaceId: string, userId: string): number {
    const ids = [...(this.userIndex.get(userId) ?? [])];
    let revoked = 0;
    for (const connectionId of ids) {
      const entry = this.connections.get(connectionId);
      if (!entry || entry.workspaceId !== workspaceId) continue;
      this.remove(connectionId);
      revoked += 1;
      if (entry.ws.readyState === 1) {
        entry.ws.close(4003, "Workspace access changed; reconnect required");
      }
    }
    return revoked;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private removeFromIndexes(connectionId: string, entry: ConnectionEntry): void {
    // Remove from user index
    const userSet = this.userIndex.get(entry.userId);
    if (userSet) {
      userSet.delete(connectionId);
      if (userSet.size === 0) this.userIndex.delete(entry.userId);
    }

    // Remove from canvas index
    if (entry.canvasId) {
      const canvasSet = this.canvasIndex.get(entry.canvasId);
      if (canvasSet) {
        canvasSet.delete(connectionId);
        if (canvasSet.size === 0) this.canvasIndex.delete(entry.canvasId);
      }
    }
  }

  private async authorizedEntry(
    connectionId: string,
    canvasId: string,
  ): Promise<ConnectionEntry | undefined> {
    const candidate = this.connections.get(connectionId);
    if (!candidate || candidate.canvasId !== canvasId) return undefined;
    // A null workspace marks legacy conversation routing rather than a
    // persisted canvas. Real canvas binds always include their authorized
    // workspace and must pass the database gate below.
    if (!candidate.workspaceId || !this.options.authorizeCanvas) return candidate;

    let authorized = false;
    try {
      authorized = await this.options.authorizeCanvas({
        userId: candidate.userId,
        canvasId,
      });
    } catch (error) {
      // Database or checker errors fail closed, including when callers do not
      // await a fire-and-forget push.
      this.options.onAuthorizationError?.(error);
    }

    // A late check must never authorize a reconnected socket or a new canvas.
    const current = this.connections.get(connectionId);
    if (current !== candidate || current.canvasId !== canvasId) return undefined;
    if (authorized) return current;

    this.remove(connectionId);
    if (current.ws.readyState === 1) {
      current.ws.close(4003, "Canvas access changed; reconnect required");
    }
    return undefined;
  }

  private enqueueCanvasSend(canvasId: string, payload: string): Promise<boolean> {
    const previous = this.canvasSendQueues.get(canvasId) ?? Promise.resolve();
    const queued = previous.then(async () => {
      const ids = [...(this.canvasIndex.get(canvasId) ?? [])];
      let delivered = false;
      for (const connectionId of ids) {
        const entry = await this.authorizedEntry(connectionId, canvasId);
        if (!entry || entry.ws.readyState !== 1) continue;
        try {
          entry.ws.send(payload);
          delivered = true;
        } catch {
          this.remove(connectionId);
        }
      }
      return delivered;
    });
    // Keep the chain usable after an unexpected implementation error and
    // prevent ignored push promises from surfacing as unhandled rejections.
    const safe = queued.catch((error) => {
      this.options.onAuthorizationError?.(error);
      return false;
    });
    this.canvasSendQueues.set(canvasId, safe);
    void safe.finally(() => {
      if (this.canvasSendQueues.get(canvasId) === safe) {
        this.canvasSendQueues.delete(canvasId);
      }
    });
    return safe;
  }

  private rejectPendingForConnection(connectionId: string): void {
    for (const [requestId, pending] of this.pendingRPCs) {
      if (pending.connectionId !== connectionId) continue;
      this.pendingRPCs.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error(`Connection ${connectionId} disconnected`));
    }
  }
}
