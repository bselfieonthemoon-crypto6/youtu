// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClarificationDialog, parseClarificationQuestions } from "./clarification-dialog";

it("shows all five steps and submits original field labels including skipped answers", () => {
  const questions = parseClarificationQuestions(`先确认几项关键信息：
1. 品牌名称：文字是什么？
2. 行业/用途：比如餐饮、科技。
3. 风格倾向：极简、科技。
4. 颜色偏好：指定或自由搭配。
5. logo 类型：只要图形还是只要文字？`);
  const onSubmit = vi.fn();
  render(<ClarificationDialog questions={questions} onClose={vi.fn()} onSubmit={onSubmit} />);
  expect(screen.getByText("1/5")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("输入自定义回答..."), { target: { value: "aaaa.com" } });
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  expect(screen.getByRole("heading", { name: "行业/用途" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "跳过" }));
  fireEvent.click(screen.getByRole("button", { name: /高端/ }));
  fireEvent.click(screen.getByRole("button", { name: "下一个" }));
  fireEvent.click(screen.getByRole("button", { name: "跳过" }));
  expect(screen.getByText("5/5")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /只要文字/ }));
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("1. 品牌名称：aaaa.com\n2. 行业/用途：暂未确定\n3. 风格倾向：高端\n4. 颜色偏好：暂未确定\n5. logo 类型：只要文字");
});
