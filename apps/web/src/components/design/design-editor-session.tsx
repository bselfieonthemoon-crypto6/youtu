"use client";
import { imageToolOperationModel } from "../../lib/layer-backend";
import type { SemanticLayerSplitRequest } from "../canvas/image-action-dialog";

import {
  type BackgroundJob,
  type DesignCommand,
  type DesignDocumentDto,
  type DesignFontFaceDto,
  type DesignObject,
  type DesignResourceDto,
  type DesignTemplateDetailDto,
  type DesignTemplateDto,
  type DesignTemplateReplacePreviewRequest,
  type DesignTemplateReplacePreviewResponse,
  type DesignTextPresetDto,
  type LoomicSceneV1,
  designCommandSchema,
} from "@loomic/shared";
import type { Canvas as FabricCanvas } from "fabric";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WebSocketHandle } from "../../hooks/use-websocket";
import { fetchAssetBlob } from "../../lib/canvas-elements";
import type { NormalizedImageRegion } from "../../lib/canvas-image-crop";
import { createDesignApiClient } from "../../lib/design-api";
import { waitForDesignPreview } from "../../lib/design-preview-ready";
import {
  type DesignBrowserExportPort,
  exportDesignInBrowser,
} from "../../lib/design-browser-export";
import {
  DESIGN_GIF_MAX_EDGE,
  exportAnimatedDesignGifInBrowser,
} from "../../lib/design-animated-gif-export";
import {
  DesignCommandHistory,
  type DesignCommandHistoryState,
  type DesignHistoryEdit,
} from "../../lib/design-command-history";
import {
  type DesignFontIssue,
  collectDesignFontReferences,
  loadDesignSceneFonts,
} from "../../lib/design-font-loader";
import type { DesignLayerAdapter } from "../../lib/design-layer-model";
import { createDesignResourceApiClient } from "../../lib/design-resource-api";
import { buildSmartTemplateBindings } from "../../lib/design-template-replacement";
import {
  type NormalizedEraseStroke,
  renderEraseMask,
} from "../../lib/image-eraser";
import { uploadFile } from "../../lib/server-api";
import {
  type ImageEraseMode,
  ImageEraserOverlay,
} from "../canvas/image-eraser-overlay";
import { ImageRegionMattingOverlay } from "../canvas/image-region-matting-overlay";
import {
  type DesignEditorExportOptions,
  DesignEditorOverlay,
  type DesignResizeOptions,
} from "./design-editor-overlay";
import { readExportPayload, readExportResult } from "./design-export-task-list";
import {
  type DesignImageOperation,
  DesignImageTools,
} from "./design-image-tools";
import type { DesignPropertiesActions } from "./design-properties-panel";
import {
  DesignResourcePanel,
  type DesignResourceTab,
} from "./design-resource-panel";
import { DesignTemplateReplaceDialog } from "./design-template-replace-dialog";
import { DesignInlineEditor } from "./design-inline-editor";
import type {
  AddFabricObjectInput,
  FabricObjectCommandEvent,
  FabricObjectEditorApi,
  UpdateFabricObjectPatch,
} from "./fabric-object-editor";

type DesignEditorSessionProps = {
  onBindAgentSave?: (save: (() => Promise<void>) | null) => void;
  inline?: boolean;
  accessToken: string;
  designId: string;
  initialObjectId?: string;
  backgroundRoot: HTMLElement;
  onClose: () => void;
  onPreviewReady?: () => Promise<void>;
  ws?: WebSocketHandle;
};

type LoadState =
  | { status: "loading"; document: null; message: null }
  | { status: "ready"; document: DesignDocumentDto; message: null }
  | { status: "error"; document: null; message: string };

type DesignImageInteraction = {
  kind: "region" | "erase";
  objectId: string;
  bounds: { x: number; y: number; width: number; height: number };
  angle: number;
};

type TemplateBinding = DesignTemplateReplacePreviewRequest["bindings"][number];
type TemplateReplaceSession = {
  detail: DesignTemplateDetailDto;
  bindings: TemplateBinding[];
  smartBindings: DesignTemplateReplacePreviewRequest["smart_bindings"];
  preview: DesignTemplateReplacePreviewResponse | null;
};

const INITIAL_HISTORY_STATE: DesignCommandHistoryState = {
  status: "clean",
  authoritativeRevision: 0,
  dirty: false,
  canUndo: false,
  canRedo: false,
  queuedCommandCount: 0,
  inFlightCommandCount: 0,
  nextSaveAt: null,
  conflictRevision: null,
  error: null,
  dirtyBatches: [],
};

/** Owns the authoritative document, local Fabric adapter, and save history. */
export function DesignEditorSession({
  onBindAgentSave,
  inline = false,
  accessToken,
  designId,
  initialObjectId,
  backgroundRoot,
  onClose,
  onPreviewReady,
  ws,
}: DesignEditorSessionProps) {
  const client = useMemo(() => createDesignApiClient(), []);
  const resourceClient = useMemo(() => createDesignResourceApiClient(), []);
  const editorRef = useRef<FabricObjectEditorApi | null>(null);
  const draggedResourceRef = useRef<DesignResourceDto | null>(null);
  const pendingResourceWorkRef = useRef<Promise<void>>(Promise.resolve());
  const historyRef = useRef<DesignCommandHistory | null>(null);
  const sceneRef = useRef<LoomicSceneV1 | null>(null);
  const localRenameRef = useRef(false);
  const editorCommandChainRef = useRef<Promise<void>>(Promise.resolve());
  const missingAssetsRef = useRef(new Set<string>());
  const loadedSceneFontSignatureRef = useRef<string | null>(null);
  const syncReloadChainRef = useRef<Promise<void>>(Promise.resolve());
  const handledImageJobIdsRef = useRef(new Set<string>());
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    document: null,
    message: null,
  });
  const [scene, setScene] = useState<LoomicSceneV1 | null>(null);
  const [historyState, setHistoryState] = useState<DesignCommandHistoryState>(
    INITIAL_HISTORY_STATE,
  );
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fontIssues, setFontIssues] = useState<DesignFontIssue[]>([]);
  const [resourceTab, setResourceTab] = useState<DesignResourceTab>("assets");
  const [exportJobs, setExportJobs] = useState<BackgroundJob[]>([]);
  const [exportJobsLoading, setExportJobsLoading] = useState(false);
  const [exportJobsError, setExportJobsError] = useState<string | null>(null);
  const [exportJobBusyId, setExportJobBusyId] = useState<string | null>(null);
  const [imageJobs, setImageJobs] = useState<BackgroundJob[]>([]);
  const [imageJobsLoading, setImageJobsLoading] = useState(false);
  const [imageJobsError, setImageJobsError] = useState<string | null>(null);
  const [imageJobBusyId, setImageJobBusyId] = useState<string | null>(null);
  const [imageInteraction, setImageInteraction] =
    useState<DesignImageInteraction | null>(null);
  const [templateReplace, setTemplateReplace] =
    useState<TemplateReplaceSession | null>(null);
  const [templateReplaceBusy, setTemplateReplaceBusy] = useState(false);
  const [templateReplaceError, setTemplateReplaceError] = useState<
    string | null
  >(null);
  // A design conflict is normally a transient remote revision bump. Rebase the
  // local edits onto the latest remote scene and retry automatically; only fall
  // back to the manual banner after a bounded number of failed attempts.
  const [autoRecoverState, setAutoRecoverState] = useState<
    "idle" | "recovering" | "exhausted"
  >("idle");
  const autoRecoverAttemptsRef = useRef(0);
  const reloadKeepRef = useRef<() => Promise<void>>(async () => undefined);

  const upsertExportJob = useCallback((job: BackgroundJob) => {
    setExportJobs((current) =>
      [job, ...current.filter((candidate) => candidate.id !== job.id)].sort(
        (left, right) => right.created_at.localeCompare(left.created_at),
      ),
    );
  }, []);

  const refreshExportJobs = useCallback(
    async (silent = false) => {
      if (!silent) setExportJobsLoading(true);
      try {
        const jobs = await client.listDesignExportJobs(accessToken, designId);
        setExportJobs(jobs);
        setExportJobsError(null);
      } catch (error) {
        if (!silent) {
          setExportJobsError(
            error instanceof Error ? error.message : "导出任务加载失败。",
          );
        }
      } finally {
        if (!silent) setExportJobsLoading(false);
      }
    },
    [accessToken, client, designId],
  );

  useEffect(() => {
    void refreshExportJobs();
  }, [refreshExportJobs]);

  useEffect(() => {
    const activeJobIds = exportJobs
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.id);
    if (activeJobIds.length === 0) return;
    let disposed = false;
    const poll = async () => {
      const settled = await Promise.allSettled(
        activeJobIds.map((jobId) =>
          client.getDesignExportJob(accessToken, jobId),
        ),
      );
      if (disposed) return;
      for (const result of settled) {
        if (result.status === "fulfilled") upsertExportJob(result.value);
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [accessToken, client, exportJobs, upsertExportJob]);

  const upsertImageJob = useCallback((job: BackgroundJob) => {
    setImageJobs((current) =>
      [job, ...current.filter((candidate) => candidate.id !== job.id)]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, 12),
    );
  }, []);

  const refreshImageJobs = useCallback(
    async (silent = false) => {
      if (!silent) setImageJobsLoading(true);
      try {
        const jobs = await client.listDesignImageJobs(accessToken, designId);
        setImageJobs(jobs.slice(0, 12));
        setImageJobsError(null);
      } catch (error) {
        if (!silent) {
          setImageJobsError(
            error instanceof Error ? error.message : "图片任务加载失败。",
          );
        }
      } finally {
        if (!silent) setImageJobsLoading(false);
      }
    },
    [accessToken, client, designId],
  );

  useEffect(() => {
    void refreshImageJobs();
  }, [refreshImageJobs]);

  const prepareDocumentFonts = useCallback(
    async (document: DesignDocumentDto, signal?: AbortSignal) => {
      const result = await loadDesignSceneFonts({
        scene: document.scene,
        accessToken,
        client: resourceClient,
        ...(signal ? { signal } : {}),
      });
      if (!signal?.aborted) setFontIssues(result.issues);
      return document;
    },
    [accessToken, resourceClient],
  );

  const fontSignature = useMemo(
    () =>
      scene
        ? collectDesignFontReferences(scene)
            .map(
              (reference) =>
                `${reference.faceId}:${reference.family}:${reference.style}:${reference.weight}`,
            )
            .sort()
            .join("|")
        : "",
    [scene],
  );

  const selectedImage = useMemo(() => {
    if (!scene || selectedObjectIds.length !== 1) return null;
    const object = scene.objects.find(
      (candidate) => candidate.objectId === selectedObjectIds[0],
    );
    return object?.type === "image" ? object : null;
  }, [scene, selectedObjectIds]);

  useEffect(() => {
    if (!scene || !fontSignature) {
      loadedSceneFontSignatureRef.current = fontSignature;
      setFontIssues([]);
      return;
    }
    if (loadedSceneFontSignatureRef.current === fontSignature) return;
    loadedSceneFontSignatureRef.current = fontSignature;
    const controller = new AbortController();
    void loadDesignSceneFonts({
      scene,
      accessToken,
      client: resourceClient,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setFontIssues(result.issues);
      editorRef.current?.refreshTextMetrics();
    });
    return () => controller.abort();
  }, [accessToken, fontSignature, resourceClient]);

  const acceptLocalScene = useCallback((nextScene: LoomicSceneV1) => {
    sceneRef.current = nextScene;
    setScene(nextScene);
    setLoadState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            document: {
              ...current.document,
              width: nextScene.canvas.width,
              height: nextScene.canvas.height,
              scene: nextScene,
            },
            message: null,
          }
        : current,
    );
  }, []);

  const captureEditorScene = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    acceptLocalScene(editor.serializeScene());
    setSelectedObjectIds(editor.getSelectionIds());
  }, [acceptLocalScene]);

  const runEditorCommands = useCallback(
    (
      commands: readonly DesignCommand[],
      source: "undo" | "redo" | "sync",
    ): Promise<void> => {
      const execute = async () => {
        const editor = editorRef.current;
        if (!editor) throw new Error("设计编辑器尚未准备完成。");
        await editor.applyCommands(commands, source);
        captureEditorScene();
      };
      const next = editorCommandChainRef.current
        .catch(() => undefined)
        .then(execute);
      editorCommandChainRef.current = next;
      return next;
    },
    [captureEditorScene],
  );

  // One submission per persisted revision, including repair of old stale previews.
  // A preview failure must not turn a successful document mutation into a retry.
  const previewRequests = useRef(new Map<string, Promise<void>>());
  const ensurePreview = useCallback((id: string, revision: number) => {
    const key = `${id}:${revision}`;
    const existing = previewRequests.current.get(key);
    if (existing) return existing;
    const request = client.queueDesignPreview(accessToken, {
      design_id: id,
      expected_revision: revision,
      idempotency_key: crypto.randomUUID(),
    }).then(() => undefined).catch(() => {
      previewRequests.current.delete(key);
      setActionMessage("设计已保存，但预览更新失败，请再次保存重试。");
    });
    previewRequests.current.set(key, request);
    return request;
  }, [accessToken, client]);

  useEffect(() => {
    if (loadState.status !== "ready") return;
    const doc = loadState.document;
    if (doc.preview_revision < doc.revision || !doc.preview_asset_object_id)
      void ensurePreview(doc.id, doc.revision);
  }, [loadState, ensurePreview]);

  const installDocument = useCallback(
    (document: DesignDocumentDto) => {
      historyRef.current?.destroy();
      missingAssetsRef.current.clear();
      sceneRef.current = document.scene;
      setScene(document.scene);
      setSelectedObjectIds([]);
      setUploadError(null);
      const history = new DesignCommandHistory({
        designId: document.id,
        initialRevision: document.revision,
        mutate: async (request) => {
          const response = await client.mutateDesign(accessToken, request);
          void ensurePreview(document.id, response.revision);
          setLoadState((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  document: {
                    ...current.document,
                    revision: Math.max(
                      current.document.revision,
                      response.revision,
                    ),
                    scene: sceneRef.current ?? current.document.scene,
                    preview_status:
                      current.document.preview_asset_object_id === null
                        ? "missing"
                        : "stale",
                  },
                  message: null,
                }
              : current,
          );
          return response;
        },
        applyLocal: (commands, source) => {
          void runEditorCommands(commands, source).catch((error: unknown) => {
            setActionMessage(
              error instanceof Error ? error.message : "无法应用历史命令。",
            );
          });
        },
        preparePersistedCommand: (command) =>
          refreshCommandVersions(command, sceneRef.current),
      });
      historyRef.current = history;
      setHistoryState(history.getState());
      history.subscribe((state) => {
        setHistoryState(state);
        if (state.status === "clean") setActionMessage("已保存");
      });
      setLoadState({ status: "ready", document, message: null });
    },
    [accessToken, client, runEditorCommands, ensurePreview],
  );

  const load = useCallback(async () => {
    setLoadState({ status: "loading", document: null, message: null });
    setActionMessage(null);
    try {
      installDocument(
        await prepareDocumentFonts(
          await client.getDesign(accessToken, designId),
        ),
      );
    } catch (error) {
      setLoadState({
        status: "error",
        document: null,
        message: error instanceof Error ? error.message : "设计加载失败。",
      });
    }
  }, [accessToken, client, designId, installDocument, prepareDocumentFonts]);

  useEffect(() => {
    if (!ws?.onDesignSync) return;
    return ws.onDesignSync((event) => {
      if (event.designId !== designId) return;
      if (event.updateType === "renamed" && localRenameRef.current) return;
      if (event.updateType === "preview") {
        if (
          event.previewAssetObjectId !== undefined &&
          event.previewRevision !== undefined
        ) {
          setLoadState((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  document: {
                    ...current.document,
                    preview_asset_object_id: event.previewAssetObjectId ?? null,
                    preview_revision: event.previewRevision ?? 0,
                    preview_status: event.previewAssetObjectId
                      ? "ready"
                      : "missing",
                  },
                  message: null,
                }
              : current,
          );
        }
        return;
      }
      if (!["mutated", "renamed", "restored"].includes(event.updateType))
        return;
      const history = historyRef.current;
      const state = history?.getState();
      if (!history || !state || event.revision <= state.authoritativeRevision)
        return;
      if (
        state.dirty ||
        state.status === "saving" ||
        state.status === "conflict"
      ) {
        setActionMessage(
          `设计已在其他位置更新到版本 ${event.revision}；本地修改仍保留，请保存并处理版本冲突。`,
        );
        return;
      }
      syncReloadChainRef.current = syncReloadChainRef.current
        .then(async () => {
          const currentHistory = historyRef.current;
          if (
            !currentHistory ||
            event.revision <= currentHistory.getState().authoritativeRevision
          )
            return;
          const authoritative = await prepareDocumentFonts(
            await client.getDesign(accessToken, designId),
          );
          currentHistory.reloadDiscard(authoritative.revision);
          missingAssetsRef.current.clear();
          await editorRef.current?.loadScene(authoritative.scene, (object) =>
            fetchAssetBlob(accessToken, object.assetObjectId),
          );
          sceneRef.current = authoritative.scene;
          setScene(authoritative.scene);
          setSelectedObjectIds([]);
          setLoadState({
            status: "ready",
            document: authoritative,
            message: null,
          });
          editorRef.current?.refreshTextMetrics();
          setActionMessage(`已同步设计版本 ${authoritative.revision}`);
        })
        .catch((error: unknown) => {
          setActionMessage(
            error instanceof Error
              ? `设计自动同步失败：${error.message}`
              : "设计自动同步失败，请重新打开设计。",
          );
        });
    });
  }, [accessToken, client, designId, prepareDocumentFonts, ws]);

  useEffect(() => {
    let active = true;
    setActionMessage(null);
    setLoadState({ status: "loading", document: null, message: null });
    const controller = new AbortController();
    client
      .getDesign(accessToken, designId)
      .then((document) => prepareDocumentFonts(document, controller.signal))
      .then(
        (document) => {
          if (active) installDocument(document);
        },
        (error: unknown) => {
          if (active)
            setLoadState({
              status: "error",
              document: null,
              message:
                error instanceof Error ? error.message : "设计加载失败。",
            });
        },
      );
    return () => {
      active = false;
      controller.abort();
      historyRef.current?.destroy();
      historyRef.current = null;
    };
  }, [accessToken, client, designId, installDocument, prepareDocumentFonts]);

  const handleObjectCommand = useCallback(
    (event: FabricObjectCommandEvent) => {
      if (event.edits.length === 0) return;
      historyRef.current?.recordBatch(event.edits);
      captureEditorScene();
      setActionMessage(null);
    },
    [captureEditorScene],
  );

  const flushAll = useCallback(async (retrySaveError = false) => {
    await pendingResourceWorkRef.current;
    const history = historyRef.current;
    if (!history) throw new Error("设计保存协调器尚未准备完成。");
    // A deliberate save retries the frozen request with its original key.
    // Conflicts still require the explicit revision recovery flow.
    if (retrySaveError && history.getState().status === "error") {
      await history.retry();
    }
    for (;;) {
      const before = history.getState();
      if (before.status === "conflict" || before.status === "error") {
        throw new Error(before.error ?? "保存已暂停，请先处理冲突。");
      }
      if (!before.dirty) {
        await ensurePreview(designId, before.authoritativeRevision);
        return;
      }
      await history.flushNow();
    }
  }, [designId, ensurePreview]);

  useEffect(() => {
    onBindAgentSave?.(flushAll);
    return () => onBindAgentSave?.(null);
  }, [onBindAgentSave, flushAll]);

  // A design conflict is normally a transient remote revision bump. Rebase the
  // local edits onto the latest remote scene and retry automatically; only the
  // manual banner (after bounded attempts) asks the user to intervene.
  useEffect(() => {
    if (historyState.status === "clean") {
      autoRecoverAttemptsRef.current = 0;
      setAutoRecoverState((current) => (current === "idle" ? current : "idle"));
    }
  }, [historyState.status]);

  useEffect(() => {
    if (historyState.conflictRevision === null) return;
    if (autoRecoverAttemptsRef.current >= 2) {
      setAutoRecoverState("exhausted");
      return;
    }
    autoRecoverAttemptsRef.current += 1;
    setAutoRecoverState("recovering");
    setActionMessage("远端已更新，正在自动合并本地修改并重试保存…");
    void reloadKeepRef
      .current()
      .then(() => historyRef.current?.flushNow())
      .then(() => setActionMessage("已自动合并远端更新并保存。"))
      .catch((error) => {
        setAutoRecoverState("exhausted");
        setActionMessage(
          error instanceof Error ? error.message : "自动合并失败，请手动重试。",
        );
      });
  }, [historyState.conflictRevision]);

  const reloadAuthoritativeIfClean = useCallback(
    async (successMessage?: string) => {
      const history = historyRef.current;
      const state = history?.getState();
      if (!history || !state) return false;
      if (
        state.dirty ||
        state.status === "saving" ||
        state.status === "conflict"
      ) {
        setActionMessage(
          "图片处理已经完成，但本地还有未保存修改；请先保存并处理版本冲突，再刷新设计。",
        );
        return false;
      }
      const authoritative = await prepareDocumentFonts(
        await client.getDesign(accessToken, designId),
      );
      if (authoritative.revision < state.authoritativeRevision) return false;
      history.reloadDiscard(authoritative.revision);
      missingAssetsRef.current.clear();
      await editorRef.current?.loadScene(authoritative.scene, (object) =>
        fetchAssetBlob(accessToken, object.assetObjectId),
      );
      sceneRef.current = authoritative.scene;
      setScene(authoritative.scene);
      setSelectedObjectIds([]);
      setLoadState({ status: "ready", document: authoritative, message: null });
      editorRef.current?.refreshTextMetrics();
      setActionMessage(
        successMessage ?? `已同步设计版本 ${authoritative.revision}`,
      );
      return true;
    },
    [accessToken, client, designId, prepareDocumentFonts],
  );

  useEffect(() => {
    const activeJobIds = imageJobs
      .filter((job) => isImageJobActive(job))
      .map((job) => job.id);
    if (activeJobIds.length === 0) return;
    let disposed = false;
    const poll = async () => {
      const settled = await Promise.allSettled(
        activeJobIds.map((jobId) =>
          client.getDesignImageJob(accessToken, jobId),
        ),
      );
      if (disposed) return;
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const job = result.value;
        upsertImageJob(job);
        if (
          isImageJobFinalized(job) &&
          !handledImageJobIdsRef.current.has(job.id)
        ) {
          handledImageJobIdsRef.current.add(job.id);
          void reloadAuthoritativeIfClean("图片处理完成，已更新设计。")
            .then((reloaded) => {
              if (!reloaded) handledImageJobIdsRef.current.delete(job.id);
            })
            .catch((error: unknown) => {
              handledImageJobIdsRef.current.delete(job.id);
              setImageJobsError(
                error instanceof Error
                  ? `图片已处理，但设计刷新失败：${error.message}`
                  : "图片已处理，但设计刷新失败。",
              );
            });
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    accessToken,
    client,
    imageJobs,
    reloadAuthoritativeIfClean,
    upsertImageJob,
  ]);

  const issueObjectPatches = useCallback(
    (
      objectIds: readonly string[],
      patch: { name?: string; locked?: boolean; visible?: boolean },
    ) => {
      const current = sceneRef.current;
      if (!current) return;
      const edits: DesignHistoryEdit[] = [];
      for (const objectId of [...new Set(objectIds)]) {
        const object = current.objects.find(
          (candidate) => candidate.objectId === objectId,
        );
        if (!object) continue;
        const inversePatch = Object.fromEntries(
          Object.keys(patch).map((key) => [
            key,
            object[key as keyof DesignObject],
          ]),
        );
        edits.push({
          command: designCommandSchema.parse({
            action: "object.update",
            object_id: objectId,
            expected_object_version: object.objectVersion,
            patch: { object_type: object.type, ...patch },
          }),
          inverse: designCommandSchema.parse({
            action: "object.update",
            object_id: objectId,
            expected_object_version: object.objectVersion + 1,
            patch: { object_type: object.type, ...inversePatch },
          }),
        });
      }
      if (edits.length === 0) return;
      void runEditorCommands(
        edits.map((edit) => edit.command),
        "sync",
      )
        .then(() => {
          historyRef.current?.recordBatch(edits);
          setActionMessage(null);
        })
        .catch((error: unknown) => {
          setActionMessage(
            error instanceof Error ? error.message : "图层修改失败。",
          );
        });
    },
    [runEditorCommands],
  );

  const layerAdapter = useMemo<DesignLayerAdapter>(
    () => ({
      selectObjectIds(objectIds, mode) {
        const editor = editorRef.current;
        if (!editor) return;
        const next =
          mode === "replace"
            ? objectIds
            : toggleSelection(editor.getSelectionIds(), objectIds);
        editor.select(next);
        setSelectedObjectIds(editor.getSelectionIds());
      },
      renameObject(objectId, name) {
        issueObjectPatches([objectId], { name });
      },
      updateObject(objectId, patch) {
        issueObjectPatches([objectId], patch);
      },
      reorderObject(objectId, toIndex) {
        editorRef.current?.reorder(objectId, toIndex);
      },
      updateMany(objectIds, patch) {
        issueObjectPatches(objectIds, patch);
      },
    }),
    [issueObjectPatches],
  );

  const propertyActions = useMemo<DesignPropertiesActions>(
    () => ({
      updateObject(objectId, patch: UpdateFabricObjectPatch) {
        editorRef.current?.updateObject(objectId, patch);
      },
      removeSelection() {
        try {
          editorRef.current?.removeSelection();
        } catch (error) {
          setActionMessage(error instanceof Error ? `删除未完成：${error.message}` : "删除未完成，图层已保留。");
        }
      },
      flip(axis) {
        const editor = editorRef.current;
        if (editor) editor.flip(editor.getSelectionIds(), axis);
      },
      align(alignment) {
        const editor = editorRef.current;
        if (editor) editor.align(editor.getSelectionIds(), alignment);
      },
      distribute(direction) {
        const editor = editorRef.current;
        if (editor) editor.distribute(editor.getSelectionIds(), direction);
      },
      group() {
        const editor = editorRef.current;
        if (editor) editor.group(editor.getSelectionIds());
      },
      ungroup() {
        const editor = editorRef.current;
        const groupId = editor?.getSelectionIds()[0];
        if (editor && groupId) editor.ungroup(groupId);
      },
      cloneSelection() {
        void editorRef.current?.cloneSelection().catch((error: unknown) => {
          setActionMessage(
            error instanceof Error ? error.message : "复制对象失败。",
          );
        });
      },
    }),
    [],
  );

  useEffect(() => {
    const objectId = imageInteraction?.objectId;
    if (!objectId) return;
    const refreshBounds = () => {
      const next = editorRef.current?.getObjectViewportBounds(objectId);
      if (!next) {
        setImageInteraction(null);
        return;
      }
      setImageInteraction((current) =>
        current?.objectId === objectId
          ? {
              ...current,
              bounds: {
                x: next.x,
                y: next.y,
                width: next.width,
                height: next.height,
              },
              angle: next.angle,
            }
          : current,
      );
    };
    window.addEventListener("resize", refreshBounds);
    window.addEventListener("scroll", refreshBounds, true);
    return () => {
      window.removeEventListener("resize", refreshBounds);
      window.removeEventListener("scroll", refreshBounds, true);
    };
  }, [imageInteraction?.objectId]);

  if (loadState.status !== "ready" || !scene) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 backdrop-blur-sm">
        <section className="w-full max-w-sm rounded-2xl border bg-background p-5 text-center shadow-float">
          {loadState.status === "loading" ? (
            <p className="text-sm text-muted-foreground">正在加载设计…</p>
          ) : (
            <>
              <p role="alert" className="text-sm text-destructive">
                {loadState.message}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-3 py-2 text-sm"
                  onClick={onClose}
                >
                  返回画布
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-foreground px-3 py-2 text-sm text-background"
                  onClick={() => void load()}
                >
                  重新加载
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    );
  }

  const document = loadState.document;
  const previewTemplateReplacement = async (
    detail: DesignTemplateDetailDto,
    bindings: TemplateBinding[],
    smartBindings: DesignTemplateReplacePreviewRequest["smart_bindings"],
  ) => {
    await flushAll();
    const revision = historyRef.current?.getState().authoritativeRevision;
    if (revision === undefined)
      throw new Error("设计版本尚未准备完成，请稍后重试。");
    return resourceClient.previewTemplateReplacement(accessToken, {
      design_id: document.id,
      template_id: detail.template.id,
      expected_revision: revision,
      expected_template_revision: detail.template.revision,
      bindings,
      smart_bindings: smartBindings,
    });
  };

  const openTemplateReplacement = async (template: DesignTemplateDto) => {
    setTemplateReplaceBusy(true);
    setTemplateReplaceError(null);
    try {
      const detail = await resourceClient.getTemplate(accessToken, template.id);
      const smartBindings = buildSmartTemplateBindings(
        detail,
        sceneRef.current ?? scene,
      );
      const preview = await previewTemplateReplacement(
        detail,
        [],
        smartBindings,
      );
      setTemplateReplace({ detail, bindings: [], smartBindings, preview });
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "模板智能匹配预览失败。",
      );
    } finally {
      setTemplateReplaceBusy(false);
    }
  };

  const refreshTemplateReplacement = async () => {
    const current = templateReplace;
    if (!current) return;
    setTemplateReplaceBusy(true);
    setTemplateReplaceError(null);
    try {
      const preview = await previewTemplateReplacement(
        current.detail,
        current.bindings,
        current.smartBindings,
      );
      setTemplateReplace({ ...current, preview });
    } catch (error) {
      setTemplateReplaceError(
        error instanceof Error ? error.message : "模板智能匹配预览失败。",
      );
    } finally {
      setTemplateReplaceBusy(false);
    }
  };

  const applyTemplateReplacement = async () => {
    const current = templateReplace;
    if (!current?.preview || current.preview.unresolved_keys.length > 0) return;
    setTemplateReplaceBusy(true);
    setTemplateReplaceError(null);
    try {
      if (current.detail.template.variables.length === 0) {
        const previous = structuredClone(sceneRef.current!);
        const next = structuredClone(current.detail.scene);
        const idMap = new Map(next.objects.map((object) => [object.objectId, crypto.randomUUID()]));
        for (const object of next.objects) {
          object.objectId = idMap.get(object.objectId)!;
          object.objectVersion = 1;
          if (object.type === "group") object.childObjectIds = object.childObjectIds.map((id) => idMap.get(id)!);
        }
        const fonts = await loadDesignSceneFonts({ scene: next, accessToken, client: resourceClient });
        setFontIssues(fonts.issues);
        if (fonts.issues.length) throw new Error(fonts.issues.map((issue) => issue.message).join(" "));
        const command = designCommandSchema.parse({ action: "scene.replace", scene: next });
        await runEditorCommands([command], "sync");
        historyRef.current?.recordBatch([{ command, inverse: designCommandSchema.parse({ action: "scene.replace", scene: previous }) }]);
        await flushAll();
        setTemplateReplace(null);
        setActionMessage(`已应用模板「${current.detail.template.name}」，可撤销。`);
        return;
      }
      const response = await resourceClient.applyTemplateReplacement(
        accessToken,
        {
          design_id: document.id,
          template_id: current.detail.template.id,
          expected_revision: current.preview.design_revision,
          expected_template_revision: current.preview.template_revision,
          idempotency_key: crypto.randomUUID(),
          bindings: current.bindings,
          smart_bindings: current.smartBindings,
        },
      );
      setTemplateReplace(null);
      await reloadAuthoritativeIfClean(
        `模板变量已应用，设计已更新到版本 ${response.mutation.revision}。`,
      );
    } catch (error) {
      setTemplateReplaceError(
        error instanceof Error ? error.message : "应用模板变量失败。",
      );
    } finally {
      setTemplateReplaceBusy(false);
    }
  };

  const beginImageInteraction = (kind: "region" | "erase") => {
    if (!selectedImage) {
      setImageJobsError("请先选择一张图片。");
      return;
    }
    const viewport = editorRef.current?.getObjectViewportBounds(
      selectedImage.objectId,
    );
    if (!viewport) {
      setImageJobsError("无法定位当前图片，请重新选择后再试。");
      return;
    }
    setImageJobsError(null);
    setImageInteraction({
      kind,
      objectId: selectedImage.objectId,
      bounds: {
        x: viewport.x,
        y: viewport.y,
        width: viewport.width,
        height: viewport.height,
      },
      angle: viewport.angle,
    });
  };

  const submitImageOperation = async (
    objectId: string,
    operation: DesignImageOperation,
    options: {
      selectionRegion?: NormalizedImageRegion;
      eraseStrokes?: NormalizedEraseStroke[];
      layerBackend?: "qwen-image-layered" | "semantic";
      layerNames?: string[];
      repairBackground?: true;
      model?: string;
    } = {},
  ) => {
    setImageJobsError(null);
    try {
      await flushAll();
      const current = sceneRef.current?.objects.find(
        (candidate) => candidate.objectId === objectId,
      );
      if (!current || current.type !== "image") {
        throw new Error("原图片已被删除或替换，请重新选择。");
      }
      const revision = historyRef.current?.getState().authoritativeRevision;
      if (revision === undefined)
        throw new Error("设计版本尚未准备完成，请稍后重试。");
      const maskDimensions = fitMaskDimensions(current.width, current.height);
      const response = await client.createDesignImageJob(accessToken, {
        ...(document.project_id ? { project_id: document.project_id } : {}),
        prompt: promptForImageOperation(operation),
        ...(options.layerBackend === "semantic" ? { model: options.model } : { model: imageToolOperationModel(operation, options.layerBackend) }),
        operation,
        quality: options.layerBackend === "semantic" ? "standard" : "hd",
        ...(options.layerBackend === "semantic" ? {
          layer_backend: "semantic" as const,
          layer_names: options.layerNames,
          repair_background: options.repairBackground,
          resolution: "1k" as const,
        } : {}),
        ...(options.selectionRegion
          ? {
              selection_region: mapRegionThroughCrop(
                options.selectionRegion,
                current.crop,
              ),
            }
          : {}),
        ...(options.eraseStrokes
          ? {
              mask_image: renderEraseMask(
                mapStrokesThroughCrop(options.eraseStrokes, current.crop),
                maskDimensions.width,
                maskDimensions.height,
              ),
            }
          : {}),
        target: {
          kind: "design",
          design_id: document.id,
          expected_revision: revision,
          idempotency_key: crypto.randomUUID(),
          source_object_id: current.objectId,
          expected_object_version: current.objectVersion,
          source_asset_object_id: current.assetObjectId,
          placement: {
            x: options.layerBackend === "semantic" ? current.x + current.width + 40 : current.x,
            y: current.y,
            width: current.width,
            height: current.height,
            fit: current.fit,
            ...(options.layerBackend === "semantic" ? {} : { replace_object_id: current.objectId }),
          },
        },
      });
      upsertImageJob(response);
      setActionMessage(`${imageOperationLabel(operation)}任务已提交。`);
    } catch (error) {
      setImageJobsError(
        error instanceof Error ? error.message : "图片处理任务提交失败。",
      );
    }
  };

  const handleCancelImageJob = async (job: BackgroundJob) => {
    setImageJobBusyId(job.id);
    setImageJobsError(null);
    try {
      upsertImageJob(await client.cancelDesignImageJob(accessToken, job.id));
      setActionMessage("图片处理任务已取消。");
    } catch (error) {
      setImageJobsError(
        error instanceof Error ? error.message : "取消图片处理任务失败。",
      );
    } finally {
      setImageJobBusyId(null);
    }
  };

  const handleBackgroundChange = (background: string | null) => {
    const previous = sceneRef.current?.canvas.background ?? null;
    if (previous === background) return;
    const command = designCommandSchema.parse({
      action: "canvas.update",
      background,
    });
    const inverse = designCommandSchema.parse({
      action: "canvas.update",
      background: previous,
    });
    historyRef.current?.record({
      command,
      inverse,
      mergeKey: "canvas:background",
    });
    const nextScene = {
      ...scene,
      canvas: { ...scene.canvas, background },
    };
    acceptLocalScene(nextScene);
    void runEditorCommands([command], "sync").catch(() => undefined);
    setActionMessage(null);
  };

  const enqueueResourceWork = <T,>(operation: () => Promise<T>): Promise<T> => {
    const work = pendingResourceWorkRef.current.then(operation);
    pendingResourceWorkRef.current = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };

  const handleUpload = async (file: File) => {
    const editor = editorRef.current;
    if (!editor) throw new Error("设计编辑器尚未准备完成。");
    setUploading(true);
    setUploadError(null);
    try {
      await enqueueResourceWork(async () => {
        const uploaded = await uploadFile(accessToken, file, document.project_id);
        const input = { assetObjectId: uploaded.asset.id, source: file };
        if (
          file.type === "image/svg+xml" ||
          file.name.toLowerCase().endsWith(".svg")
        ) {
          await editor.addSvg(input);
        } else {
          await editor.addImage(input);
        }
        captureEditorScene();
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "资源上传失败。");
      throw error;
    } finally {
      setUploading(false);
    }
  };

  const handleReplaceUpload = async (file: File) => {
    const editor = editorRef.current;
    if (!editor) throw new Error("设计编辑器尚未准备完成。");
    setUploading(true);
    setUploadError(null);
    try {
      await enqueueResourceWork(async () => {
        const uploaded = await uploadFile(accessToken, file, document.project_id);
        await editor.replaceSelectedAsset({
          assetObjectId: uploaded.asset.id,
          source: file,
        });
        captureEditorScene();
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "图片替换失败。");
      throw error;
    } finally {
      setUploading(false);
    }
  };

  const handleInsertResource = async (
    resource: DesignResourceDto,
    source: Blob,
  ) => {
    const editor = editorRef.current;
    if (!editor) throw new Error("设计编辑器尚未准备完成。");
    await enqueueResourceWork(async () => {
      const input = {
        assetObjectId: resource.asset_object_id,
        resourceId: resource.id,
        source,
      };
      if (resource.kind === "svg") await editor.addSvg(input);
      else await editor.addImage(input);
      captureEditorScene();
    });
    setActionMessage(`已插入素材「${resource.name}」`);
  };

  const handleInsertTextPreset = async (preset: DesignTextPresetDto) => {
    const prepared = instantiateTextPreset(
      preset,
      sceneRef.current?.objects.length ?? 0,
    );
    const commands = prepared.map((object) =>
      designCommandSchema.parse({ action: "object.add", object }),
    );
    if (!sceneRef.current) throw new Error("画板尚未准备完成");
    const fonts = await loadDesignSceneFonts({
      scene: { ...sceneRef.current, objects: prepared },
      accessToken,
      client: resourceClient,
    });
    setFontIssues(fonts.issues);
    if (fonts.issues.length) {
      throw new Error(`文字模板字体加载失败：${fonts.issues.map((issue) => issue.message).join(" ")}`);
    }
    await runEditorCommands(commands, "sync");
    editorRef.current?.refreshTextMetrics();
    historyRef.current?.recordBatch(
      commands.map((command) => ({
        command,
        inverse: designCommandSchema.parse({
          action: "object.remove",
          object_id:
            command.action === "object.add" ? command.object.objectId : "",
          expected_object_version: 1,
        }),
      })),
    );
    editorRef.current?.select(prepared.map((object) => object.objectId));
    captureEditorScene();
    setActionMessage(`已插入文字模板「${preset.name}」`);
  };

  const handleApplyFont = async (face: DesignFontFaceDto) => {
    const editor = editorRef.current;
    if (!editor) throw new Error("设计编辑器尚未准备完成。");
    const selected = editor.getSelectionIds();
    const textIds = selected.filter((objectId) => {
      const object = sceneRef.current?.objects.find(
        (candidate) => candidate.objectId === objectId,
      );
      return object?.type === "text" || object?.type === "textbox";
    });
    if (!textIds.length) throw new Error("请先选择一个文字图层。");
    const replacedFaceIds = new Set(
      textIds.flatMap((objectId) => {
        const object = sceneRef.current?.objects.find(
          (candidate) => candidate.objectId === objectId,
        );
        return object && "fontFaceId" in object && object.fontFaceId
          ? [object.fontFaceId]
          : [];
      }),
    );
    const source = await resourceClient.getFontFaceContent(
      accessToken,
      face.id,
    );
    const url = URL.createObjectURL(source);
    try {
      const loaded = await new FontFace(face.family_name, `url(${url})`, {
        style: face.style,
        weight: String(face.weight),
      }).load();
      globalThis.document.fonts.add(loaded);
      await globalThis.document.fonts.ready;
      for (const objectId of textIds) {
        editor.updateObject(objectId, {
          fontFamily: face.family_name,
          fontFaceId: face.id,
          fontStyle: face.style,
          fontWeight: face.weight,
        });
      }
      captureEditorScene();
      editor.refreshTextMetrics();
      setFontIssues((current) =>
        current.filter((issue) => !replacedFaceIds.has(issue.faceId)),
      );
      setActionMessage(`已应用字体「${face.family_name}」`);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const handleExport = async (options: DesignEditorExportOptions) => {
    // Resource insertion and command replay can both outlive the UI gesture that
    // started them. Wait until neither queue advances before taking the export
    // snapshot so a download cannot silently omit the latest local operation.
    for (;;) {
      const resourceWork = pendingResourceWorkRef.current;
      const editorWork = editorCommandChainRef.current;
      await resourceWork;
      await editorWork;
      if (
        resourceWork === pendingResourceWorkRef.current &&
        editorWork === editorCommandChainRef.current
      )
        break;
    }
    const editor = editorRef.current;
    if (!editor) throw new Error("设计编辑器尚未准备完成。");
    if (fontIssues.length > 0)
      throw new Error("设计中有字体未加载，请替换字体后再导出。");
    const exportScene = editor.serializeScene();
    if (options.format === "gif") {
      const [{ Canvas }, { FabricObjectEditor }] = await Promise.all([
        import("fabric"),
        import("./fabric-object-editor"),
      ]);
      const element = globalThis.document.createElement("canvas");
      const clonedCanvas = new Canvas(element, {
        backgroundColor: exportScene.canvas.background ?? "rgba(0,0,0,0)",
        enableRetinaScaling: false,
        preserveObjectStacking: true,
        selection: false,
      });
      const clonedEditor = new FabricObjectEditor(clonedCanvas, {
        topLeftOrigin: true,
        readOnly: true,
        logicalWidth: exportScene.canvas.width,
        logicalHeight: exportScene.canvas.height,
        maxBackingPixels: DESIGN_GIF_MAX_EDGE ** 2,
      });
      const assetSources = new Map<string, Promise<Blob>>();
      const resolveClonedAsset = (
        object: Extract<DesignObject, { type: "image" | "svg" }>,
      ) => {
        let source = assetSources.get(object.assetObjectId);
        if (!source) {
          source = fetchAssetBlob(accessToken, object.assetObjectId);
          assetSources.set(object.assetObjectId, source);
        }
        return source;
      };
      let clonedSceneReady = false;
      try {
        const result = await exportAnimatedDesignGifInBrowser(
          { name: document.name, scene: exportScene },
          {
            waitForFonts: async () => {
              await globalThis.document.fonts?.ready;
            },
            waitForImages: async () => {
              await clonedEditor.loadScene(exportScene, resolveClonedAsset);
              clonedSceneReady = true;
              const clonedImageState = await clonedEditor.waitForImages();
              missingAssetsRef.current = new Set(
                clonedImageState.missingAssetObjectIds,
              );
              return clonedImageState;
            },
            renderFrame: async (_frameScene, size) => {
              if (!clonedSceneReady)
                throw new Error("GIF cloned scene is not ready.");
              clonedEditor.applyAnimationFrame(size.timeMs);
              return clonedEditor.renderToImageData(size);
            },
          },
        );
        setActionMessage(
          `已导出 ${result.filename}（${result.width}×${result.height}，${result.frameCount} 帧）`,
        );
        return;
      } finally {
        clonedEditor.dispose();
        clonedCanvas.off();
        await clonedCanvas.dispose();
      }
    }
    type StaticExportClone = {
      canvas: FabricCanvas;
      editor: FabricObjectEditorApi;
    };
    let staticClone: Promise<StaticExportClone> | undefined;
    const getStaticClone = () => {
      if (staticClone) return staticClone;
      staticClone = (async () => {
        const [{ Canvas }, { FabricObjectEditor }] = await Promise.all([
          import("fabric"),
          import("./fabric-object-editor"),
        ]);
        const clonedCanvas = new Canvas(
          globalThis.document.createElement("canvas"),
          {
            backgroundColor:
              exportScene.canvas.background ?? "rgba(0,0,0,0)",
            enableRetinaScaling: false,
            preserveObjectStacking: true,
            selection: false,
          },
        );
        let clonedEditor: FabricObjectEditorApi | undefined;
        try {
          clonedEditor = new FabricObjectEditor(clonedCanvas, {
            topLeftOrigin: true,
            readOnly: true,
            logicalWidth: exportScene.canvas.width,
            logicalHeight: exportScene.canvas.height,
          });
          await clonedEditor.loadScene(exportScene, (object) =>
            fetchAssetBlob(accessToken, object.assetObjectId),
          );
          return { canvas: clonedCanvas, editor: clonedEditor };
        } catch (error) {
          clonedEditor?.dispose();
          clonedCanvas.off();
          await clonedCanvas.dispose();
          throw error;
        }
      })();
      return staticClone;
    };
    const port: DesignBrowserExportPort = {
      waitForFonts: async () => {
        await globalThis.document.fonts?.ready;
      },
      waitForImages: async () => {
        const cloned = await getStaticClone();
        const imageState = await cloned.editor.waitForImages();
        missingAssetsRef.current = new Set(imageState.missingAssetObjectIds);
        return imageState;
      },
      renderToBlob: async ({ mimeType, multiplier, transparent }) => {
        const cloned = await getStaticClone();
        return cloned.editor.renderToBlob({
          format: mimeType === "image/jpeg" ? "jpeg" : "png",
          multiplier,
          transparent,
        });
      },
    };
    try {
      const result = await exportDesignInBrowser(
        {
          name: document.name,
          width: exportScene.canvas.width,
          height: exportScene.canvas.height,
          format: options.format,
          multiplier: options.multiplier,
        },
        port,
      );
      if (result.status === "background_required") {
        await flushAll();
        const revision = historyRef.current?.getState().authoritativeRevision;
        if (revision === undefined)
          throw new Error("设计版本尚未准备完成，无法提交后台导出。");
        const response = await client.exportDesign(accessToken, {
          design_id: document.id,
          revision,
          idempotency_key: crypto.randomUUID(),
          format: options.format === "jpeg" ? "jpeg" : "png",
          multiplier: options.multiplier,
          transparent: options.format === "transparent-png",
        });
        upsertExportJob(response.job);
        setExportJobsError(null);
        setActionMessage("大尺寸导出已提交，可关闭画板后继续处理。");
        return "background_queued" as const;
      }
      setActionMessage(`已导出 ${result.filename}`);
    } finally {
      const cloned = staticClone
        ? await staticClone.catch(() => undefined)
        : undefined;
      if (cloned) {
        cloned.editor.dispose();
        cloned.canvas.off();
        await cloned.canvas.dispose();
      }
    }
  };

  const handleCancelExportJob = async (job: BackgroundJob) => {
    setExportJobBusyId(job.id);
    setExportJobsError(null);
    try {
      upsertExportJob(await client.cancelDesignExportJob(accessToken, job.id));
      setActionMessage("后台导出已取消。");
    } catch (error) {
      setExportJobsError(
        error instanceof Error ? error.message : "取消后台导出失败。",
      );
    } finally {
      setExportJobBusyId(null);
    }
  };

  const handleRetryExportJob = async (job: BackgroundJob) => {
    const payload = readExportPayload(job);
    if (!payload) {
      setExportJobsError("该任务缺少完整导出参数，无法重试。");
      return;
    }
    setExportJobBusyId(job.id);
    setExportJobsError(null);
    try {
      const response = await client.exportDesign(accessToken, {
        design_id: document.id,
        revision: payload.revision,
        idempotency_key: crypto.randomUUID(),
        format: payload.format,
        multiplier: payload.multiplier,
        transparent: payload.transparent,
      });
      upsertExportJob(response.job);
      setActionMessage("后台导出已重新提交。");
    } catch (error) {
      setExportJobsError(
        error instanceof Error ? error.message : "重新提交后台导出失败。",
      );
    } finally {
      setExportJobBusyId(null);
    }
  };

  const handleDownloadExportJob = async (job: BackgroundJob) => {
    const result = readExportResult(job);
    const payload = readExportPayload(job);
    if (!result || !payload) {
      setExportJobsError("导出结果尚不可下载。");
      return;
    }
    setExportJobBusyId(job.id);
    setExportJobsError(null);
    try {
      const blob = await fetchAssetBlob(accessToken, result.assetObjectId);
      const url = URL.createObjectURL(blob);
      const anchor = globalThis.document.createElement("a");
      const extension = payload.format === "jpeg" ? "jpg" : "png";
      anchor.href = url;
      anchor.download = `${safeExportFilename(document.name)}@${payload.multiplier}x.${extension}`;
      anchor.click();
      queueMicrotask(() => URL.revokeObjectURL(url));
    } catch (error) {
      setExportJobsError(
        error instanceof Error ? error.message : "导出文件下载失败。",
      );
    } finally {
      setExportJobBusyId(null);
    }
  };

  const handleResize = async (options: DesignResizeOptions) => {
    const current = sceneRef.current;
    if (!current) throw new Error("设计场景尚未准备完成。");
    if (
      current.canvas.width === options.width &&
      current.canvas.height === options.height
    ) {
      return;
    }

    if (options.strategy === "scale") {
      const command = designCommandSchema.parse({
        action: "canvas.update",
        width: options.width,
        height: options.height,
        resize_mode: "scale",
      });
      const inverse = designCommandSchema.parse({
        action: "scene.replace",
        scene: structuredClone(current),
      });
      await runEditorCommands([command], "sync");
      historyRef.current?.record({ command, inverse });
    } else {
      const command = designCommandSchema.parse({
        action: "canvas.update",
        width: options.width,
        height: options.height,
        resize_mode: options.strategy === "extend" ? "expand" : "crop",
      });
      const inverse = designCommandSchema.parse({
        action: "canvas.update",
        width: current.canvas.width,
        height: current.canvas.height,
        resize_mode: options.strategy === "extend" ? "crop" : "expand",
      });
      await runEditorCommands([command], "sync");
      historyRef.current?.record({ command, inverse });
    }
    setActionMessage(null);
  };

  const reloadDiscard = async () => {
    const authoritative = await prepareDocumentFonts(
      await client.getDesign(accessToken, document.id),
    );
    historyRef.current?.reloadDiscard(authoritative.revision);
    missingAssetsRef.current.clear();
    await editorRef.current?.loadScene(authoritative.scene, (object) =>
      fetchAssetBlob(accessToken, object.assetObjectId),
    );
    sceneRef.current = authoritative.scene;
    setScene(authoritative.scene);
    setLoadState({ status: "ready", document: authoritative, message: null });
    setSelectedObjectIds([]);
    editorRef.current?.refreshTextMetrics();
  };

  const reloadKeep = async () => {
    const authoritative = await prepareDocumentFonts(
      await client.getDesign(accessToken, document.id),
    );
    const history = historyRef.current;
    const dirtyBatches = history?.getState().dirtyBatches ?? [];
    const localRebaser = createRevisionRebaser(authoritative.scene);
    missingAssetsRef.current.clear();
    await editorRef.current?.loadScene(authoritative.scene, (object) =>
      fetchAssetBlob(accessToken, object.assetObjectId),
    );
    for (const batch of dirtyBatches) {
      await editorRef.current?.applyCommands(
        batch.commands.map((command) => localRebaser(command)),
        "sync",
      );
    }
    captureEditorScene();
    historyRef.current?.resumeAfterReload(
      authoritative.revision,
      createRevisionRebaser(authoritative.scene),
    );
    editorRef.current?.refreshTextMetrics();
    setLoadState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            document: {
              ...current.document,
              revision: authoritative.revision,
              scene: sceneRef.current ?? authoritative.scene,
            },
            message: null,
          }
        : current,
    );
  };

  reloadKeepRef.current = reloadKeep;

  const handleCanvasReady = (canvas: FabricCanvas) => {
    const syncSelection = () =>
      setSelectedObjectIds(editorRef.current?.getSelectionIds() ?? []);
    canvas.on("selection:created", syncSelection);
    canvas.on("selection:updated", syncSelection);
    canvas.on("selection:cleared", syncSelection);
    if (initialObjectId && sceneRef.current?.objects.some(object => object.objectId === initialObjectId)) {
      editorRef.current?.select([initialObjectId]);
    }
    syncSelection();
  };

  const EditorShell = inline ? DesignInlineEditor : DesignEditorOverlay;
  return (
    <EditorShell
      onRename={async (name) => {
        localRenameRef.current = true;
        try {
        await flushAll();
        const result = await client.renameDesign(accessToken, { design_id: designId,
          expected_revision: historyRef.current!.getState().authoritativeRevision,
          idempotency_key: crypto.randomUUID(), name });
        // Renaming changes document metadata, not object versions or undo history.
        historyRef.current!.resumeAfterReload(result.revision);
        setLoadState(current => current.status === "ready" ? { ...current,
          document: { ...current.document, name, revision: result.revision } } : current);
        window.dispatchEvent(new Event("loomic:design-preview-refresh"));
        } finally { localRenameRef.current = false; }
      }}
      {...(inline
        ? {
            onDropResource: async (
              resourceId: string,
              point: { x: number; y: number },
            ) => {
              const resource = draggedResourceRef.current;
              const editor = editorRef.current;
              if (!resource || resource.id !== resourceId || !editor)
                throw new Error("请从当前资源抽屉拖入素材。");
              const work = enqueueResourceWork(async () => {
                const source = await resourceClient.getResourceContent(
                  accessToken,
                  resource.id,
                );
                if (editorRef.current !== editor)
                  throw new Error("画板已切换，请重新拖入。");
                const input = {
                  assetObjectId: resource.asset_object_id,
                  resourceId: resource.id,
                  source,
                };
                const id =
                  resource.kind === "svg"
                    ? await editor.addSvg(input)
                    : await editor.addImage(input);
                const inserted = editor
                  .serializeScene()
                  .objects.find((object) => object.objectId === id)!;
                const scale = Math.min(
                  1,
                  (scene.canvas.width * 0.35) / inserted.width,
                  (scene.canvas.height * 0.35) / inserted.height,
                );
                editor.updateObject(id, {
                  ...point,
                  width: inserted.width * scale,
                  height: inserted.height * scale,
                });
                captureEditorScene();
                draggedResourceRef.current = null;
              });
              return work;
            },
          }
        : {})}
      open
      designId={document.id}
      name={document.name}
      width={scene.canvas.width}
      height={scene.canvas.height}
      background={scene.canvas.background}
      scene={scene}
      editorRef={editorRef}
      editingEnabled
      dirty={historyState.dirty}
      saving={historyState.status === "saving"}
      saveError={historyState.error}
      statusMessage={actionMessage}
      backgroundRoot={backgroundRoot}
      canUndo={historyState.canUndo}
      canRedo={historyState.canRedo}
      selectedObjectIds={selectedObjectIds}
      layerAdapter={layerAdapter}
      propertyActions={propertyActions}
      uploading={uploading}
      uploadError={uploadError}
      onClose={onClose}
      onSave={async () => {
        await flushAll(true);
        setActionMessage("已保存");
      }}
      onFinish={async () => {
        try {
          await flushAll(true);
          for (;;) {
            await flushAll();
            const revision = historyRef.current!.getState().authoritativeRevision;
            setActionMessage("设计已保存，正在更新画布预览…");
            await waitForDesignPreview(() => client.getDesign(accessToken, designId), revision);
            if (historyRef.current?.getState().dirty) continue;
            await onPreviewReady?.();
            if (historyRef.current?.getState().dirty) continue;
            setActionMessage("设计与画布预览已更新");
            break;
          }
        } catch (error) {
          // A failed render must be queueable again when the user retries.
          for (const key of previewRequests.current.keys()) {
            if (key.startsWith(`${designId}:`)) previewRequests.current.delete(key);
          }
          throw error;
        }
      }}
      onBackgroundChange={handleBackgroundChange}
      onResize={handleResize}
      onUndo={() => historyRef.current?.undo()}
      onRedo={() => historyRef.current?.redo()}
      onAddObject={(type: AddFabricObjectInput["type"]) => {
        const editor = editorRef.current;
        if (!editor) {
          setActionMessage("设计编辑器尚未准备完成。");
          return;
        }
        editor.addObject({ type });
      }}
      onUpload={handleUpload}
      onReplaceUpload={handleReplaceUpload}
      imageTools={
        <DesignImageTools
          selectedImage={selectedImage}
          jobs={imageJobs}
          loading={imageJobsLoading}
          error={imageJobsError}
          busyJobId={imageJobBusyId}
          onRun={(operation) => {
            if (selectedImage)
              void submitImageOperation(selectedImage.objectId, operation);
          }}
          accessToken={accessToken}
          onRunDedicatedLayers={() => { if (selectedImage) void submitImageOperation(selectedImage.objectId, "split_layers", { layerBackend: "qwen-image-layered" }); }}
          onRunSemanticLayers={(request: SemanticLayerSplitRequest) => { if (selectedImage) void submitImageOperation(selectedImage.objectId, "split_layers", { layerBackend: "semantic", layerNames: request.layerNames, repairBackground: request.repairBackground, model: request.model }); }}
          onStartRegion={() => beginImageInteraction("region")}
          onStartErase={() => beginImageInteraction("erase")}
          onRefresh={() => void refreshImageJobs()}
          onCancel={(job) => void handleCancelImageJob(job)}
        />
      }
      resourcePanel={
        <div className="grid gap-2">
          {fontIssues.length > 0 && (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950"
              role="alert"
            >
              <p className="font-medium">
                有 {fontIssues.length} 个字体未正确加载
              </p>
              <p className="mt-1">
                {fontIssues.map((issue) => issue.message).join(" ")}
              </p>
              <button
                type="button"
                className="mt-2 rounded-md border border-amber-400 bg-white px-2 py-1 font-medium"
                onClick={() => {
                  const missingFaceIds = new Set(
                    fontIssues.map((issue) => issue.faceId),
                  );
                  const affectedIds = scene.objects
                    .filter(
                      (object) =>
                        (object.type === "text" || object.type === "textbox") &&
                        object.fontFaceId &&
                        missingFaceIds.has(object.fontFaceId),
                    )
                    .map((object) => object.objectId);
                  editorRef.current?.select(affectedIds);
                  setSelectedObjectIds(affectedIds);
                  setResourceTab("fonts");
                }}
              >
                选择替代字体
              </button>
            </div>
          )}
          <DesignResourcePanel
            {...(inline
              ? {
                  onResourceDrag: (resource: DesignResourceDto) => {
                    draggedResourceRef.current = resource;
                  },
                }
              : {})}
            accessToken={accessToken}
            workspaceId={document.workspace_id}
            activeTab={resourceTab}
            onTabChange={setResourceTab}
            onInsertResource={handleInsertResource}
            onInsertTextPreset={handleInsertTextPreset}
            onApplyFont={handleApplyFont}
            onChooseTemplate={(template) =>
              void openTemplateReplacement(template)
            }
            disabled={templateReplaceBusy}
          />
        </div>
      }
      onCanvasReady={handleCanvasReady}
      onObjectCommand={handleObjectCommand}
      resolveAsset={(object) =>
        fetchAssetBlob(accessToken, object.assetObjectId)
      }
      onResourceMissing={({ assetObjectId }) => {
        missingAssetsRef.current.add(assetObjectId);
        setActionMessage("部分资源加载失败，导出前请重新加载资源。");
      }}
      onPreview={async () => {
        try {
          await flushAll();
          const revision = historyRef.current?.getState().authoritativeRevision;
          if (revision === undefined) return;
          const response = await client.queueDesignPreview(accessToken, {
            design_id: document.id,
            expected_revision: revision,
            idempotency_key: crypto.randomUUID(),
          });
          setActionMessage(
            response.status === "ready" ? "预览已是最新版本" : "预览任务已提交",
          );
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "预览提交失败",
          );
        }
      }}
      onExport={handleExport}
      exportJobs={exportJobs}
      exportJobsLoading={exportJobsLoading}
      exportJobsError={exportJobsError}
      exportJobBusyId={exportJobBusyId}
      onRefreshExportJobs={() => void refreshExportJobs()}
      onCancelExportJob={(job) => void handleCancelExportJob(job)}
      onRetryExportJob={(job) => void handleRetryExportJob(job)}
      onDownloadExportJob={(job) => void handleDownloadExportJob(job)}
      conflictRevision={
        autoRecoverState === "exhausted" ? historyState.conflictRevision : null
      }
      onRetrySave={async () => {
        await historyRef.current?.retry();
      }}
      onReloadKeep={reloadKeep}
      onReloadDiscard={reloadDiscard}
      onEscapeSubInteraction={() => {
        if (templateReplace) {
          setTemplateReplace(null);
          return true;
        }
        if (!imageInteraction) return false;
        setImageInteraction(null);
        return true;
      }}
      subInteraction={
        <>
          {templateReplace && (
            <DesignTemplateReplaceDialog
              currentSize={scene.canvas}
              detail={templateReplace.detail}
              preview={templateReplace.preview}
              bindings={templateReplace.bindings}
              busy={templateReplaceBusy}
              error={templateReplaceError}
              onBindingsChange={(bindings) =>
                setTemplateReplace((current) =>
                  current ? { ...current, bindings, preview: null } : current,
                )
              }
              onPreview={() => void refreshTemplateReplacement()}
              onApply={() => void applyTemplateReplacement()}
              onCancel={() => setTemplateReplace(null)}
            />
          )}
          {imageInteraction?.kind === "region" && (
            <ImageRegionMattingOverlay
              bounds={imageInteraction.bounds}
              angle={imageInteraction.angle}
              onCancel={() => setImageInteraction(null)}
              onConfirm={(region) => {
                const objectId = imageInteraction.objectId;
                setImageInteraction(null);
                void submitImageOperation(objectId, "region_matting", {
                  selectionRegion: region,
                });
              }}
            />
          )}
          {imageInteraction?.kind === "erase" && (
            <ImageEraserOverlay
              bounds={imageInteraction.bounds}
              angle={imageInteraction.angle}
              onCancel={() => setImageInteraction(null)}
              onConfirm={(mode: ImageEraseMode, strokes) => {
                const objectId = imageInteraction.objectId;
                setImageInteraction(null);
                void submitImageOperation(
                  objectId,
                  mode === "smart" ? "smart_erase" : "erase_transparent",
                  { eraseStrokes: strokes },
                );
              }}
            />
          )}
        </>
      }
    />
  );
}

function safeExportFilename(value: string) {
  const sanitized = value.trim().replace(/[<>:"/\\|?*]/g, "-");
  return sanitized || "loomic-design";
}

function imageOperationLabel(operation: DesignImageOperation) {
  if (operation === "remove_background") return "去除背景";
  if (operation === "region_matting") return "框选主体";
  if (operation === "split_layers") return "图层拆分";
  if (operation === "erase_transparent") return "透明擦除";
  return "智能擦除";
}

function promptForImageOperation(operation: DesignImageOperation) {
  if (operation === "remove_background")
    return "Remove the background and preserve the complete foreground subject.";
  if (operation === "region_matting")
    return "Extract the main subject inside the selected region and remove everything else.";
  if (operation === "split_layers")
    return "Separate the image into a repaired background and independent foreground element layers.";
  if (operation === "erase_transparent")
    return "Erase the masked pixels to transparency without changing unmasked pixels.";
  return "Remove the masked details and reconstruct only the masked area without changing unmasked pixels.";
}

function readImageJobFinalization(job: BackgroundJob) {
  const value = job.result?.target_finalization;
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  return value as { status?: unknown };
}

function isImageJobFinalized(job: BackgroundJob) {
  return (
    job.status === "succeeded" &&
    readImageJobFinalization(job)?.status === "completed"
  );
}

function isImageJobActive(job: BackgroundJob) {
  if (job.status === "queued" || job.status === "running") return true;
  if (job.status !== "succeeded") return false;
  const finalization = readImageJobFinalization(job);
  if (!finalization) {
    const updatedAt = Date.parse(job.updated_at);
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < 5 * 60_000;
  }
  return Boolean(
    finalization.status !== "completed" &&
      finalization.status !== "failed" &&
      finalization.status !== "needs_attention",
  );
}

function mapRegionThroughCrop(
  region: NormalizedImageRegion,
  crop: Extract<DesignObject, { type: "image" }>["crop"],
): NormalizedImageRegion {
  if (!crop) return region;
  return {
    x: roundUnit(crop.x + region.x * crop.width),
    y: roundUnit(crop.y + region.y * crop.height),
    width: roundUnit(region.width * crop.width),
    height: roundUnit(region.height * crop.height),
  };
}

function mapStrokesThroughCrop(
  strokes: readonly NormalizedEraseStroke[],
  crop: Extract<DesignObject, { type: "image" }>["crop"],
): NormalizedEraseStroke[] {
  if (!crop) return strokes.map((stroke) => ({ ...stroke }));
  return strokes.map((stroke) => ({
    ...stroke,
    radius: stroke.radius * Math.min(crop.width, crop.height),
    points: stroke.points.map((point) => ({
      x: roundUnit(crop.x + point.x * crop.width),
      y: roundUnit(crop.y + point.y * crop.height),
    })),
  }));
}

function fitMaskDimensions(width: number, height: number) {
  const scale = Math.min(1, 2_048 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function roundUnit(value: number) {
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

function toggleSelection(
  current: readonly string[],
  incoming: readonly string[],
) {
  const next = new Set(current);
  for (const objectId of incoming) {
    if (next.has(objectId)) next.delete(objectId);
    else next.add(objectId);
  }
  return [...next];
}

function refreshCommandVersions(
  rawCommand: DesignCommand,
  scene: LoomicSceneV1 | null,
): DesignCommand {
  if (!scene) return rawCommand;
  const version = (objectId: string) =>
    scene.objects.find((object) => object.objectId === objectId)?.objectVersion;
  const command = structuredClone(rawCommand);
  if (command.action === "scene.replace") {
    command.scene.objects = command.scene.objects.map((object) => ({
      ...object,
      objectVersion: (version(object.objectId) ?? object.objectVersion) + 1,
    })) as LoomicSceneV1["objects"];
  } else if (
    command.action === "object.update" ||
    command.action === "object.remove" ||
    command.action === "object.reorder" ||
    command.action === "object.set_role"
  ) {
    command.expected_object_version =
      version(command.object_id) ?? command.expected_object_version;
  } else if (command.action === "object.clone") {
    command.expected_object_version =
      version(command.source_object_id) ?? command.expected_object_version;
  } else if (command.action === "objects.ungroup") {
    command.expected_object_version =
      version(command.group_object_id) ?? command.expected_object_version;
  } else if (command.action === "objects.group") {
    command.children = command.children.map((reference) => ({
      ...reference,
      expected_object_version:
        version(reference.object_id) ?? reference.expected_object_version,
    }));
  } else if (
    command.action === "objects.align" ||
    command.action === "objects.distribute"
  ) {
    command.objects = command.objects.map((reference) => ({
      ...reference,
      expected_object_version:
        version(reference.object_id) ?? reference.expected_object_version,
    })) as typeof command.objects;
  }
  return designCommandSchema.parse(command);
}

function createRevisionRebaser(scene: LoomicSceneV1) {
  const versions = new Map(
    scene.objects.map((object) => [object.objectId, object.objectVersion]),
  );
  return (command: DesignCommand): DesignCommand => {
    const rebased = refreshCommandVersions(command, {
      ...scene,
      objects: scene.objects.map((object) => ({
        ...object,
        objectVersion: versions.get(object.objectId) ?? object.objectVersion,
      })) as LoomicSceneV1["objects"],
    });
    for (const objectId of changedObjectIds(rebased)) {
      versions.set(objectId, (versions.get(objectId) ?? 0) + 1);
    }
    if (rebased.action === "object.add" || rebased.action === "object.clone") {
      versions.set(rebased.object.objectId, rebased.object.objectVersion);
    }
    return rebased;
  };
}

function changedObjectIds(command: DesignCommand): string[] {
  if (
    command.action === "object.update" ||
    command.action === "object.remove" ||
    command.action === "object.reorder" ||
    command.action === "object.set_role"
  ) {
    return [command.object_id];
  }
  if (command.action === "object.clone") return [command.source_object_id];
  if (command.action === "objects.ungroup") return [command.group_object_id];
  if (command.action === "objects.group") {
    return command.children.map((item) => item.object_id);
  }
  if (
    command.action === "objects.align" ||
    command.action === "objects.distribute"
  ) {
    return command.objects.map((item) => item.object_id);
  }
  return [];
}

function instantiateTextPreset(
  preset: DesignTextPresetDto,
  zIndexOffset: number,
): DesignObject[] {
  const sourceById = new Map(
    preset.style.objects.map((object) => [object.objectId, object]),
  );
  const idMap = new Map(
    preset.style.objects.map((object) => [
      object.objectId,
      crypto.randomUUID(),
    ]),
  );
  const ordered: DesignObject[] = [];
  const visited = new Set<string>();
  const visit = (objectId: string) => {
    if (visited.has(objectId)) return;
    const source = sourceById.get(objectId);
    if (!source) return;
    if (source.type === "group") {
      for (const childId of source.childObjectIds) visit(childId);
    }
    visited.add(objectId);
    const object = structuredClone(source) as DesignObject;
    object.objectId = idMap.get(source.objectId) ?? crypto.randomUUID();
    object.objectVersion = 1;
    object.zIndex = zIndexOffset + ordered.length;
    object.x += 40;
    object.y += 40;
    if (object.type === "group") {
      object.childObjectIds = object.childObjectIds.map(
        (childId) => idMap.get(childId) ?? childId,
      );
    }
    ordered.push(object);
  };
  for (const object of preset.style.objects) visit(object.objectId);
  return ordered;
}
