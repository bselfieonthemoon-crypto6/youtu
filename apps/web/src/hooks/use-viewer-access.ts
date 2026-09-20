"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { dedupeRequest } from "@/lib/dedupe-request";
import { fetchAdminAccess, fetchViewer } from "@/lib/server-api";

export type WorkspaceRole = "owner" | "admin" | "member";

export interface ViewerAccess {
  /** A probe for the CURRENT identity is still in flight. */
  loading: boolean;
  /** `null` until the identity is known, or when it could not be read. */
  role: WorkspaceRole | null;
  workspaceId: string | null;
  /** `false` unless the server explicitly says this identity is an active platform admin. */
  platformAdmin: boolean;
  /** Set only when the identity itself could not be read (not when the platform probe failed). */
  loadError: string | null;
  /** Workspace owner/admin — the genuine workspace-administration surface. */
  canAdministerWorkspace: boolean;
  /** May this identity see any administration surface at all? */
  canSeeAdministration: boolean;
  refresh: () => void;
}

const IDENTITY_UNKNOWN: Pick<
  ViewerAccess,
  | "loading"
  | "role"
  | "workspaceId"
  | "platformAdmin"
  | "loadError"
  | "canAdministerWorkspace"
  | "canSeeAdministration"
> = {
  loading: true,
  role: null,
  workspaceId: null,
  platformAdmin: false,
  loadError: null,
  canAdministerWorkspace: false,
  canSeeAdministration: false,
};

type ProbeState = typeof IDENTITY_UNKNOWN & {
  /** The access token this probe state was derived from. */
  identity: string | null;
};

function stateFor(identity: string | null, overrides: Partial<ProbeState> = {}): ProbeState {
  const base: ProbeState = {
    identity,
    ...IDENTITY_UNKNOWN,
    // No token means there is nothing to wait for; the workspace layout is already
    // redirecting an unauthenticated visitor to /login.
    ...(identity ? {} : { loading: false }),
  };
  return { ...base, ...overrides };
}

function derive(state: ProbeState) {
  const canAdministerWorkspace = state.role === "owner" || state.role === "admin";
  return {
    loading: state.loading,
    role: state.role,
    workspaceId: state.workspaceId,
    platformAdmin: state.platformAdmin,
    loadError: state.loadError,
    canAdministerWorkspace,
    canSeeAdministration: state.platformAdmin || canAdministerWorkspace,
  };
}

/**
 * Who is signed in right now, and what may they administer here?
 *
 * Two things this hook refuses to do, because both were reported as defects:
 *
 * 1. It never renders a previous identity's answer. The probe state records the access
 *    token it was derived from, and a render whose token no longer matches falls back to
 *    the unknown/loading state instead of reusing the old `platformAdmin`/`role`. Without
 *    that, switching from a platform-admin account to an ordinary one kept rendering the
 *    admin console until the new probe happened to land.
 * 2. It never lets a late answer write state for a new identity. The effect cancels on
 *    cleanup, so a slow `/api/admin/access` for the old token cannot resolve after the
 *    new identity's and leave `platformAdmin: true` behind.
 *
 * Presentation only: every data route re-checks the same condition server-side.
 */
export function useViewerAccess(): ViewerAccess {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [state, setState] = useState<ProbeState>(() => stateFor(null));
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setState(stateFor(accessToken, { loading: Boolean(accessToken) }));
    if (!accessToken) return;

    let cancelled = false;
    const token = accessToken;

    void (async () => {
      let viewer: Awaited<ReturnType<typeof fetchViewer>>;
      try {
        // Shared with every other reader of the same identity on this page load.
        viewer = await dedupeRequest(`viewer:${token}`, () => fetchViewer(token));
      } catch (error) {
        if (cancelled) return;
        setState(
          stateFor(token, {
            loading: false,
            loadError:
              error instanceof Error
                ? error.message
                : "加载管理权限失败，请稍后重试。",
          }),
        );
        return;
      }
      if (cancelled) return;

      const role = viewer.membership.role as WorkspaceRole;

      // The platform role is orthogonal to the workspace role, so it is probed for every
      // identity: a platform admin who happens to be only a workspace member still gets
      // the platform console. A failed probe only hides the platform tabs; it must never
      // block the workspace administration the page already had.
      let platformAdmin = false;
      try {
        platformAdmin = (
          await dedupeRequest(`admin-access:${token}`, () =>
            fetchAdminAccess(token),
          )
        ).platformAdmin;
      } catch {
        platformAdmin = false;
      }
      if (cancelled) return;

      setState(
        stateFor(token, {
          loading: false,
          role,
          workspaceId: viewer.membership.workspaceId,
          platformAdmin,
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // The token in `state` is the guard: if it no longer matches the signed-in identity,
  // this render has no answer for that identity yet.
  const current =
    state.identity === accessToken ? state : stateFor(accessToken);

  return {
    ...derive(current),
    loading: authLoading || current.loading,
    refresh,
  };
}
