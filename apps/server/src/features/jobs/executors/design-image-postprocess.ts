import type { ImageForegroundPolicy } from "@loomic/shared";
import { validateTransparentPng } from "../../images/api-background-removal.js";

/** Foreground processing is quoted in advance; never silently fall back to local matting. */
export async function postprocessDesignImage(
  buffer: Buffer,
  mimeType: string,
  target?: { kind: string; placement?: { role?: string | undefined; x?: number | undefined } | undefined } | null,
  options?: { policy: ImageForegroundPolicy; removeBackground: () => Promise<Buffer> },
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (target?.kind !== "design" || target.placement?.role === "background") return { buffer, mimeType };
  if (!options?.policy) throw Object.assign(new Error("透明前景处理尚未确认，未追加抠图调用。"), { code: "foreground_policy_required" });
  const result = options.policy.mode === "native_transparent" ? buffer : await options.removeBackground();
  await validateTransparentPng(result);
  return { buffer: result, mimeType: "image/png" };
}
