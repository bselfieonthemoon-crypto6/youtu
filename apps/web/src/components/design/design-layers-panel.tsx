"use client";

import type { DesignObject } from "@loomic/shared";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Search,
  Unlock,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DESIGN_ROLE_LABELS,
  type DesignLayerAdapter,
  type DesignLayerMove,
  buildDesignLayerTree,
  designLayerLabel,
  designLayerMoveTarget,
  flattenVisibleDesignLayers,
} from "../../lib/design-layer-model";

export function DesignLayersPanel({
  objects,
  selectedObjectIds,
  adapter,
}: {
  objects: readonly DesignObject[];
  selectedObjectIds: readonly string[];
  adapter: DesignLayerAdapter;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [draggedObjectId, setDraggedObjectId] = useState<string | null>(null);
  const selected = useMemo(
    () => new Set(selectedObjectIds),
    [selectedObjectIds],
  );
  const nodes = useMemo(
    () =>
      flattenVisibleDesignLayers(
        buildDesignLayerTree(objects, query),
        collapsed,
      ),
    [collapsed, objects, query],
  );

  const moveSelected = (move: DesignLayerMove) => {
    if (selectedObjectIds.length !== 1) return;
    const objectId = selectedObjectIds[0];
    if (!objectId) return;
    const target = designLayerMoveTarget(objects, objectId, move);
    if (target !== null) adapter.reorderObject(objectId, target);
  };

  return (
    <aside
      className="flex h-full min-h-0 w-[280px] flex-col border-l border-border bg-card"
      aria-label="设计图层"
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            aria-label="搜索设计图层"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索图层、类型或语义角色"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <div className="mt-2 flex gap-1" aria-label="图层排序">
          <LayerAction
            label="下移一层"
            icon={ArrowDown}
            onClick={() => moveSelected("down")}
          />
          <LayerAction
            label="上移一层"
            icon={ArrowUp}
            onClick={() => moveSelected("up")}
          />
          <LayerAction
            label="置于底层"
            icon={ChevronsDown}
            onClick={() => moveSelected("bottom")}
          />
          <LayerAction
            label="置于顶层"
            icon={ChevronsUp}
            onClick={() => moveSelected("top")}
          />
        </div>
        {selectedObjectIds.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1" aria-label="批量图层操作">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={() =>
                adapter.updateMany([...selectedObjectIds], { locked: true })
              }
            >
              批量锁定
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={() =>
                adapter.updateMany([...selectedObjectIds], { locked: false })
              }
            >
              批量解锁
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={() =>
                adapter.updateMany([...selectedObjectIds], { visible: false })
              }
            >
              批量隐藏
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={() =>
                adapter.updateMany([...selectedObjectIds], { visible: true })
              }
            >
              批量显示
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {nodes.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">
            没有匹配的图层
          </p>
        ) : (
          nodes.map(({ object, depth, children }) => {
            const isSelected = selected.has(object.objectId);
            const isGroup = object.type === "group";
            const isCollapsed = collapsed.has(object.objectId);
            return (
              <div
                key={object.objectId}
                data-layer-id={object.objectId}
                draggable={editingObjectId !== object.objectId}
                className={`group flex h-10 items-center rounded-lg ${draggedObjectId === object.objectId ? "opacity-45" : ""} ${isSelected ? "bg-muted" : "hover:bg-muted/70"}`}
                style={{ paddingLeft: 6 + depth * 16 }}
                onDragStart={(event) => {
                  setDraggedObjectId(object.objectId);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", object.objectId);
                }}
                onDragEnd={() => setDraggedObjectId(null)}
                onDragOver={(event) => {
                  if (draggedObjectId && draggedObjectId !== object.objectId) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId =
                    draggedObjectId || event.dataTransfer.getData("text/plain");
                  const targetIndex = objects.findIndex(
                    (candidate) => candidate.objectId === object.objectId,
                  );
                  if (
                    sourceId &&
                    sourceId !== object.objectId &&
                    targetIndex >= 0
                  ) {
                    adapter.reorderObject(sourceId, targetIndex);
                  }
                  setDraggedObjectId(null);
                }}
              >
                {isGroup ? (
                  <button
                    type="button"
                    aria-label={isCollapsed ? "展开组合" : "折叠组合"}
                    className="flex size-6 items-center justify-center"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(object.objectId))
                          next.delete(object.objectId);
                        else next.add(object.objectId);
                        return next;
                      })
                    }
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-4" />
                    ) : (
                      <ChevronDown className="size-4" />
                    )}
                  </button>
                ) : (
                  <span className="w-6" />
                )}
                {editingObjectId === object.objectId ? (
                  <LayerRenameInput
                    object={object}
                    onCancel={() => setEditingObjectId(null)}
                    onCommit={(name) => {
                      adapter.renameObject(object.objectId, name);
                      setEditingObjectId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={`选择图层：${designLayerLabel(object)}`}
                    className="min-w-0 flex-1 text-left"
                    onDoubleClick={() => setEditingObjectId(object.objectId)}
                    onClick={(event) =>
                      adapter.selectObjectIds(
                        [object.objectId],
                        event.metaKey || event.ctrlKey ? "toggle" : "replace",
                      )
                    }
                  >
                    <span className="block truncate text-xs text-foreground">
                      {designLayerLabel(object)}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {object.type}
                      {object.role
                        ? ` · ${DESIGN_ROLE_LABELS[object.role]}`
                        : ""}
                      {isGroup ? ` · ${children.length}` : ""}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  aria-label="重命名图层"
                  className="flex size-7 items-center justify-center opacity-50 hover:opacity-100"
                  onClick={() => setEditingObjectId(object.objectId)}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={object.locked ? "解锁图层" : "锁定图层"}
                  className="flex size-7 items-center justify-center"
                  onClick={() =>
                    adapter.updateObject(object.objectId, {
                      locked: !object.locked,
                    })
                  }
                >
                  {object.locked ? (
                    <Lock className="size-3.5" />
                  ) : (
                    <Unlock className="size-3.5 opacity-50" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={object.visible ? "隐藏图层" : "显示图层"}
                  className="flex size-7 items-center justify-center"
                  onClick={() =>
                    adapter.updateObject(object.objectId, {
                      visible: !object.visible,
                    })
                  }
                >
                  {object.visible ? (
                    <Eye className="size-3.5 opacity-50" />
                  ) : (
                    <EyeOff className="size-3.5" />
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function LayerRenameInput({
  object,
  onCancel,
  onCommit,
}: {
  object: DesignObject;
  onCancel: () => void;
  onCommit: (name: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const canceledRef = useRef(false);
  useEffect(() => inputRef.current?.focus(), []);
  const commit = () => {
    if (canceledRef.current) return;
    const name = inputRef.current?.value.trim();
    if (name) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={inputRef}
      aria-label={`重命名图层：${designLayerLabel(object)}`}
      defaultValue={object.name ?? designLayerLabel(object)}
      className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs outline-none"
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          canceledRef.current = true;
          onCancel();
          return;
        }
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function LayerAction({
  label,
  icon: Icon,
  onClick,
}: { label: string; icon: typeof ArrowUp; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md hover:bg-muted"
    >
      <Icon className="size-4" />
    </button>
  );
}
