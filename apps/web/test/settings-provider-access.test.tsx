// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "../src/app/(workspace)/settings/page";

const { fetchViewerMock, fetchSettingsMock, fetchProviderMock } = vi.hoisted(() => ({
  fetchViewerMock: vi.fn(),
  fetchSettingsMock: vi.fn(),
  fetchProviderMock: vi.fn(),
}));

let requestedTab = "providers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`tab=${requestedTab}`),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "token" } }),
}));

vi.mock("../src/lib/server-api", () => ({
  ApiAuthError: class ApiAuthError extends Error {},
  fetchViewer: fetchViewerMock,
  fetchWorkspaceSettings: fetchSettingsMock,
  fetchProviderConfigs: fetchProviderMock,
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  testProviderConnection: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  updateProfile: vi.fn(),
  updateWorkspaceSettings: vi.fn(),
}));

vi.mock("../src/components/credits/credit-usage-history", () => ({ CreditUsageHistory: () => null }));
vi.mock("../src/components/billing-section", () => ({ BillingSection: () => null }));

function viewer(role: "owner" | "admin" | "member") {
  return {
    profile: { id: "user-1", displayName: "用户", email: "user@example.com" },
    workspace: { id: "workspace-1", name: "工作区", type: "personal", ownerUserId: "user-1" },
    membership: { workspaceId: "workspace-1", userId: "user-1", role },
  };
}

describe("provider settings access", () => {
  beforeEach(() => {
    requestedTab = "providers";
    fetchViewerMock.mockReset();
    fetchSettingsMock.mockReset().mockResolvedValue({ settings: { defaultModel: "model-1" } });
    fetchProviderMock.mockReset().mockResolvedValue({ configs: [] });
  });

  afterEach(() => cleanup());

  it("falls back for members and makes zero provider requests", async () => {
    fetchViewerMock.mockResolvedValue(viewer("member"));
    render(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    await waitFor(() => expect(fetchViewerMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "供应商" })).not.toBeInTheDocument();
    expect(fetchProviderMock).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("shows provider management to %s", async (role) => {
    fetchViewerMock.mockResolvedValue(viewer(role));
    render(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "模型供应商" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "供应商" })).toBeInTheDocument();
    await waitFor(() => expect(fetchProviderMock).toHaveBeenCalledWith("token"));
  });
});
