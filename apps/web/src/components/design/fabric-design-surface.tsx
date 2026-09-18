"use client";

import type { DesignObject, LoomicSceneV1 } from "@loomic/shared";
import type { Canvas as FabricCanvas, InteractiveFabricObject } from "fabric";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { fabricCanvasLifecycle } from "./fabric-canvas-lifecycle";
import { DesignAnimationPreview } from "./design-animation-preview";
import type {
  FabricAlignmentGuide,
  FabricObjectCommandEvent,
  FabricObjectEditorApi,
} from "./fabric-object-editor";

export type FabricDesignSurfaceProps = {
  showOverflow?: boolean;
  inlineSize?: { width: number; height: number };
  width: number;
  height: number;
  background: string | null;
  readOnly?: boolean;
  onCanvasReady?: (canvas: FabricCanvas) => void | Promise<void>;
  onCanvasDispose?: () => void;
  onCanvasError?: (error: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  scene?: LoomicSceneV1;
  resolveAsset?: (
    object: Extract<DesignObject, { type: "image" | "svg" }>,
  ) => Promise<string | Blob> | string | Blob;
  onObjectCommand?: (event: FabricObjectCommandEvent) => void;
  onResourceMissing?: (input: {
    objectId: string;
    assetObjectId: string;
    type: "image" | "svg";
    error: unknown;
  }) => void;
  onAlignmentGuidesChange?: (guides: readonly FabricAlignmentGuide[]) => void;
};

export const FabricDesignSurface = forwardRef<
  FabricObjectEditorApi,
  FabricDesignSurfaceProps
>(function FabricDesignSurface(
  {
    inlineSize,
    showOverflow = false,
    width,
    height,
    background,
    readOnly = false,
    onCanvasReady,
    onCanvasDispose,
    onCanvasError,
    onDirtyChange,
    scene,
    resolveAsset,
    onObjectCommand,
    onResourceMissing,
    onAlignmentGuidesChange,
  },
  forwardedRef,
) {
  const canvasElementRef = useRef<HTMLCanvasElement>(null);
  const padding = showOverflow && !readOnly ? Math.max(width, height) / 2 : 0;
  const [displaySize, setDisplaySize] = useState({width, height});
  const display = inlineSize ?? displaySize;
  const padX = padding * display.width / width;
  const padY = padding * display.height / height;
  // The overflow is a visual preview. Fabric receives hits on the board and
  // the selected object's controls; surrounding empty space pans the editor.
  const inlineOverflow = Boolean(inlineSize && showOverflow && !readOnly);
  const [previewReady, setPreviewReady] = useState(false);
  const [pauseSignal, setPauseSignal] = useState(0);
  const inlineSizeRef = useRef(inlineSize);
  inlineSizeRef.current = inlineSize;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<FabricCanvas | null>(null);
  const editorRef = useRef<FabricObjectEditorApi | null>(null);
  const initialSceneRef = useRef(scene);
  // A dimension change recreates Fabric. Hydrate the current document, not
  // the snapshot from the first mount (which may even have been blank).
  initialSceneRef.current = scene;
  const initialBackgroundRef = useRef(background);
  const backgroundRef = useRef(background);
  const onCanvasReadyRef = useRef(onCanvasReady);
  const onCanvasDisposeRef = useRef(onCanvasDispose);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onCanvasErrorRef = useRef(onCanvasError);
  const resolveAssetRef = useRef(resolveAsset);
  const onObjectCommandRef = useRef(onObjectCommand);
  const onResourceMissingRef = useRef(onResourceMissing);
  const onAlignmentGuidesChangeRef = useRef(onAlignmentGuidesChange);
  const [alignmentGuides, setAlignmentGuides] = useState<
    readonly FabricAlignmentGuide[]
  >([]);
  onCanvasReadyRef.current = onCanvasReady;
  onCanvasDisposeRef.current = onCanvasDispose;
  onDirtyChangeRef.current = onDirtyChange;
  onCanvasErrorRef.current = onCanvasError;
  resolveAssetRef.current = resolveAsset;
  onObjectCommandRef.current = onObjectCommand;
  onResourceMissingRef.current = onResourceMissing;
  onAlignmentGuidesChangeRef.current = onAlignmentGuidesChange;
  backgroundRef.current = background;

  useImperativeHandle(
    forwardedRef,
    () => ({
      loadScene: (...args) => requireEditor(editorRef).loadScene(...args),
      setBackground: (...args) => requireEditor(editorRef).setBackground(...args),
      refreshTextMetrics: () => requireEditor(editorRef).refreshTextMetrics(),
      serializeScene: () => requireEditor(editorRef).serializeScene(),
      applyCommands: (...args) =>
        requireEditor(editorRef).applyCommands(...args),
      addObject: (...args) => requireEditor(editorRef).addObject(...args),
      cloneSelection: () => requireEditor(editorRef).cloneSelection(),
      replaceSelectedAsset: (...args) =>
        requireEditor(editorRef).replaceSelectedAsset(...args),
      updateObject: (...args) => requireEditor(editorRef).updateObject(...args),
      addImage: (...args) => requireEditor(editorRef).addImage(...args),
      addSvg: (...args) => requireEditor(editorRef).addSvg(...args),
      getSelectionIds: () => requireEditor(editorRef).getSelectionIds(),
      getObjectViewportBounds: (...args) =>
        requireEditor(editorRef).getObjectViewportBounds(...args),
      subscribeSelection: (...args) =>
        requireEditor(editorRef).subscribeSelection(...args),
      select: (...args) => requireEditor(editorRef).select(...args),
      removeSelection: () => requireEditor(editorRef).removeSelection(),
      setLocked: (...args) => requireEditor(editorRef).setLocked(...args),
      setVisible: (...args) => requireEditor(editorRef).setVisible(...args),
      flip: (...args) => requireEditor(editorRef).flip(...args),
      reorder: (...args) => requireEditor(editorRef).reorder(...args),
      align: (...args) => requireEditor(editorRef).align(...args),
      distribute: (...args) => requireEditor(editorRef).distribute(...args),
      group: (...args) => requireEditor(editorRef).group(...args),
      ungroup: (...args) => requireEditor(editorRef).ungroup(...args),
      waitForImages: () => requireEditor(editorRef).waitForImages(),
      renderToBlob: (...args) => requireEditor(editorRef).renderToBlob(...args),
      renderToImageData: (...args) =>
        requireEditor(editorRef).renderToImageData(...args),
      dispose: () => requireEditor(editorRef).dispose(),
    }),
    [],
  );

  useEffect(() => {
    const canvasElement = canvasElementRef.current;
    const viewport = viewportRef.current;
    if (!canvasElement || !viewport) return;

    let cancelled = false;
    let canvas: FabricCanvas | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let disposalStarted = false;
    let clearOverflowHitRegion: (() => void) | undefined;

    const disposeCanvas = async () => {
      if (disposalStarted || !canvas) return;
      disposalStarted = true;
      const mounted = canvas;
      canvas = undefined;
      canvasRef.current = null;
      editorRef.current?.dispose();
      editorRef.current = null;
      resizeObserver?.disconnect();
      clearOverflowHitRegion?.();
      clearOverflowHitRegion = undefined;
      mounted.off();
      await fabricCanvasLifecycle.unmount(mounted);
      onCanvasDisposeRef.current?.();
    };

    const setup = async () => {
      const { Canvas } = await import("fabric");
      const mounted = await fabricCanvasLifecycle.mount(
        () =>
          new Canvas(canvasElement, {
            backgroundColor: backgroundRef.current ?? "rgba(0,0,0,0)",
            enableRetinaScaling: false,
            preserveObjectStacking: true,
            selection: !readOnly,
          }),
      );
      canvas = mounted;
      canvasRef.current = mounted;
      initialBackgroundRef.current = backgroundRef.current;
      if (inlineOverflow) {
        const upperCanvas = mounted.upperCanvasEl;
        const updateHitRegion = () => {
          const currentInlineSize = inlineSizeRef.current;
          if (!currentInlineSize) return;
          upperCanvas.style.clipPath = makeOverflowHitPath(
            mounted,
            currentInlineSize,
            padding,
            width,
            height,
          );
        };
        // Selection events update the path before the next pointer event;
        // after:render also follows object transforms and viewport resizing.
        mounted.on("after:render", updateHitRegion);
        mounted.on("selection:created", updateHitRegion);
        mounted.on("selection:updated", updateHitRegion);
        mounted.on("selection:cleared", updateHitRegion);
        updateHitRegion();
        clearOverflowHitRegion = () => {
          mounted.off("after:render", updateHitRegion);
          mounted.off("selection:created", updateHitRegion);
          mounted.off("selection:updated", updateHitRegion);
          mounted.off("selection:cleared", updateHitRegion);
          upperCanvas.style.clipPath = "";
        };
      }

      if (cancelled) {
        await disposeCanvas();
        return;
      }

      // Establish the document coordinate system once. ResizeObserver must
      // never rewrite it when only the editor viewport changes.
      const { FabricObjectEditor } = await import("./fabric-object-editor");
      const editor = new FabricObjectEditor(mounted, {
        topLeftOrigin: Boolean(inlineSizeRef.current),
        readOnly,
        logicalWidth: width,
        logicalHeight: height,
        viewportPadding: padding,
        onCommand: (event) => onObjectCommandRef.current?.(event),
        onResourceMissing: (input) => onResourceMissingRef.current?.(input),
        onAlignmentGuidesChange: (guides) => {
          setAlignmentGuides(guides);
          onAlignmentGuidesChangeRef.current?.(guides);
        },
      });
      editorRef.current = editor;
      if (initialSceneRef.current) {
        await editor.loadScene(initialSceneRef.current, (object) => {
          const resolver = resolveAssetRef.current;
          if (!resolver)
            throw new Error("No authorized asset resolver was provided.");
          return resolver(object);
        });
      }
      const fitToViewport = () => {
        if (inlineSizeRef.current) {
          mounted.setDimensions({width: inlineSizeRef.current.width * (1 + 2 * padding / width), height: inlineSizeRef.current.height * (1 + 2 * padding / height)}, { cssOnly: true });
          mounted.calcOffset();
          mounted.requestRenderAll();
          return;
        }
        const availableWidth = Math.max(1, viewport.clientWidth - 64);
        const availableHeight = Math.max(1, viewport.clientHeight - 64);
        const scale = Math.min(
          1,
          availableWidth / width,
          availableHeight / height,
        );
        const displayWidth = Math.max(1, Math.round(width * scale));
        const displayHeight = Math.max(1, Math.round(height * scale));
        setDisplaySize({width:displayWidth,height:displayHeight});
        // Backing-store pixels are budgeted by FabricObjectEditor. CSS only
        // controls presentation; Fabric's viewport transform keeps pointers
        // and objects in the document's logical coordinate system.
        mounted.setDimensions(
          { width: displayWidth * (1 + 2 * padding / width), height: displayHeight * (1 + 2 * padding / height) },
          { cssOnly: true },
        );
        mounted.requestRenderAll();
      };

      fitToViewport();
      resizeObserver = new ResizeObserver(fitToViewport);
      resizeObserver.observe(viewport);

      if (readOnly) {
        mounted.forEachObject((object) => {
          object.selectable = false;
          object.evented = false;
        });
        mounted.discardActiveObject();
      }
      await onCanvasReadyRef.current?.(mounted);
      // Hydration belongs to the caller and must not make a freshly opened
      // document dirty. Only begin observing mutations after it completes.
      const markDirty = () => onDirtyChangeRef.current?.(true);
      mounted.on("object:added", markDirty);
      mounted.on("object:modified", markDirty);
      mounted.on("object:removed", markDirty);
      mounted.requestRenderAll();
    };

    void setup().catch(async (error: unknown) => {
      await disposeCanvas();
      onCanvasErrorRef.current?.(error);
      console.error(
        "[design-editor] Failed to initialize Fabric canvas:",
        error,
      );
    });
    return () => {
      cancelled = true;
      void disposeCanvas();
    };
  }, [height, readOnly, width, padding]);

  useEffect(() => {
    if (inlineSize && canvasRef.current) {
      canvasRef.current.setDimensions({width:inlineSize.width * (1 + 2 * padding / width),height:inlineSize.height * (1 + 2 * padding / height)}, { cssOnly: true });
      canvasRef.current.calcOffset();
      canvasRef.current.requestRenderAll();
    }
  }, [inlineSize, padding, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || background === initialBackgroundRef.current) return;
    initialBackgroundRef.current = background;
    editorRef.current?.setBackground(background);
    canvas.requestRenderAll();
  }, [background]);

  return (
    <div
      ref={viewportRef}
      className={
        inlineSize
          ? "h-full w-full overflow-visible"
          : "flex h-full min-h-0 items-center justify-center overflow-hidden bg-muted/50 p-8"
      }
      data-testid="design-fabric-viewport"
      data-inline-overflow={inlineOverflow || undefined}
      style={inlineOverflow ? {
        "--design-hit-inset-x": `${padX}px`,
        "--design-hit-inset-y": `${padY}px`,
      } as React.CSSProperties : undefined}
    >
      {inlineOverflow && <style>{`
        [data-inline-overflow="true"] .canvas-container,
        [data-inline-overflow="true"] canvas.lower-canvas {
          pointer-events: none;
        }
        [data-inline-overflow="true"] canvas.upper-canvas {
          pointer-events: auto;
        }
      `}</style>}
      <div className="relative shrink-0 shadow-float ring-1 ring-foreground/10"
        style={{width:display.width,height:display.height}}
        onPointerDownCapture={e => { if (e.target instanceof HTMLCanvasElement) { setPreviewReady(false); setPauseSignal(v => v + 1); } }}>
        <div style={{position:"absolute",left:-padX,top:-padY,opacity:previewReady ? 0 : 1,pointerEvents:inlineOverflow ? "none" : undefined}}>
        <canvas
          ref={canvasElementRef}
          aria-label={`${width} × ${height} 像素设计画板`}
        />
        </div>
        {padding > 0 && <div data-testid="design-overflow-shade" aria-hidden="true" className="pointer-events-none absolute z-20" style={{inset:0,border:"1px solid rgba(0,0,0,0.55)"}}>
          <div className="absolute bg-white/40" style={{left:-padX,top:-padY,width:display.width+2*padX,height:padY}} />
          <div className="absolute bg-white/40" style={{left:-padX,top:display.height,width:display.width+2*padX,height:padY}} />
          <div className="absolute bg-white/40" style={{left:-padX,top:0,width:padX,height:display.height}} />
          <div className="absolute bg-white/40" style={{left:display.width,top:0,width:padX,height:display.height}} />
        </div>}
        <DesignAnimationPreview viewportPadding={padding} {...(scene ? { scene } : {})} {...(resolveAsset ? { resolveAsset } : {})} pauseSignal={pauseSignal} onReady={setPreviewReady} />
        {alignmentGuides.map((guide, index) => (
          <span
            // Guides are transient and may share the same position.
            key={`${guide.axis}:${guide.position}:${guide.source}:${index}`}
            aria-hidden="true"
            className="pointer-events-none absolute z-20 bg-primary"
            style={
              guide.axis === "x"
                ? {
                    left: `${(guide.position / width) * 100}%`,
                    top: 0,
                    width: 1,
                    height: "100%",
                  }
                : {
                    left: 0,
                    top: `${(guide.position / height) * 100}%`,
                    width: "100%",
                    height: 1,
                  }
            }
          />
        ))}
      </div>
    </div>
  );
});

function requireEditor(ref: { current: FabricObjectEditorApi | null }) {
  if (!ref.current) throw new Error("Fabric design editor is not ready.");
  return ref.current;
}

function makeOverflowHitPath(
  canvas: FabricCanvas,
  inlineSize: { width: number; height: number },
  padding: number,
  logicalWidth: number,
  logicalHeight: number,
) {
  const upperCanvas = canvas.upperCanvasEl;
  // Fabric's control coordinates use backing-store pixels. clip-path path()
  // uses local CSS pixels, which stay correct even when an ancestor is zoomed.
  const cssWidth = parseFloat(upperCanvas.style.width) || upperCanvas.clientWidth;
  const cssHeight = parseFloat(upperCanvas.style.height) || upperCanvas.clientHeight;
  const scaleX = cssWidth / canvas.getWidth();
  const scaleY = cssHeight / canvas.getHeight();
  const left = inlineSize.width * padding / logicalWidth;
  const top = inlineSize.height * padding / logicalHeight;
  const right = left + inlineSize.width;
  const bottom = top + inlineSize.height;
  const paths = [polygonPath([
    { x: left, y: top }, { x: right, y: top },
    { x: right, y: bottom }, { x: left, y: bottom },
  ])];
  const activeObject = canvas.getActiveObject() as InteractiveFabricObject | undefined;
  if (activeObject?.hasControls && Number.isFinite(scaleX) && Number.isFinite(scaleY)) {
    // setCoords refreshes rotated controls and ActiveSelection coordinates.
    activeObject.setCoords();
    for (const [key, coord] of Object.entries(activeObject.oCoords)) {
      if (!activeObject.isControlVisible(key)) continue;
      for (const corners of [coord.corner, coord.touchCorner]) {
        paths.push(polygonPath([corners.tl, corners.tr, corners.br, corners.bl].map(
          ({ x, y }) => ({ x: x * scaleX, y: y * scaleY }),
        )));
      }
    }
  }
  return `path("${paths.join(" ")}")`;
}

function polygonPath(points: readonly { x: number; y: number }[]) {
  return `M ${points.map(({ x, y }) => `${roundPathCoordinate(x)} ${roundPathCoordinate(y)}`).join(" L ")} Z`;
}

function roundPathCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
}
