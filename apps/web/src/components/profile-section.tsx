"use client";

import { useState } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ProfileSectionProps {
  displayName: string;
  email: string;
  avatarUrl: string | null;
  onSave: (input: { displayName: string; avatarUrl: string | null }) => Promise<void>;
}

/**
 * The signed-in user's own identity.
 *
 * The avatar is a plain link, not an upload: uploaded images live in a private bucket
 * behind 15-minute signed URLs, so a stored copy would rot. A link keeps working until
 * the user changes it, and the header reads the same field.
 */
export function ProfileSection({
  displayName: initialName,
  email,
  avatarUrl: initialAvatar,
  onSave,
}: ProfileSectionProps) {
  const [displayName, setDisplayName] = useState(initialName);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatar ?? "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const trimmedAvatar = avatarUrl.trim();
  const hasChanges =
    displayName.trim() !== initialName || trimmedAvatar !== (initialAvatar ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) return;

    setSaving(true);
    setFeedback(null);

    try {
      await onSave({
        displayName: trimmed,
        // An empty box means "no avatar", which is an explicit clear.
        avatarUrl: trimmedAvatar || null,
      });
      setFeedback({ type: "success", message: "Profile updated." });
    } catch (caught) {
      setFeedback({
        type: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "Failed to update profile. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Profile</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Manage your personal information.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="avatarUrl">Avatar</Label>
          <div className="flex items-center gap-3">
            {trimmedAvatar ? (
              <img
                src={trimmedAvatar}
                alt="Avatar preview"
                data-testid="profile-avatar-preview"
                className="h-12 w-12 rounded-full border border-border object-cover"
              />
            ) : (
              <div
                data-testid="profile-avatar-placeholder"
                className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted text-sm font-medium text-muted-foreground"
              >
                {(displayName.trim() || email).charAt(0).toUpperCase()}
              </div>
            )}
            <Input
              id="avatarUrl"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            填一个图片链接作为头像；留空即取消头像。
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="displayName">Display Name</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={email} disabled className="opacity-60" />
          <p className="text-xs text-muted-foreground">
            Email cannot be changed. 如需更换登录邮箱，请联系平台管理员。
          </p>
        </div>

        {feedback && (
          <p
            data-testid="profile-feedback"
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}
