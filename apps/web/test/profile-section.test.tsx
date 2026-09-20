// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileSection } from "../src/components/profile-section";

afterEach(() => cleanup());

describe("profile section", () => {
  it("shows the initial letter when there is no avatar", () => {
    render(
      <ProfileSection displayName="765966283" email="765966283@qq.com" avatarUrl={null} onSave={vi.fn()} />,
    );
    expect(screen.getByTestId("profile-avatar-placeholder")).toHaveTextContent("7");
    expect(screen.queryByTestId("profile-avatar-preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Avatar")).toHaveValue("");
  });

  it("previews a saved avatar and saves a changed one", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ProfileSection displayName="名字" email="user@example.com"
        avatarUrl="https://cdn.example/old.png" onSave={onSave} />,
    );
    expect(screen.getByTestId("profile-avatar-preview")).toHaveAttribute(
      "src", "https://cdn.example/old.png");

    await userEvent.clear(screen.getByLabelText("Avatar"));
    await userEvent.type(screen.getByLabelText("Avatar"), " https://cdn.example/new.png ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      displayName: "名字",
      avatarUrl: "https://cdn.example/new.png",
    }));
    expect(await screen.findByTestId("profile-feedback")).toHaveTextContent("Profile updated");
  });

  it("treats an empty avatar box as an explicit clear", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <ProfileSection displayName="名字" email="user@example.com"
        avatarUrl="https://cdn.example/old.png" onSave={onSave} />,
    );
    await userEvent.clear(screen.getByLabelText("Avatar"));
    // Clearing the box is a change, but clearing it twice is not.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ displayName: "名字", avatarUrl: null }));
    expect(screen.getByTestId("profile-avatar-placeholder")).toBeInTheDocument();
  });

  it("cannot save when nothing changed", () => {
    render(
      <ProfileSection displayName="名字" email="user@example.com" avatarUrl={null} onSave={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("surfaces the server's reason when saving fails", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("头像地址必须是合法链接。");
    });
    render(
      <ProfileSection displayName="名字" email="user@example.com" avatarUrl={null} onSave={onSave} />,
    );
    await userEvent.type(screen.getByLabelText("Avatar"), "https://cdn.example/a.png");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("profile-feedback")).toHaveTextContent("头像地址必须是合法链接。");
  });

  it("says that the email needs an administrator rather than pretending it is editable", () => {
    render(
      <ProfileSection displayName="名字" email="user@example.com" avatarUrl={null} onSave={vi.fn()} />,
    );
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByText(/请联系平台管理员/)).toBeInTheDocument();
  });
});
