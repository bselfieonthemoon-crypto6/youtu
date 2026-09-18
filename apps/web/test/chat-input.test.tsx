// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatInput, type ChatInputHandle } from "../src/components/chat-input";

describe("ChatInput", () => {
  afterEach(cleanup);

  it("restores a rejected submission for correction and retry", async () => {
    render(<ChatInput onSend={async () => ({ status: "failed" })} />);
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "背景改成绿色" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue("背景改成绿色"));
  });

  it("does not overwrite a newer draft when an older submission fails", async () => {
    let reject!: (error: Error) => void;
    render(<ChatInput onSend={() => new Promise((_resolve, fail) => { reject = fail; })} />);
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "旧补充" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "新的草稿" } });
    await act(async () => reject(new Error("connection failed")));
    expect(input).toHaveValue("新的草稿");
  });

  it("adds a selected skill invitation to the composer without sending or discarding its draft", () => {
    const ref = createRef<ChatInputHandle>();
    const send = () => { throw new Error("selecting a skill must not send"); };
    render(<ChatInput ref={ref} onSend={send} />);
    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "保留这段目标" } });

    act(() => ref.current?.prependInvitation("请使用「海报设计」技能协助我。"));

    expect(input).toHaveValue("请使用「海报设计」技能协助我。\n\n保留这段目标");
  });

});
