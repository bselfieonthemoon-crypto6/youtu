"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, Suspense } from "react";

import type { ImageArtifact, VideoArtifact } from "@loomic/shared";
import type { CanvasImageItem } from "../../components/canvas-image-picker";
import type { CanvasSelectedElement } from "../../components/canvas-editor";
import { LoadingScreen } from "../../components/loading-screen";
import { useAuth } from "../../lib/auth-context";
import { useWebSocket } from "../../hooks/use-websocket";
import { useJobFallbackPolling } from "../../hooks/use-job-fallback-polling";
import { CanvasEditor } from "../../components/canvas-editor";
import { ChatSidebar } from "../../components/chat-sidebar";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { EditableProjectName } from "../../components/editable-project-name";
import {
  insertImageOnCanvas,
  insertVideoOnCanvas,
} from "../../lib/canvas-elements";
import {
  mergeCanvasElements,
  type CanvasElementLike,
} from "../../lib/canvas-element-merge";
import { fetchCanvas, fetchProject, ApiAuthError } from "../../lib/server-api";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import { CanvasBottomBar } from "../../components/canvas-bottom-bar";
import { CanvasFilesPanel } from "../../components/canvas-files-panel";
import { CanvasLayersPanel } from "../../components/canvas-layers-panel";
import { CreditHeaderButton } from "../../components/credits/credit-header-button";
import type { CanvasImageChatCommand } from "../../components/canvas/image-toolbar-types";
import { DesignEditorSession } from "../../components/design/design-editor-session";

function CanvasPageContent() {
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const initialSessionId = searchParams.get("session") ?? undefined;
  // Capture prompt once — router.replace will strip it from URL, but the
  // value must survive for the auto-send effect in ChatSidebar.
  const [initialPrompt] = useState(
    () => searchParams.get("prompt") ?? undefined,
  );
  const { user, session, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    revision: number;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  // Default chat open on desktop, closed on mobile/tablet to avoid blocking canvas
  const [chatOpen, setChatOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1024;
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled");
  const [selectedCanvasElements, setSelectedCanvasElements] = useState<
    CanvasSelectedElement[]
  >([]);
  const [imageChatCommand, setImageChatCommand] =
    useState<CanvasImageChatCommand | null>(null);
  const [activeDesign, setActiveDesign] = useState<{ designId: string } | null>(
    null,
  );
  const pageRootRef = useRef<HTMLDivElement>(null);
  const agentDesignSaveRef = useRef<(() => Promise<void>) | null>(null);
  const [designSwitchError, setDesignSwitchError] = useState<string | null>(
    null,
  );
  const designSwitchBusy = useRef(false);
  const openDesignSafely = async (target: { designId: string }) => {
    if (designSwitchBusy.current || target.designId === activeDesign?.designId)
      return;
    designSwitchBusy.current = true;
    try {
      if (searchParams.get("inlineArtboard") === "1" && activeDesign) {
        if (!agentDesignSaveRef.current)
          throw new Error("画板尚未就绪，暂时不能切换。");
        await agentDesignSaveRef.current();
      }
      setDesignSwitchError(null);
      setActiveDesign(target);
    } catch (e) {
      setDesignSwitchError(
        e instanceof Error ? e.message : "请先保存当前画板再切换。",
      );
    } finally {
      designSwitchBusy.current = false;
    }
  };
  const bindAgentDesignSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      agentDesignSaveRef.current = save;
    },
    [],
  );
  const canvasLoadGenerationRef = useRef(0);
  const canvasSyncGenerationRef = useRef(0);
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const excalidrawApiRef = useRef<any>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable callbacks for panel toggles to prevent re-renders of child components
  const handleOpenChat = useCallback(() => setChatOpen(true), []);
  const handleImageChatCommand = useCallback(
    (command: CanvasImageChatCommand) => {
      setChatOpen(true);
      setImageChatCommand(command);
    },
    [],
  );
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const handleToggleLayers = useCallback(() => {
    setLayersOpen((v) => !v);
    setFilesOpen(false);
  }, []);
  const handleToggleFiles = useCallback(() => {
    setFilesOpen((v) => !v);
    setLayersOpen(false);
  }, []);
  const handleCloseLayers = useCallback(() => setLayersOpen(false), []);
  const handleCloseFiles = useCallback(() => setFilesOpen(false), []);
  const handleCanvasRevisionChange = useCallback((revision: number) => {
    setCanvasData((current) =>
      current && revision > current.revision
        ? { ...current, revision }
        : current,
    );
  }, []);

  const accessToken = session?.access_token;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const getToken = useCallback(() => accessTokenRef.current ?? null, []);
  const ws = useWebSocket(getToken);

  const handleApiReady = useCallback((api: any) => {
    excalidrawApiRef.current = api;
    setExcalidrawApi(api);
  }, []);

  const handleImageGenerated = useCallback((artifact: ImageArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertImageOnCanvas(api, artifact).catch((err) => {
      console.warn("Failed to insert image on canvas:", err);
    });
  }, []);

  const handleVideoGenerated = useCallback((artifact: VideoArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertVideoOnCanvas(api, artifact).catch((err) => {
      console.warn("Failed to insert video on canvas:", err);
    });
  }, []);

  // Must be defined BEFORE useJobFallbackPolling which references it
  const handleCanvasSync = useCallback(async () => {
    const api = excalidrawApiRef.current;
    const token = accessTokenRef.current;
    if (!api || !token || !canvasData) return;
    const requestedCanvasId = canvasData.id;
    const syncGeneration = ++canvasSyncGenerationRef.current;
    try {
      const { canvas } = await fetchCanvas(token, requestedCanvasId);
      if (
        canvasIdRef.current !== requestedCanvasId ||
        canvasSyncGenerationRef.current !== syncGeneration ||
        excalidrawApiRef.current !== api
      ) {
        return;
      }
      handleCanvasRevisionChange(canvas.revision);
      const elements = canvas.content.elements ?? [];
      const files = (canvas.content as Record<string, unknown>).files as
        | Record<
            string,
            {
              id: string;
              dataURL?: string;
              storageUrl?: string;
              mimeType: string;
              created: number;
            }
          >
        | undefined;

      // Publish refreshed file metadata to CanvasEditor. It performs bounded,
      // viewport-aware hydration instead of starting an unbounded second wave
      // of image downloads during reconnect or job completion.
      if (files && Object.keys(files).length > 0) {
        setCanvasData((current) =>
          current?.id === requestedCanvasId
            ? {
                ...current,
                content: {
                  ...current.content,
                  elements,
                  files,
                },
              }
            : current,
        );
      }

      const localElements =
        api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements();
      const remoteElements = elements.filter(
        (element): element is Record<string, unknown> & CanvasElementLike =>
          typeof element.id === "string",
      );
      const localIds = new Set(
        (localElements as CanvasElementLike[]).map((element) => element.id),
      );
      const addedElements = remoteElements.filter(
        (element) => !element.isDeleted && !localIds.has(element.id),
      );
      const mergedElements = mergeCanvasElements(
        localElements as CanvasElementLike[],
        remoteElements,
      );
      api.updateScene({
        elements: mergedElements,
        captureUpdate: "IMMEDIATELY",
      });
      if (addedElements.length > 0) {
        // Focus the newly generated node rather than fitting the entire
        // (potentially very large) canvas, where the result can look missing.
        requestAnimationFrame(() =>
          api.scrollToContent?.(addedElements, {
            animate: true,
            fitToContent: true,
          }),
        );
      }
    } catch (err) {
      console.warn("Failed to sync canvas:", err);
    }
  }, [canvasData, handleCanvasRevisionChange]);

  // Fallback polling for timed-out generation jobs. A successful job is not
  // assumed to be on the canvas: this callback only fires when the server's
  // authoritative job state already includes an element id.
  const { checkForTimedOutJobs } = useJobFallbackPolling({
    accessTokenRef,
    onJobSucceeded: useCallback(
      (_jobId: string, _jobType: string, _elementId: string) => {
        handleCanvasSync();
      },
      [handleCanvasSync],
    ),
  });

  const handleSessionChange = useCallback(
    (sessionId: string) => {
      if (!canvasId) return;
      // Update URL: set session param, remove prompt param to prevent re-send on refresh
      const inlineFlag =
        new URLSearchParams(window.location.search).get("inlineArtboard") ===
        "1"
          ? "&inlineArtboard=1"
          : "";
      routerRef.current.replace(
        `/canvas?id=${canvasId}&session=${sessionId}${inlineFlag}`,
      );
    },
    [canvasId],
  );

  const handleRequestCanvasImages = useCallback((): CanvasImageItem[] => {
    const api = excalidrawApiRef.current;
    if (!api) return [];
    const elements: any[] = api.getSceneElements() ?? [];
    const files: Record<string, any> = api.getFiles() ?? {};
    let idx = 0;
    return elements
      .filter((el: any) => el.type === "image" && !el.isDeleted && el.fileId)
      .map((el: any) => {
        idx++;
        const file = files[el.fileId];
        const dataURL = file?.dataURL ?? "";
        const title =
          el.customData?.title || el.customData?.label || `Image ${idx}`;
        return {
          kind: "canvas-image",
          id: el.id,
          name: title,
          thumbnailUrl: dataURL,
          assetId: el.customData?.assetId ?? file?.assetId ?? el.id,
          url: dataURL,
          mimeType: file?.mimeType ?? "image/png",
        };
      });
  }, []);

  // Only re-fetch when canvasId changes or on initial auth resolution.
  // Token refreshes (e.g. tab switch back) should NOT trigger a reload —
  // we depend on user.id (stable string) instead of the user object ref.
  const userId = user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      routerRef.current.replace("/login");
      return;
    }
    const token = accessTokenRef.current;
    if (!canvasId || !token) return;

    const loadGeneration = ++canvasLoadGenerationRef.current;
    let cancelled = false;
    const isCurrentLoad = () =>
      !cancelled && canvasLoadGenerationRef.current === loadGeneration;

    setPageLoading(true);
    setError(null);
    setBrandKitId(null);
    setProjectName("Untitled");
    void fetchCanvas(token, canvasId)
      .then((data) => {
        if (!isCurrentLoad()) return;
        const c = data.canvas;
        setCanvasData({
          id: c.id,
          name: c.name,
          projectId: c.projectId,
          revision: c.revision,
          content: {
            elements: c.content.elements ?? [],
            appState: c.content.appState ?? {},
            files: (c.content as any).files ?? {},
          },
        });
        setPageLoading(false);
        // Fetch project to get brand_kit_id and name
        fetchProject(token, c.projectId)
          .then((projectData) => {
            if (!isCurrentLoad()) return;
            setBrandKitId(projectData.project.brand_kit_id);
            setProjectName(projectData.project.name ?? "Untitled");
          })
          .catch((err) => {
            if (isCurrentLoad()) {
              console.warn("Failed to fetch project for brand kit:", err);
            }
          });
      })
      .catch((err) => {
        if (!isCurrentLoad()) return;
        if (err instanceof ApiAuthError) {
          signOutRef.current().then(() => routerRef.current.replace("/login"));
          return;
        }
        setError("Failed to load canvas.");
        setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally omitting accessTokenRef (stable ref) and signOutRef/routerRef
    // (ref wrappers) from deps — only re-run when auth resolves, user changes, or
    // canvasId changes. Token refresh (e.g. tab switch) must NOT trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, userId, canvasId]);

  if (!canvasId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">No canvas ID specified.</p>
      </div>
    );
  }

  if (authLoading || pageLoading) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!canvasData || !accessToken) return null;

  return (
    <div ref={pageRootRef} className="flex h-screen w-screen overflow-hidden">
      {designSwitchError && (
        <div
          role="alert"
          className="fixed bottom-24 left-4 z-50 rounded-xl border bg-background p-3 text-destructive"
        >
          {designSwitchError}
        </div>
      )}
      {/* Top-left navigation bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          accessToken={accessToken}
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          excalidrawApi={excalidrawApi}
        />
        <EditableProjectName
          accessToken={accessToken}
          projectId={canvasData.projectId}
          initialName={projectName}
        />
        <BrandKitSelector
          accessToken={accessToken}
          projectId={canvasData.projectId}
          currentBrandKitId={brandKitId}
          onBrandKitChange={(kitId) => setBrandKitId(kitId)}
        />
      </div>
      {/* Canvas always takes full width; on mobile/tablet, ChatSidebar overlays instead of side-by-side */}
      <div className="flex-1 relative min-w-0 overflow-hidden">
        {/* Credits button — canvas area top-right, NOT chatbar */}
        <div
          className={`absolute top-3 z-20 transition-[right] duration-200 ${
            chatOpen ? "right-3" : "right-[84px]"
          }`}
        >
          <CreditHeaderButton />
        </div>
        <CanvasEditor
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          accessToken={accessToken}
          canvasRevision={canvasData.revision}
          initialContent={canvasData.content}
          onApiReady={handleApiReady}
          ws={ws}
          leftPanelOpen={layersOpen || filesOpen}
          onSelectionChange={setSelectedCanvasElements}
          onImageChatCommand={handleImageChatCommand}
          onCanvasRefreshRequest={handleCanvasSync}
          onCanvasRevisionChange={handleCanvasRevisionChange}
          onOpenDesign={(target) => {
            void openDesignSafely(target);
          }}
        />
        <CanvasEmptyHint
          excalidrawApi={excalidrawApi}
          onOpenChat={handleOpenChat}
        />
        <CanvasBottomBar
          excalidrawApi={excalidrawApi}
          layersOpen={layersOpen}
          onToggleLayers={handleToggleLayers}
          filesOpen={filesOpen}
          onToggleFiles={handleToggleFiles}
          leftPanelOpen={layersOpen || filesOpen}
        />
        <CanvasLayersPanel
          excalidrawApi={excalidrawApi}
          open={layersOpen}
          onClose={handleCloseLayers}
        />
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={filesOpen}
          onClose={handleCloseFiles}
        />
      </div>
      <ChatSidebar
        {...(searchParams.get("inlineArtboard") === "1" && activeDesign
          ? {
              activeDesignId: activeDesign.designId,
              beforeDesignSend: async () => {
                if (!agentDesignSaveRef.current)
                  throw new Error("画板尚未就绪，请稍后发送。");
                await agentDesignSaveRef.current();
              },
            }
          : {})}
        accessToken={accessToken}
        canvasId={canvasData.id}
        open={chatOpen}
        onToggle={handleToggleChat}
        onImageGenerated={handleImageGenerated}
        onVideoGenerated={handleVideoGenerated}
        onCanvasSync={handleCanvasSync}
        onStreamEvent={checkForTimedOutJobs}
        initialPrompt={initialPrompt}
        initialSessionId={initialSessionId}
        onSessionChange={handleSessionChange}
        onRequestCanvasImages={handleRequestCanvasImages}
        currentBrandKitId={brandKitId}
        ws={ws}
        selectedCanvasElements={selectedCanvasElements}
        imageChatCommand={imageChatCommand}
        onOpenDesign={(designId) => {
          void openDesignSafely({ designId });
        }}
      />
      {activeDesign && pageRootRef.current && (
        <DesignEditorSession
          onBindAgentSave={bindAgentDesignSave}
          inline={searchParams.get("inlineArtboard") === "1"}
          accessToken={accessToken}
          designId={activeDesign.designId}
          backgroundRoot={pageRootRef.current}
          onClose={() => setActiveDesign(null)}
          ws={ws}
        />
      )}
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasPageContent />
    </Suspense>
  );
}
