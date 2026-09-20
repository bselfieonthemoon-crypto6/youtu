"use client";

import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/lib/auth-context";
import { dedupeRequest } from "@/lib/dedupe-request";
import { fetchProfile } from "@/lib/server-api";

/**
 * The signed-in user's profile (display name and avatar) from our own API.
 *
 * The header used to read `user_metadata.full_name` / `user_metadata.avatar_url` from
 * the Supabase session, while the settings page writes `profiles.display_name` and
 * `profiles.avatar_url` - two sources for one thing, so editing your name changed
 * nothing visible and the avatar field was never read at all. This hook makes the
 * profile API the source, and keeps the auth metadata as a fallback for accounts that
 * were provisioned with it (for example through an external identity provider).
 *
 * It reads `/api/viewer/profile` rather than `/api/viewer` on purpose: the latter
 * bootstraps the workspace and auto-claims daily credits, which the header should not
 * trigger on every page just to render a name.
 */
export type ViewerProfileSummary = {
  displayName: string;
  avatarUrl: string | null;
};

export function useViewerProfile(): ViewerProfileSummary | null {
  const { session } = useAuth();
  const token = session?.access_token;
  const [profile, setProfile] = useState<ViewerProfileSummary | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!token) {
      setProfile(null);
      loadedFor.current = null;
      return;
    }
    if (loadedFor.current === token) return;
    let cancelled = false;
    void (async () => {
      try {
        // Shared with other readers of the same profile on this page load.
        const result = await dedupeRequest(`profile:${token}`, () => fetchProfile(token));
        if (cancelled) return;
        loadedFor.current = token;
        setProfile({
          displayName: result.profile.displayName,
          avatarUrl: result.profile.avatarUrl ?? null,
        });
      } catch {
        // The header falls back to the session metadata; never block the UI on this.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return profile;
}
