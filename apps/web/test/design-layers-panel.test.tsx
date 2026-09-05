// @vitest-environment jsdom

import type { DesignObject } from "@loomic/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignLayersPanel } from "../src/components/design/design-layers-panel";
import type { DesignLayerAdapter } from "../src/lib/design-layer-model";

afterEach(cleanup);

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";

describe("DesignLayersPanel", () => {
  it("selects, searches, renames and exposes layer controls through the adapter", async () => {
    const adapter = mockAdapter();
    render(
      <DesignLayersPanel
        objects={[
          rect(firstId, 0, "背景层", true),
          rect(secondId, 1, "标题层"),
        ]}
        selectedObjectIds={[secondId]}
        adapter={adapter}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "选择图层：标题层" }),
    );
    expect(adapter.selectObjectIds).toHaveBeenCalledWith([secondId], "replace");
    const lockButton = screen.getAllByRole("button", { name: "锁定图层" })[0];
    if (!lockButton) throw new Error("Expected a layer lock button");
    await userEvent.click(lockButton);
    expect(adapter.updateObject).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "置于底层" }));
    expect(adapter.reorderObject).toHaveBeenCalledWith(secondId, 0);

    const renameButton = screen.getAllByRole("button", {
      name: "重命名图层",
    })[0];
    if (!renameButton) throw new Error("Expected a layer rename button");
    await userEvent.click(renameButton);
    const rename = screen.getByLabelText("重命名图层：标题层");
    await userEvent.clear(rename);
    await userEvent.type(rename, "新标题{Enter}");
    expect(adapter.renameObject).toHaveBeenCalledWith(secondId, "新标题");

    await userEvent.type(screen.getByLabelText("搜索设计图层"), "背景");
    expect(screen.queryByText("标题层")).toBeNull();
    expect(screen.getByText("背景层")).toBeTruthy();
  });

  it("runs batch lock and visibility operations for a multi-selection", async () => {
    const adapter = mockAdapter();
    render(
      <DesignLayersPanel
        objects={[rect(firstId, 0, "一"), rect(secondId, 1, "二")]}
        selectedObjectIds={[firstId, secondId]}
        adapter={adapter}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "批量锁定" }));
    await userEvent.click(screen.getByRole("button", { name: "批量隐藏" }));
    expect(adapter.updateMany).toHaveBeenNthCalledWith(1, [firstId, secondId], {
      locked: true,
    });
    expect(adapter.updateMany).toHaveBeenNthCalledWith(2, [firstId, secondId], {
      visible: false,
    });
  });

  it("reorders layers by dragging one row onto another", () => {
    const adapter = mockAdapter();
    const { container } = render(
      <DesignLayersPanel
        objects={[rect(firstId, 0, "一"), rect(secondId, 1, "二")]}
        selectedObjectIds={[]}
        adapter={adapter}
      />,
    );
    const source = container.querySelector(`[data-layer-id="${firstId}"]`);
    const target = container.querySelector(`[data-layer-id="${secondId}"]`);
    if (!source || !target) throw new Error("Expected draggable layer rows");
    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => firstId),
    };
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(adapter.reorderObject).toHaveBeenCalledWith(firstId, 1);
  });
});

function mockAdapter(): DesignLayerAdapter {
  return {
    selectObjectIds: vi.fn(),
    renameObject: vi.fn(),
    updateObject: vi.fn(),
    reorderObject: vi.fn(),
    updateMany: vi.fn(),
  };
}

function rect(
  objectId: string,
  zIndex: number,
  name: string,
  locked = false,
): DesignObject {
  return {
    objectId,
    objectVersion: 1,
    type: "rect",
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex,
    locked,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
  };
}
