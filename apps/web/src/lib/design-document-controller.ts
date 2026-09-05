import {
  type DesignCommand,
  type DesignDocumentDto,
  type DesignSyncEvent,
  designCommandSchema,
  designMutationRequestSchema,
  designSyncEventSchema,
  designUuidSchema,
} from "@loomic/shared";

import { type DesignApiClient, DesignApiError } from "./design-api";

export type DesignControllerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "conflict"
  | "reload_required"
  | "error";

export type DesignPreviewStatus =
  | "loading"
  | "ready"
  | "saving"
  | "generating"
  | "preview_stale"
  | "error"
  | "missing";

export type DesignPreviewPresentation = {
  status: DesignPreviewStatus;
  assetObjectId: string | null;
  previewRevision: number;
  documentRevision: number | null;
  placeholder: "none" | "loading" | "stale" | "error" | "missing";
  canRetry: boolean;
};

export type DesignControllerState = {
  designId: string;
  status: DesignControllerStatus;
  document: DesignDocumentDto | null;
  authoritativeRevision: number | null;
  pendingCommands: readonly DesignCommand[];
  mutationIdempotencyKey: string | null;
  mutationExpectedRevision: number | null;
  previewJobId: string | null;
  preview: DesignPreviewPresentation;
  error: string | null;
};

export type PendingReloadPolicy = "preserve" | "discard" | "rebase";
export type DesignControllerListener = (state: DesignControllerState) => void;

type ControllerClient = Pick<
  DesignApiClient,
  "getDesign" | "mutateDesign" | "queueDesignPreview"
>;

type PreviewTransient = {
  status: "generating" | "error";
  revision: number;
  jobId: string | null;
};

export class StableIdempotencyKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly createId: () => string = createUuid) {}

  get(scope: string): string {
    const existing = this.keys.get(scope);
    if (existing) return existing;
    const created = designUuidSchema.parse(this.createId());
    this.keys.set(scope, created);
    return created;
  }

  rotate(scope: string): string {
    this.keys.delete(scope);
    return this.get(scope);
  }

  release(scope: string, expectedKey?: string): void {
    if (expectedKey && this.keys.get(scope) !== expectedKey) return;
    this.keys.delete(scope);
  }
}

export function createDesignDocumentController(options: {
  client: ControllerClient;
  accessToken: string;
  designId: string;
  initialDocument?: DesignDocumentDto;
  idempotencyKeys?: StableIdempotencyKeys;
}) {
  return new DesignDocumentController(options);
}

export class DesignDocumentController {
  private readonly client: ControllerClient;
  private readonly accessToken: string;
  private readonly designId: string;
  private readonly keys: StableIdempotencyKeys;
  private readonly listeners = new Set<DesignControllerListener>();
  private document: DesignDocumentDto | null;
  private authoritativeRevision: number | null;
  private status: DesignControllerStatus;
  private commands: DesignCommand[] = [];
  private mutationKey: string | null = null;
  private mutationExpectedRevision: number | null = null;
  private previewTransient: PreviewTransient | null = null;
  private error: string | null = null;

  constructor(options: {
    client: ControllerClient;
    accessToken: string;
    designId: string;
    initialDocument?: DesignDocumentDto;
    idempotencyKeys?: StableIdempotencyKeys;
  }) {
    this.client = options.client;
    this.accessToken = options.accessToken;
    this.designId = designUuidSchema.parse(options.designId);
    this.keys = options.idempotencyKeys ?? new StableIdempotencyKeys();
    this.document = options.initialDocument ?? null;
    if (this.document && this.document.id !== this.designId) {
      throw new Error("Initial document does not match the controller design.");
    }
    this.authoritativeRevision = this.document?.revision ?? null;
    this.status = this.document ? "ready" : "idle";
  }

  getState(): DesignControllerState {
    return {
      designId: this.designId,
      status: this.status,
      document: this.document,
      authoritativeRevision: this.authoritativeRevision,
      pendingCommands: [...this.commands],
      mutationIdempotencyKey: this.mutationKey,
      mutationExpectedRevision: this.mutationExpectedRevision,
      previewJobId: this.previewTransient?.jobId ?? null,
      preview: deriveDesignPreviewPresentation(this.document, {
        loading: this.status === "loading",
        saving: this.status === "saving",
        ...(this.previewTransient
          ? { transient: this.previewTransient.status }
          : {}),
      }),
      error: this.error,
    };
  }

  subscribe(listener: DesignControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<DesignDocumentDto> {
    return this.reload({ pending: "discard" });
  }

  async reload(
    options: { pending?: PendingReloadPolicy } = {},
  ): Promise<DesignDocumentDto> {
    const pending = options.pending ?? "preserve";
    this.status = "loading";
    this.error = null;
    this.emit();
    try {
      const document = await this.client.getDesign(
        this.accessToken,
        this.designId,
      );
      this.acceptDocument(document);
      if (pending === "discard") {
        this.clearPendingMutation();
        this.status = "ready";
      } else if (this.commands.length === 0) {
        this.status = "ready";
      } else if (pending === "rebase") {
        this.mutationKey = this.keys.rotate(this.mutationScope());
        this.mutationExpectedRevision = null;
        this.status = "dirty";
      } else {
        this.status =
          this.mutationExpectedRevision !== null &&
          this.mutationExpectedRevision !== document.revision
            ? "conflict"
            : "dirty";
      }
      this.previewTransient = null;
      this.emit();
      return document;
    } catch (error) {
      this.status = "error";
      this.error = errorMessage(error);
      this.emit();
      throw error;
    }
  }

  stage(rawCommands: readonly DesignCommand[]): void {
    if (!this.document || this.authoritativeRevision === null) {
      throw new Error("Load the design before staging changes.");
    }
    if (this.document.revision !== this.authoritativeRevision) {
      throw new Error(
        "Reload the authoritative design revision before editing.",
      );
    }
    if (this.status === "saving") {
      throw new Error("A design save is already in progress.");
    }
    if (this.mutationExpectedRevision !== null) {
      throw new Error(
        "The pending mutation is frozen; retry it or reload and rebase first.",
      );
    }
    const nextCommands = [
      ...this.commands,
      ...rawCommands.map((command) => designCommandSchema.parse(command)),
    ];
    const key = this.mutationKey ?? this.keys.get(this.mutationScope());
    designMutationRequestSchema.parse({
      design_id: this.designId,
      expected_revision: this.authoritativeRevision,
      idempotency_key: key,
      commands: nextCommands,
    });
    this.commands = nextCommands;
    this.mutationKey = key;
    this.status = "dirty";
    this.error = null;
    this.emit();
  }

  async save(): Promise<DesignDocumentDto> {
    if (!this.document || this.authoritativeRevision === null) {
      throw new Error("Load the design before saving.");
    }
    if (this.commands.length === 0) return this.document;
    if (this.status === "saving") {
      throw new Error("A design save is already in progress.");
    }
    if (
      this.mutationExpectedRevision === null &&
      this.document.revision !== this.authoritativeRevision
    ) {
      throw new Error(
        "Reload the authoritative design revision before saving.",
      );
    }

    const key = this.mutationKey ?? this.keys.get(this.mutationScope());
    const expectedRevision =
      this.mutationExpectedRevision ?? this.document.revision;
    const request = designMutationRequestSchema.parse({
      design_id: this.designId,
      expected_revision: expectedRevision,
      idempotency_key: key,
      commands: this.commands,
    });
    this.mutationKey = key;
    this.mutationExpectedRevision = expectedRevision;
    this.status = "saving";
    this.error = null;
    this.emit();

    let savedRevision: number;
    try {
      const response = await this.client.mutateDesign(
        this.accessToken,
        request,
      );
      savedRevision = response.revision;
      this.authoritativeRevision = response.revision;
      this.status = "reload_required";
      this.emit();
    } catch (error) {
      if (
        error instanceof DesignApiError &&
        error.code === "DESIGN_CONFLICT" &&
        error.conflict?.designId === this.designId
      ) {
        this.authoritativeRevision = error.conflict.latestRevision;
        this.status = "conflict";
      } else {
        this.status = "error";
      }
      this.error = errorMessage(error);
      this.emit();
      throw error;
    }

    try {
      const document = await this.client.getDesign(
        this.accessToken,
        this.designId,
      );
      if (document.revision < savedRevision) {
        throw new Error(
          "Reload returned a revision older than the saved revision.",
        );
      }
      this.acceptDocument(document);
      this.clearPendingMutation();
      this.previewTransient = null;
      this.status = "ready";
      this.emit();
      return document;
    } catch (error) {
      this.status = "reload_required";
      this.error = errorMessage(error);
      this.emit();
      throw error;
    }
  }

  discardPending(): void {
    this.clearPendingMutation();
    this.status = this.document ? "ready" : "idle";
    this.error = null;
    this.emit();
  }

  async requestPreview(): Promise<void> {
    if (!this.document || this.commands.length > 0) {
      throw new Error(
        "Save and reload the design before requesting a preview.",
      );
    }
    const revision = this.document.revision;
    const scope = this.previewScope(revision);
    const idempotencyKey = this.keys.get(scope);
    this.previewTransient = {
      status: "generating",
      revision,
      jobId: null,
    };
    this.error = null;
    this.emit();
    try {
      const response = await this.client.queueDesignPreview(this.accessToken, {
        design_id: this.designId,
        expected_revision: revision,
        idempotency_key: idempotencyKey,
      });
      if (response.status === "queued") {
        this.previewTransient = {
          status: "generating",
          revision,
          jobId: response.job_id,
        };
      } else {
        this.keys.release(scope, idempotencyKey);
        await this.reload({ pending: "preserve" });
      }
      this.emit();
    } catch (error) {
      this.previewTransient = { status: "error", revision, jobId: null };
      this.error = errorMessage(error);
      this.emit();
      throw error;
    }
  }

  applySync(rawEvent: DesignSyncEvent): boolean {
    const event = designSyncEventSchema.parse(rawEvent);
    if (
      event.designId !== this.designId ||
      this.authoritativeRevision === null ||
      event.revision <= this.authoritativeRevision
    ) {
      return false;
    }
    this.authoritativeRevision = event.revision;
    this.status = "reload_required";
    if (event.updateType === "preview") this.previewTransient = null;
    this.emit();
    return true;
  }

  private acceptDocument(document: DesignDocumentDto): void {
    if (document.id !== this.designId) {
      throw new Error("Loaded document does not match the controller design.");
    }
    this.document = document;
    this.authoritativeRevision = document.revision;
    this.error = null;
  }

  private clearPendingMutation(): void {
    if (this.mutationKey) {
      this.keys.release(this.mutationScope(), this.mutationKey);
    }
    this.commands = [];
    this.mutationKey = null;
    this.mutationExpectedRevision = null;
  }

  private mutationScope(): string {
    return `design:${this.designId}:mutation`;
  }

  private previewScope(revision: number): string {
    return `design:${this.designId}:preview:${revision}`;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

export function deriveDesignPreviewPresentation(
  document: DesignDocumentDto | null,
  transient: {
    loading?: boolean;
    saving?: boolean;
    transient?: "generating" | "error";
  } = {},
): DesignPreviewPresentation {
  const assetObjectId = document?.preview_asset_object_id ?? null;
  const previewRevision = document?.preview_revision ?? 0;
  const documentRevision = document?.revision ?? null;
  let status: DesignPreviewStatus;

  if (transient.loading) status = "loading";
  else if (transient.saving) status = "saving";
  else if (transient.transient) status = transient.transient;
  else if (!document) status = "missing";
  else {
    status =
      document.preview_status === "stale"
        ? "preview_stale"
        : document.preview_status === "queued"
          ? "generating"
          : document.preview_status;
  }

  const placeholder = previewPlaceholder(status, assetObjectId);
  return {
    status,
    assetObjectId,
    previewRevision,
    documentRevision,
    placeholder,
    canRetry: status === "error" || status === "preview_stale",
  };
}

function previewPlaceholder(
  status: DesignPreviewStatus,
  assetObjectId: string | null,
): DesignPreviewPresentation["placeholder"] {
  if (status === "ready") return "none";
  if (status === "missing") return "missing";
  if (status === "error") return "error";
  if (assetObjectId) return "stale";
  return "loading";
}

function createUuid(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure UUID generation is unavailable.");
  }
  return globalThis.crypto.randomUUID();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Design operation failed.";
}
