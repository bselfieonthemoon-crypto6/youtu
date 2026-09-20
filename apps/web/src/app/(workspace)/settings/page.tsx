"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { BillingSection } from "@/components/billing-section";
import { CreditUsageHistory } from "@/components/credits/credit-usage-history";
import { ProfileSection } from "@/components/profile-section";
import { SettingsSkeleton } from "@/components/skeletons/settings-skeleton";
import { useAuth } from "@/lib/auth-context";
import { ApiAuthError, fetchViewer, updateProfile } from "@/lib/server-api";

/**
 * Workspace settings for the signed-in user.
 *
 * There is deliberately no "Agent" (default model) or "供应商" (model provider) tab
 * here: both are configured on the platform side, and letting a workspace pick its own
 * default model or manage its own channels duplicated that. The provider console still
 * lives in the admin page (`/admin → 模型与渠道`), which owns those endpoints - the APIs
 * themselves are unchanged.
 *
 * A deep link to a tab that no longer exists (`?tab=agent`, `?tab=providers`) falls
 * back to Profile rather than rendering an empty panel, so old bookmarks and links
 * keep working.
 */

type SettingsTab = "profile" | "billing" | "usage";

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "billing", label: "Billing" },
  { id: "usage", label: "Usage" },
];

const isSettingsTab = (value: string | null): value is SettingsTab =>
  tabs.some((tab) => tab.id === value);

export default function SettingsPage() {
  const { session } = useAuth();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const requested = searchParams.get("tab");
    return isSettingsTab(requested) ? requested : "profile";
  });
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
    avatarUrl: string | null;
  } | null>(null);
  const [pageLoading, setPageLoading] = useState(true);

  // Ref pattern: prevent token refresh from cascading through dependency arrays
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const hasInitialized = useRef(false);

  const getToken = useCallback(() => accessTokenRef.current, []);

  const loadData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setPageLoading(true);

    try {
      const viewer = await fetchViewer(token);
      setProfile({
        displayName: viewer.profile.displayName,
        email: viewer.profile.email,
        avatarUrl: viewer.profile.avatarUrl ?? null,
      });
    } catch (err) {
      if (err instanceof ApiAuthError) {
        // Workspace layout handles auth redirect
        return;
      }
    } finally {
      setPageLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (hasInitialized.current) return;
    if (!session?.access_token) return;
    hasInitialized.current = true;
    loadData();
  }, [session?.access_token, loadData]);

  const handleProfileSave = useCallback(
    async (input: { displayName: string; avatarUrl: string | null }) => {
      const token = getToken();
      if (!token) return;
      const result = await updateProfile(token, {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      });
      setProfile({
        displayName: result.profile.displayName,
        email: result.profile.email,
        avatarUrl: result.profile.avatarUrl ?? null,
      });
    },
    [getToken],
  );

  if (pageLoading) {
    return <SettingsSkeleton />;
  }

  if (!profile) return null;

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8">
      <h1 className="mb-4 text-base font-semibold sm:mb-6 sm:text-lg">
        Settings
      </h1>

      {/* Tab bar -- scrollable on small screens, 44px min touch target */}
      <div className="mb-6 overflow-x-auto sm:mb-8">
        <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[44px] whitespace-nowrap rounded-md px-4 py-1.5 text-sm transition-colors sm:min-h-0 sm:px-3 ${
                activeTab === tab.id
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-xl">
        {activeTab === "profile" ? (
          <ProfileSection
            displayName={profile.displayName}
            email={profile.email}
            avatarUrl={profile.avatarUrl}
            onSave={handleProfileSave}
          />
        ) : activeTab === "usage" ? (
          <CreditUsageHistory />
        ) : (
          <BillingSection />
        )}
      </div>
    </div>
  );
}
