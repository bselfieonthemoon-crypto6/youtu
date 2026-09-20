// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reported defect: "the chat's image/model picker cannot read any models, so they can
 * neither chat nor generate".
 *
 * Two things were wrong. The picker swallowed every failure (`.catch(() => {})`) and
 * rendered an empty control, so a workspace with nothing published and a list that never
 * loaded looked identical - neither state said anything. And the list was not re-derived
 * per identity, so what a previous account could see could be reused.
 */

const { fetchModelsMock, fetchImageModelsMock, fetchVideoModelsMock } = vi.hoisted(() => ({
  fetchModelsMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchVideoModelsMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchModels: fetchModelsMock,
  fetchImageModels: fetchImageModelsMock,
  fetchVideoModels: fetchVideoModelsMock,
}));

import { AgentModelSelector } from "../src/components/agent-model-selector";
import { ChatInput } from "../src/components/chat-input";
import { ImageModelPreferencePopover } from "../src/components/image-model-preference";

const TEXT_EMPTY = "当前工作区还没有可用的对话模型，请管理员在后台配置并发布模型。";
const IMAGE_EMPTY = "当前工作区还没有可用的图片模型，请管理员在后台配置并发布模型。";
const LOAD_FAILED = "模型列表加载失败，请检查网络后重试。";

function openAgentPicker() {
  return userEvent.click(screen.getByRole("button", { name: "Agent" }));
}

function ImagePickerHarness({ accessToken }: { accessToken?: string | undefined }) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <ImageModelPreferencePopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        accessToken={accessToken}
      />
    </>
  );
}

describe("agent (text) model picker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchModelsMock.mockReset().mockResolvedValue({ models: [] });
    fetchImageModelsMock.mockReset().mockResolvedValue({ models: [] });
    fetchVideoModelsMock.mockReset().mockResolvedValue({ models: [] });
  });
  afterEach(() => cleanup());

  it("explains an empty workspace instead of showing an empty picker", async () => {
    render(<AgentModelSelector accessToken="token-empty-workspace" />);
    await openAgentPicker();

    const empty = await screen.findByTestId("agent-model-empty");
    expect(empty).toHaveTextContent(TEXT_EMPTY);
    // The Auto option stays usable: an empty list is not a broken control.
    expect(screen.getByRole("button", { name: /Auto \(workspace default\)/ })).toBeEnabled();
  });

  it("reports a failed load as a failure with a retry, not as an empty workspace", async () => {
    fetchModelsMock.mockRejectedValueOnce(new Error("Failed to fetch models: 503"));
    render(<AgentModelSelector accessToken="token-load-failure" />);
    await openAgentPicker();

    const failure = await screen.findByTestId("agent-model-load-error");
    expect(failure).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByTestId("agent-model-empty")).not.toBeInTheDocument();

    fetchModelsMock.mockResolvedValueOnce({
      models: [{ id: "workspace:text", name: "工作区文本模型", provider: "APIYI" }],
    });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("工作区文本模型")).toBeInTheDocument();
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
    expect(fetchModelsMock).toHaveBeenLastCalledWith("token-load-failure");
  });

  it("re-derives the list for the new identity instead of reusing the previous one", async () => {
    fetchModelsMock.mockImplementation(async (token?: string) =>
      token === "token-first-account"
        ? { models: [{ id: "workspace:first", name: "第一个账号的模型", provider: "APIYI" }] }
        : { models: [{ id: "workspace:second", name: "第二个账号的模型", provider: "APIYI" }] },
    );

    const { rerender } = render(<AgentModelSelector accessToken="token-first-account" />);
    await openAgentPicker();
    expect(await screen.findByText("第一个账号的模型")).toBeInTheDocument();

    rerender(<AgentModelSelector accessToken="token-second-account" />);

    expect(await screen.findByText("第二个账号的模型")).toBeInTheDocument();
    expect(screen.queryByText("第一个账号的模型")).not.toBeInTheDocument();
  });

  it("does not block sending a message when a text model is available", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [{ id: "workspace:text", name: "工作区文本模型", provider: "APIYI" }],
    });
    const onSend = vi.fn(() => ({ status: "accepted" }));
    render(<ChatInput accessToken="token-text-available" onSend={onSend} />);

    const input = screen.getByRole("textbox", { name: "输入消息" });
    fireEvent.change(input, { target: { value: "帮我画一张海报" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("帮我画一张海报"));
  });
});

describe("image model picker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchModelsMock.mockReset().mockResolvedValue({ models: [] });
    fetchImageModelsMock.mockReset().mockResolvedValue({ models: [] });
    fetchVideoModelsMock.mockReset().mockResolvedValue({ models: [] });
  });
  afterEach(() => cleanup());

  it("explains an empty workspace instead of an empty list", async () => {
    render(<ImagePickerHarness accessToken="token-image-empty" />);

    const empty = await screen.findByTestId("image-model-empty");
    expect(empty).toHaveTextContent(IMAGE_EMPTY);
  });

  it("reports a failed load as a failure with a retry", async () => {
    fetchImageModelsMock.mockRejectedValueOnce(new Error("Failed to fetch image models: 503"));
    render(<ImagePickerHarness accessToken="token-image-failure" />);

    const failure = await screen.findByTestId("image-model-load-error");
    expect(failure).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByTestId("image-model-empty")).not.toBeInTheDocument();

    fetchImageModelsMock.mockResolvedValueOnce({
      models: [
        {
          id: "workspace:image",
          displayName: "工作区图片模型",
          description: "工作区供应商计费",
          provider: "APIYI",
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("工作区图片模型")).toBeInTheDocument();
    expect(fetchImageModelsMock).toHaveBeenCalledTimes(2);
  });

  it("re-derives the image list for the new identity", async () => {
    fetchImageModelsMock.mockImplementation(async (token?: string) =>
      token === "token-first-account"
        ? {
            models: [
              { id: "workspace:first", displayName: "第一个账号的图片模型", description: "", provider: "APIYI" },
            ],
          }
        : {
            models: [
              { id: "workspace:second", displayName: "第二个账号的图片模型", description: "", provider: "APIYI" },
            ],
          },
    );

    const { rerender } = render(<ImagePickerHarness accessToken="token-first-account" />);
    expect(await screen.findByText("第一个账号的图片模型")).toBeInTheDocument();

    rerender(<ImagePickerHarness accessToken="token-second-account" />);

    expect(await screen.findByText("第二个账号的图片模型")).toBeInTheDocument();
    expect(screen.queryByText("第一个账号的图片模型")).not.toBeInTheDocument();
  });
});
