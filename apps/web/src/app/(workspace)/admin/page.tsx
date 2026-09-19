"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DesignResourceAdminSection } from "@/components/settings/design-resource-admin-section";
import { ProviderSettingsSection } from "@/components/settings/provider-settings-section";
import { WorkspaceMembersSection } from "@/components/settings/workspace-members-section";
import { AdminOverviewSection } from "@/components/admin/admin-overview-section";
import { useAuth } from "@/lib/auth-context";
import { fetchAdminAccess, fetchViewer } from "@/lib/server-api";

type AdminTab = "overview" | "users" | "providers" | "resources";

export default function AdminPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [tab, setTab] = useState<AdminTab>("users");
  const [role, setRole] = useState<"owner" | "admin" | "member" | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // Platform administration is a separate role from workspace administration:
  // the overview tab is offered only when the server says this user is an active
  // platform admin. It is presentation only — the data route re-checks.
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAccess = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setLoadError("无法获取登录凭据，请重新登录后再试。");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const viewer = await fetchViewer(accessToken);
      setRole(viewer.membership.role);
      setWorkspaceId(viewer.membership.workspaceId);
    } catch (error) {
      setRole(null);
      setWorkspaceId(null);
      setLoadError(
        error instanceof Error
          ? error.message
          : "加载管理权限失败，请稍后重试。",
      );
      return;
    } finally {
      setLoading(false);
    }
    // A failed probe only hides the tab; it must never block the workspace
    // administration this page already had.
    try {
      setPlatformAdmin((await fetchAdminAccess(accessToken)).platformAdmin);
    } catch {
      setPlatformAdmin(false);
    }
  }, [accessToken]);

  useEffect(() => void loadAccess(), [loadAccess]);

  if (loading)
    return (
      <div className="p-8 text-sm text-muted-foreground">正在加载管理后台…</div>
    );
  if (loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">管理后台加载失败</h1>
        <p className="mt-2 text-sm text-destructive">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadAccess()}
          className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          重试
        </button>
      </div>
    );
  }
  if (role !== "owner" && role !== "admin") {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">无权访问管理后台</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          只有工作区所有者或管理员可以进入。
        </p>
        <Link
          href="/home"
          className="mt-5 inline-flex rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          返回首页
        </Link>
      </div>
    );
  }

  const authenticatedToken = accessToken ?? "";
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:p-8">
      <div className="mb-7">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Workspace administration
        </p>
        <h1 className="mt-1 text-2xl font-semibold">管理后台</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          统一管理工作区用户、第三方模型供应商与设计资源。
        </p>
      </div>
      <div className="mb-7 inline-flex rounded-lg bg-muted p-1">
        {(
          [
            ...(platformAdmin ? ([["overview", "平台总览"]] as const) : []),
            ["users", "用户管理"],
            ["providers", "第三方模型供应商"],
            ["resources", "设计资源"],
          ] as ReadonlyArray<readonly [AdminTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-4 py-2 text-sm ${tab === id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={tab === "overview" && platformAdmin ? "w-full" : "max-w-3xl"}>
        {tab === "overview" && platformAdmin ? (
          <AdminOverviewSection accessToken={authenticatedToken} />
        ) : tab === "users" ? (
          <WorkspaceMembersSection
            accessToken={authenticatedToken}
            viewerRole={role}
          />
        ) : tab === "providers" ? (
          <ProviderSettingsSection accessToken={authenticatedToken} />
        ) : (
          <DesignResourceAdminSection
            accessToken={authenticatedToken}
            workspaceId={workspaceId ?? ""}
            directoryImportEnabled={
              process.env.NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED ===
              "true"
            }
          />
        )}
      </div>
    </div>
  );
}
