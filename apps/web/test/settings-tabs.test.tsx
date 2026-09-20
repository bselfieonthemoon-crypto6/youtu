// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "../src/app/(workspace)/settings/page";

const { fetchViewerMock, fetchProviderMock, fetchModelsMock, fetchSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
  fetchViewerMock: vi.fn(),
  fetchProviderMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchSettingsMock: vi.fn(),
  updateSettingsMock: vi.fn(),
}));

let requestedTab: string | null = null;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(requestedTab ? `tab=${requestedTab}` : ""),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "token" } }),
}));

vi.mock("../src/lib/server-api", () => ({
  ApiAuthError: class ApiAuthError extends Error {},
  fetchViewer: fetchViewerMock,
  fetchProviderConfigs: fetchProviderMock,
  fetchModels: fetchModelsMock,
  fetchWorkspaceSettings: fetchSettingsMock,
  updateWorkspaceSettings: updateSettingsMock,
  updateProfile: vi.fn(async (_token: string, input: { displayName: string }) => ({
    profile: { displayName: input.displayName, email: "user@example.com" },
  })),
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

describe("settings tabs", () => {
  beforeEach(() => {
    requestedTab = null;
    fetchViewerMock.mockReset().mockResolvedValue(viewer("owner"));
    fetchProviderMock.mockReset().mockResolvedValue({ configs: [] });
    fetchModelsMock.mockReset().mockResolvedValue({ models: [] });
    fetchSettingsMock.mockReset().mockResolvedValue({ settings: { defaultModel: "model-1" } });
    updateSettingsMock.mockReset();
  });

  afterEach(() => cleanup());

  it.each(["owner", "admin", "member"] as const)(
    "offers only Profile, Billing and Usage to %s",
    async (role) => {
      fetchViewerMock.mockResolvedValue(viewer(role));
      render(<SettingsPage />);
      expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Billing" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
      // Both tabs moved to the platform side and must not come back by accident.
      expect(screen.queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "供应商" })).not.toBeInTheDocument();
    },
  );

  it.each(["agent", "providers"])(
    "falls back to Profile for the removed %s deep link",
    async (tab) => {
      requestedTab = tab;
      render(<SettingsPage />);
      expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "供应商" })).not.toBeInTheDocument();
    },
  );

  it("keeps a known deep link working", async () => {
    requestedTab = "usage";
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Usage" })).toHaveClass("bg-card"),
    );
  });

  it("reads no provider catalogue, provider configs or workspace settings", async () => {
    // The page owns none of that configuration any more, so it must not ask for it.
    render(<SettingsPage />);
    await screen.findByRole("heading", { name: "Profile" });
    expect(fetchViewerMock).toHaveBeenCalledWith("token");
    expect(fetchProviderMock).not.toHaveBeenCalled();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(fetchSettingsMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
