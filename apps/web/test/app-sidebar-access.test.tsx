// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reported defect: after switching to another (ordinary) account the admin console
 * was "still visible". Two separate causes are covered here - the administration nav
 * entry was an unconditional member of the nav array, rendered for every signed-in user
 * with no role probe at all, and a probe for the previous identity was allowed to decide
 * what the new identity saw.
 */

const authState: {
  session: { access_token: string } | null;
  loading: boolean;
} = { session: { access_token: "token-platform-admin" }, loading: false };

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ ...authState, user: null, signOut: vi.fn() }),
}));

// The credit widget has its own data source; it is not what this test is about.
vi.mock("../src/components/credits/credit-balance", () => ({
  CreditBalance: () => null,
}));

const { fetchViewerMock, fetchAdminAccessMock } = vi.hoisted(() => ({
  fetchViewerMock: vi.fn(),
  fetchAdminAccessMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchViewer: fetchViewerMock,
  fetchAdminAccess: fetchAdminAccessMock,
}));

import { AppSidebar, administrationNavItem } from "../src/components/app-sidebar";

function viewer(role: "owner" | "admin" | "member", workspaceId = "workspace-1") {
  return { membership: { role, workspaceId } };
}

/** Both the desktop rail and the mobile bar are in the DOM at once, so count. */
const adminEntryCount = () => screen.queryAllByLabelText("管理后台").length;
const workspaceEntryCount = () => screen.queryAllByLabelText("工作区管理").length;

describe("administration nav entry visibility", () => {
  beforeEach(() => {
    fetchViewerMock.mockReset().mockResolvedValue(viewer("member"));
    fetchAdminAccessMock.mockReset().mockResolvedValue({ platformAdmin: false });
    authState.session = { access_token: "token-member" };
    authState.loading = false;
  });
  afterEach(() => cleanup());

  it("renders no administration entry for an ordinary workspace member", async () => {
    render(<AppSidebar />);
    // Let the probe settle, then confirm the entry never appeared.
    await waitFor(() => expect(fetchViewerMock).toHaveBeenCalled());
    expect(adminEntryCount()).toBe(0);
    expect(workspaceEntryCount()).toBe(0);
  });

  it("renders the workspace entry - but not the platform console entry - for a workspace owner", async () => {
    authState.session = { access_token: "token-owner" };
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    render(<AppSidebar />);

    await waitFor(() => expect(workspaceEntryCount()).toBeGreaterThan(0));
    expect(adminEntryCount()).toBe(0);
  });

  it("renders the platform console entry for a platform admin", async () => {
    authState.session = { access_token: "token-platform-admin" };
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: true });
    render(<AppSidebar />);

    await waitFor(() => expect(adminEntryCount()).toBeGreaterThan(0));
    expect(workspaceEntryCount()).toBe(0);
    expect(fetchAdminAccessMock).toHaveBeenCalledWith("token-platform-admin");
  });

  it("fails closed: no entry at all until the server answers for this identity", () => {
    // A probe that never settles must not reveal the entry it is probing for.
    // The token is unique to this test: `dedupeRequest` keeps an unsettled promise in a
    // module-level in-flight map, so reusing a token would leak a hung call into the
    // next test rather than exercising the component.
    authState.session = { access_token: "token-pending-identity" };
    fetchViewerMock.mockImplementation(() => new Promise(() => {}));
    render(<AppSidebar />);
    expect(adminEntryCount()).toBe(0);
    expect(workspaceEntryCount()).toBe(0);
  });

  it("drops the platform console entry the moment the account switches, without waiting for the new probe", async () => {
    authState.session = { access_token: "token-platform-admin" };
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: true });
    const { rerender } = render(<AppSidebar />);
    await waitFor(() => expect(adminEntryCount()).toBeGreaterThan(0));

    // Switch to an ordinary member. The new identity's probe is deliberately slow.
    authState.session = { access_token: "token-switch-pending" };
    fetchViewerMock.mockImplementation(() => new Promise(() => {}));
    rerender(<AppSidebar />);

    expect(adminEntryCount()).toBe(0);
    expect(workspaceEntryCount()).toBe(0);
  });

  it("does not let a late platform probe from the previous account restore the entry", async () => {
    let resolveOldProbe: (value: { platformAdmin: boolean }) => void = () => {};
    authState.session = { access_token: "token-platform-admin" };
    fetchViewerMock.mockResolvedValue(viewer("owner"));
    fetchAdminAccessMock.mockImplementation(
      () => new Promise((resolve) => { resolveOldProbe = resolve; }),
    );
    const { rerender } = render(<AppSidebar />);
    await waitFor(() => expect(fetchAdminAccessMock).toHaveBeenCalledTimes(1));

    // Switch to an ordinary member. The new identity resolves immediately and is NOT a
    // platform admin; only the previous account's probe is still outstanding.
    authState.session = { access_token: "token-late-probe-member" };
    fetchViewerMock.mockResolvedValue(viewer("member"));
    fetchAdminAccessMock.mockResolvedValue({ platformAdmin: false });
    rerender(<AppSidebar />);
    await waitFor(() =>
      expect(fetchViewerMock).toHaveBeenCalledWith("token-late-probe-member"),
    );

    // The previous account's probe answers `true` only now.
    expect(adminEntryCount()).toBe(0);
    resolveOldProbe({ platformAdmin: true });
    await waitFor(() => expect(fetchViewerMock).toHaveBeenCalledTimes(2));

    expect(adminEntryCount()).toBe(0);
    expect(workspaceEntryCount()).toBe(0);
  });
});

describe("administrationNavItem", () => {
  it("labels the entry for what the identity will actually get", () => {
    expect(
      administrationNavItem({ platformAdmin: true, canAdministerWorkspace: true }),
    ).toMatchObject({ href: "/admin", label: "管理后台" });
    expect(
      administrationNavItem({ platformAdmin: false, canAdministerWorkspace: true }),
    ).toMatchObject({ href: "/admin", label: "工作区管理" });
    expect(
      administrationNavItem({ platformAdmin: false, canAdministerWorkspace: false }),
    ).toBeNull();
  });
});
