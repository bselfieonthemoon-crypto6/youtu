import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelContextFields } from "../src/components/settings/model-context-fields";

describe("model context settings", () => {
  it("does not invent capacity and validates before configuring", () => {
    const onChange = vi.fn(); render(<ModelContextFields onChange={onChange} />);
    expect(screen.getByText(/未验证 · 使用保守运行预算/)).toBeTruthy();
    fireEvent.click(screen.getByText("确认容量，随供应商设置保存"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("总上下文窗口 tokens"), { target: { value: "128000" } });
    fireEvent.change(screen.getByLabelText("输入上限 tokens"), { target: { value: "128000" } });
    fireEvent.change(screen.getByLabelText("输出上限 tokens"), { target: { value: "16000" } });
    fireEvent.change(screen.getByLabelText("上下文验证来源"), { target: { value: "supplier docs" } });
    fireEvent.click(screen.getByText("确认容量，随供应商设置保存"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ contextWindowTokens: 128000, profileSource: "supplier docs" }));
  });
  it("lets administrators remove a formerly verified capacity", () => {
    const onChange = vi.fn(); render(<ModelContextFields onChange={onChange} value={{ contextWindowTokens: 128000,
      maxInputTokens: 128000, maxOutputTokens: 16000, profileSource: "docs", verifiedAt: "2026-09-09T01:00:00Z", profileVersion: "v1" }} />);
    fireEvent.click(screen.getByText("恢复未验证状态"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
