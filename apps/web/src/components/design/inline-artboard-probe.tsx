"use client";

// Development-only experiment. No project API, user document or Agent calls.
import "@excalidraw/excalidraw/index.css";
import type { LoomicSceneV1 } from "@loomic/shared";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Canvas } from "fabric";
import { FabricCanvasLifecycle } from "./fabric-canvas-lifecycle";
import { FabricObjectEditor } from "./fabric-object-editor";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  { ssr: false },
);
const STORAGE = "loomic:inline-artboard-probe:v1";
const assetId = "00000000-0000-4000-8000-000000000001";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" rx="16" fill="#6366f1"/><circle cx="50" cy="40" r="22" fill="#facc15"/></svg>';
const asset = () =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
type Board = {
  id: string;
  x: number;
  y: number;
  scene: LoomicSceneV1;
  preview?: string;
};
function initialBoards(): Board[] {
  return [0, 1].map((i) => ({
    id: i ? "B" : "A",
    x: 80 + i * 740,
    y: 90,
    scene: {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: i ? 480 : 640, height: 480, background: "#ffffff" },
      objects: [],
    },
  }));
}

export function InlineArtboardProbe() {
  const [boards, setBoards] = useState<Board[]>(initialBoards);
  const boardsRef = useRef(boards);
  const [active, setActive] = useState("A");
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("仅验证页，不写入项目数据");
  const [view, setView] = useState({ zoom: 0.7, x: 0, y: 0 });
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const node = useRef<HTMLCanvasElement>(null);
  const fabric = useRef<Canvas | null>(null);
  const editor = useRef<FabricObjectEditor | null>(null);
  const lifecycle = useRef(new FabricCanvasLifecycle());
  const sync = useRef<() => void>(() => undefined);
  const board = boards.find((b) => b.id === active)!;
  boardsRef.current = boards;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE);
      if (saved) {
        const parsed = JSON.parse(saved) as Board[];
        if (
          parsed.length === 2 &&
          parsed.every((b) => b.scene?.schemaVersion === 1)
        )
          setBoards(parsed);
      }
    } catch {
      setStatus("验证草稿读取失败，使用空白画板");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || !node.current) return;
    const element = node.current;
    const current = boardsRef.current.find((b) => b.id === active)!;
    let stopped = false;
    let canvas: Canvas | undefined;
    let instance: FabricObjectEditor | undefined;
    setReady(false);
    const setup = async () => {
      const { Canvas } = await import("fabric");
      canvas = await lifecycle.current.mount(
        () =>
          new Canvas(element, {
            backgroundColor: "#ffffff",
            enableRetinaScaling: false,
            preserveObjectStacking: true,
          }),
      );
      if (stopped) {
        await lifecycle.current.unmount(canvas);
        return;
      }
      instance = new FabricObjectEditor(canvas, {
        topLeftOrigin: true,
        logicalWidth: current.scene.canvas.width,
        logicalHeight: current.scene.canvas.height,
        onCommand: () => sync.current(),
      });
      await instance.loadScene(current.scene, asset);
      if (stopped) return;
      fabric.current = canvas;
      editor.current = instance;
      sync.current = () => {
        if (!instance || !canvas || stopped) return;
        const scene = instance.serializeScene();
        const preview = canvas.toDataURL({ multiplier: 0.4, format: "png" });
        const next = boardsRef.current.map((b) =>
          b.id === active ? { ...b, scene, preview } : b,
        );
        boardsRef.current = next;
        setBoards(next);
      };
      setReady(true);
    };
    void setup().catch((e) => setStatus(String(e)));
    return () => {
      stopped = true;
      sync.current = () => undefined;
      editor.current = null;
      fabric.current = null;
      instance?.dispose();
      if (canvas) void lifecycle.current.unmount(canvas);
    };
  }, [active, loaded]);

  useEffect(() => {
    if (!ready || !fabric.current) return;
    fabric.current.setDimensions(
      {
        width: board.scene.canvas.width * view.zoom,
        height: board.scene.canvas.height * view.zoom,
      },
      { cssOnly: true },
    );
    fabric.current.calcOffset();
    fabric.current.requestRenderAll();
  }, [ready, view, board.scene.canvas.width, board.scene.canvas.height]);

  function moveView(zoom: number, x: number, y: number) {
    const next = { zoom: Math.min(2, Math.max(0.2, zoom)), x, y };
    setView(next);
    api.current?.updateScene({
      appState: { zoom: { value: next.zoom as never }, scrollX: x, scrollY: y },
    });
  }

  async function insert(kind: string, x: number, y: number) {
    try {
      const instance = editor.current;
      if (!instance || !ready) return;
      let insertedId: string;
      if (kind === "text")
        insertedId = instance.addObject({
          type: "text",
          text: "原位设计",
          x,
          y,
        });
      else {
        const id = await instance.addImage({
          assetObjectId: assetId,
          source: asset(),
        });
        instance.updateObject(id, { x, y, width: 100, height: 80 });
        insertedId = id;
      }
      // Drop position means the durable object's top-left, independent of
      // Fabric's runtime center origin for newly constructed objects.
      const inserted = instance
        .serializeScene()
        .objects.find((o) => o.objectId === insertedId)!;
      instance.updateObject(insertedId, {
        x: x + (x - inserted.x),
        y: y + (y - inserted.y),
      });
      sync.current();
    } catch (e) {
      setStatus(String(e));
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b p-3">
        <strong>原位画板 · 验证原型</strong>
        {boards.map((b) => (
          <button
            key={b.id}
            disabled={!ready}
            onClick={() => {
              sync.current();
              setActive(b.id);
            }}
          >
            画板 {b.id}
          </button>
        ))}
        <button onClick={() => moveView(view.zoom + 0.2, view.x, view.y)}>
          放大
        </button>
        <button onClick={() => moveView(view.zoom - 0.2, view.x, view.y)}>
          缩小
        </button>
        <button onClick={() => moveView(view.zoom, view.x - 100, view.y + 40)}>
          平移
        </button>
        <button
          disabled={!ready}
          onClick={() => {
            sync.current();
            try {
              localStorage.setItem(STORAGE, JSON.stringify(boardsRef.current));
              setStatus("已保存验证草稿（仅本浏览器）");
            } catch {
              setStatus("保存失败：浏览器存储不足");
            }
          }}
        >
          保存验证草稿
        </button>
        <span role="status">{status}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="z-20 w-40 shrink-0 border-r bg-background p-3">
          <p>拖到正在编辑的画板</p>
          <button
            className="my-4 block rounded-xl border p-3"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", "asset")}
            onClick={() => void insert("asset", 60, 60)}
          >
            示例素材
          </button>
          <button
            className="block rounded-xl border p-3"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", "text")}
            onClick={() => void insert("text", 60, 180)}
          >
            示例文字
          </button>
          <p className="mt-6 text-xs">
            滚轮缩放；空白处使用画布平移。素材为本页内置测试图。
          </p>
        </aside>
        <main
          className="relative isolate min-w-0 flex-1 overflow-hidden"
          data-testid="probe-world"
        >
          <div className="absolute inset-0 z-0">
            <Excalidraw
              excalidrawAPI={(value) => {
                api.current = value;
              }}
              initialData={{
                appState: {
                  zoom: { value: 0.7 as never },
                  scrollX: 0,
                  scrollY: 0,
                },
              }}
              onChange={(_, state) =>
                setView((v) =>
                  v.zoom === state.zoom.value &&
                  v.x === state.scrollX &&
                  v.y === state.scrollY
                    ? v
                    : {
                        zoom: state.zoom.value,
                        x: state.scrollX,
                        y: state.scrollY,
                      },
                )
              }
            />
          </div>
          {boards.map((b) => (
            <div
              key={b.id}
              data-testid={`board-${b.id}`}
              className="absolute z-10 bg-white shadow-lg"
              style={{
                left: (b.x + view.x) * view.zoom,
                top: (b.y + view.y) * view.zoom,
                width: b.scene.canvas.width * view.zoom,
                height: b.scene.canvas.height * view.zoom,
                outline:
                  b.id === active ? "2px solid #6366f1" : "1px solid #bbb",
              }}
              onWheel={(e) => {
                e.stopPropagation();
                moveView(
                  view.zoom * (e.deltaY < 0 ? 1.1 : 0.9),
                  view.x,
                  view.y,
                );
              }}
              onDragOver={(e) => {
                if (b.id === active && ready) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (b.id !== active) return;
                const bounds = e.currentTarget.getBoundingClientRect();
                void insert(
                  e.dataTransfer.getData("text/plain"),
                  (e.clientX - bounds.left) / view.zoom,
                  (e.clientY - bounds.top) / view.zoom,
                );
              }}
            >
              <span className="pointer-events-none absolute -top-6 text-xs">
                画板 {b.id} · {b.scene.canvas.width} × {b.scene.canvas.height}
              </span>
              {b.id === active ? (
                <div
                  className="h-full w-full overflow-hidden"
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <canvas key={active} ref={node} />
                </div>
              ) : (
                <button
                  className="h-full w-full"
                  disabled={!ready}
                  onClick={() => {
                    sync.current();
                    setActive(b.id);
                  }}
                >
                  {b.preview ? (
                    <img
                      src={b.preview}
                      alt={`画板 ${b.id} 预览`}
                      className="h-full w-full"
                    />
                  ) : (
                    "点击编辑"
                  )}
                </button>
              )}
            </div>
          ))}
        </main>
        <aside className="z-20 w-52 shrink-0 overflow-auto border-l bg-background p-3">
          <p>当前图层 · {active}</p>
          <output data-testid="probe-ready">
            {ready ? "ready" : "loading"}
          </output>
          <pre
            data-testid="probe-scene"
            className="whitespace-pre-wrap text-xs"
          >
            {JSON.stringify(
              board.scene.objects.map((o) => ({
                id: o.objectId,
                type: o.type,
                x: o.x,
                y: o.y,
              })),
              null,
              2,
            )}
          </pre>
          {board.scene.objects.map((o) => (
            <button
              className="block"
              key={o.objectId}
              onClick={() => editor.current?.select([o.objectId])}
            >
              {o.type} · 选择图层
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
