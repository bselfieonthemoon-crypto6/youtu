"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentExecutionMode, ImageGenerationPreference, VideoGenerationPreference } from "@loomic/shared";

import type { ReadyAttachment } from "@/hooks/use-image-attachments";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/components/toast";
import { ApiAuthError, createProject } from "@/lib/server-api";

/** sessionStorage key used to pass attachments from Home → Canvas auto-send. */
export const INITIAL_ATTACHMENTS_KEY = "loomic:initial-attachments";
export const INITIAL_IMAGE_GENERATION_PREFERENCE_KEY =
  "loomic:initial-image-generation-preference";
export const INITIAL_VIDEO_GENERATION_PREFERENCE_KEY =
  "loomic:initial-video-generation-preference";
export const INITIAL_AGENT_MODEL_KEY = "loomic:initial-agent-model";
export const INITIAL_EXECUTION_MODE_KEY = "loomic:initial-execution-mode";

/**
 * Shared hook for creating an Untitled project and navigating to its canvas.
 * Used by Home page, Projects page, and Canvas logo menu.
 */
export function useCreateProject() {
  const { session, signOut } = useAuth();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [creating, setCreating] = useState(false);

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const routerRef = useRef(router);
  routerRef.current = router;

  const create = useCallback(
    async (opts?: {
      prompt?: string;
      attachments?: ReadyAttachment[];
      imageGenerationPreference?: ImageGenerationPreference;
      videoGenerationPreference?: VideoGenerationPreference;
      model?: string;
      executionMode?: AgentExecutionMode;
    }) => {
      const token = session?.access_token;
      if (!token || creating) return;

      // Persist the initial run payload before navigating to the canvas.
      if (opts?.attachments && opts.attachments.length > 0) {
        try {
          sessionStorage.setItem(
            INITIAL_ATTACHMENTS_KEY,
            JSON.stringify(opts.attachments),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      if (opts?.imageGenerationPreference) {
        try {
          sessionStorage.setItem(
            INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
            JSON.stringify(opts.imageGenerationPreference),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      if (opts?.videoGenerationPreference) {
        try {
          sessionStorage.setItem(
            INITIAL_VIDEO_GENERATION_PREFERENCE_KEY,
            JSON.stringify(opts.videoGenerationPreference),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_VIDEO_GENERATION_PREFERENCE_KEY);
      }

      if (opts?.model) {
        try {
          sessionStorage.setItem(INITIAL_AGENT_MODEL_KEY, opts.model);
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }

      if (opts?.executionMode) {
        try {
          sessionStorage.setItem(
            INITIAL_EXECUTION_MODE_KEY,
            opts.executionMode,
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_EXECUTION_MODE_KEY);
      }

      setCreating(true);
      try {
        const result = await createProject(token, { name: "Untitled" });
        const canvasId = result.project.primaryCanvas.id;

        const url = opts?.prompt
          ? `/canvas?id=${canvasId}&prompt=${encodeURIComponent(opts.prompt)}`
          : `/canvas?id=${canvasId}`;

        // Keep project creation and canvas navigation in the same tab. Opening
        // a placeholder tab before this request is unreliable in embedded
        // browsers: the async handoff can lose its WindowProxy and leave an
        // unreachable blank tab, especially during the first dev compilation.
        routerRef.current.push(url);
        setCreating(false);
      } catch (err) {
        if (err instanceof ApiAuthError) {
          await signOutRef.current();
          routerRef.current.replace("/login");
          return;
        }
        toastError("项目创建失败");
        setCreating(false);
      }
    },
    [session?.access_token, creating, toastError],
  );

  return { create, creating };
}
