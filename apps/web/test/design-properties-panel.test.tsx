import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DesignPropertiesActions,
  DesignPropertiesPanel,
} from "../src/components/design/design-properties-panel";

const object = {
  objectId: "00000000-0000-4000-8000-000000000001",
  objectVersion: 1,
  type: "text" as const,
  name: "标题",
  x: 10,
  y: 20,
  width: 200,
  height: 60,
  rotation: 0,
  opacity: 1,
  zIndex: 0,
  locked: false,
  visible: true,
  text: "Loomic",
  fontFamily: "Arial",
  fontSize: 32,
  fontWeight: 400,
  fontStyle: "normal" as const,
  textAlign: "left" as const,
  lineHeight: 1.2,
  charSpacing: 0,
  fill: { kind: "solid" as const, color: "#111111" },
};

afterEach(cleanup);

describe("DesignPropertiesPanel", () => {
  it("commits numeric and text properties through the typed adapter", () => {
    const actions = actionSpies();
    render(
      <DesignPropertiesPanel selectedObjects={[object]} actions={actions} />,
    );

    const x = screen.getByLabelText("X");
    fireEvent.change(x, { target: { value: "48" } });
    fireEvent.blur(x);
    const text = screen.getByLabelText("文字");
    fireEvent.change(text, { target: { value: "新标题" } });
    fireEvent.blur(text);

    expect(actions.updateObject).toHaveBeenCalledWith(object.objectId, {
      x: 48,
    });
    expect(actions.updateObject).toHaveBeenCalledWith(object.objectId, {
      text: "新标题",
    });
  });

  it("commits the input event value when Enter immediately blurs a field", () => {
    const actions = actionSpies();
    const view = render(
      <DesignPropertiesPanel selectedObjects={[object]} actions={actions} />,
    );

    const fontSize = screen.getByLabelText("字号");
    fireEvent.focus(fontSize);
    fireEvent.change(fontSize, { target: { value: "52" } });
    view.rerender(
      <DesignPropertiesPanel
        selectedObjects={[{ ...object, objectVersion: 2, fontStyle: "italic" }]}
        actions={actions}
      />,
    );
    expect((screen.getByLabelText("字号") as HTMLInputElement).value).toBe(
      "52",
    );
    view.rerender(
      <DesignPropertiesPanel selectedObjects={[]} actions={actions} />,
    );
    view.rerender(
      <DesignPropertiesPanel
        selectedObjects={[{ ...object, objectVersion: 3, fontStyle: "italic" }]}
        actions={actions}
      />,
    );
    const remountedFontSize = screen.getByLabelText("字号");
    expect((remountedFontSize as HTMLInputElement).value).toBe("52");
    fireEvent.keyDown(remountedFontSize, { key: "Enter" });
    fireEvent.blur(remountedFontSize);

    expect(actions.updateObject).toHaveBeenCalledWith(object.objectId, {
      fontSize: 52,
    });
    expect(actions.updateObject).not.toHaveBeenCalledWith(object.objectId, {
      fontSize: 32,
    });
  });

  it("debounces the dirty value even when the whole properties panel unmounts", () => {
    vi.useFakeTimers();
    try {
      const actions = actionSpies();
      const view = render(
        <DesignPropertiesPanel selectedObjects={[object]} actions={actions} />,
      );
      const fontSize = screen.getByLabelText("字号");
      fireEvent.focus(fontSize);
      fireEvent.change(fontSize, { target: { value: "52" } });
      view.unmount();

      act(() => vi.advanceTimersByTime(200));

      expect(actions.updateObject).toHaveBeenCalledTimes(1);
      expect(actions.updateObject).toHaveBeenCalledWith(object.objectId, {
        fontSize: 52,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables multi-selection alignment and grouping", () => {
    const actions = actionSpies();
    render(
      <DesignPropertiesPanel
        selectedObjects={[
          object,
          {
            ...object,
            objectId: "00000000-0000-4000-8000-000000000002",
            zIndex: 1,
          },
        ]}
        actions={actions}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "左对齐" }));
    fireEvent.click(screen.getByRole("button", { name: /组合/ }));
    expect(actions.align).toHaveBeenCalledWith("left");
    expect(actions.group).toHaveBeenCalledOnce();
  });

  it("commits non-destructive crop, mask and filter controls for images", () => {
    const actions = actionSpies();
    const image = {
      ...object,
      type: "image" as const,
      assetObjectId: "00000000-0000-4000-8000-000000000010",
      fit: "cover" as const,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      filters: { brightness: 0.1 },
    };
    const {
      text: _text,
      fontFamily: _fontFamily,
      fontSize: _fontSize,
      fontWeight: _fontWeight,
      fontStyle: _fontStyle,
      textAlign: _textAlign,
      lineHeight: _lineHeight,
      charSpacing: _charSpacing,
      fill: _fill,
      ...imageObject
    } = image;
    render(
      <DesignPropertiesPanel
        selectedObjects={[imageObject]}
        actions={actions}
      />,
    );

    const cropWidth = screen.getByLabelText("裁剪宽 %");
    fireEvent.change(cropWidth, {
      target: { value: "80" },
    });
    fireEvent.blur(cropWidth);
    fireEvent.change(screen.getByLabelText("蒙版"), {
      target: { value: "ellipse" },
    });
    const brightness = screen.getByLabelText(/亮度/);
    fireEvent.change(brightness, {
      target: { value: "0.35" },
    });
    fireEvent.pointerUp(brightness);

    expect(actions.updateObject).toHaveBeenCalledWith(imageObject.objectId, {
      crop: { x: 0, y: 0, width: 0.8, height: 1 },
    });
    expect(actions.updateObject).toHaveBeenCalledWith(imageObject.objectId, {
      mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1 },
    });
    expect(actions.updateObject).toHaveBeenCalledWith(imageObject.objectId, {
      filters: { brightness: 0.35 },
    });
  });
});

function actionSpies(): DesignPropertiesActions {
  return {
    updateObject: vi.fn(),
    removeSelection: vi.fn(),
    flip: vi.fn(),
    align: vi.fn(),
    distribute: vi.fn(),
    group: vi.fn(),
    ungroup: vi.fn(),
  };
}
