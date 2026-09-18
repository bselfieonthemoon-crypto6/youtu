import { z } from "zod";

// Keep this cross-app contract free of Node/DOM type dependencies. HTTPS links
// cannot contain userinfo, backslashes or whitespace; source allowlisting is an
// operator-controlled import concern, never a runtime URL-fetch endpoint.
const safeLink = z.string().url().max(2048).regex(
  /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?(?:[/?#][^\s\\]*)?$/i,
  "Only HTTPS source links without credentials are supported",
);

// Image previews are browser-fetched external resources, never local/private
// endpoints. Reject literal IP addresses and local-only DNS suffixes even if a
// compromised catalog attempts to insert them. No backend image proxy exists.
export const promptPreviewUrlSchema = safeLink.refine(value => {
  const host = (/^https:\/\/([^/:?#]+)/i.exec(value)?.[1]?.toLowerCase() ?? "").replace(/\.$/, "");
  return host.includes(".") && !/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|lan|home|invalid|home\.arpa)$/.test(host);
}, "Preview images require a public HTTPS hostname");

export const promptLibrarySourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  name: z.string().min(1).max(200),
  url: safeLink,
  license: z.string().min(1).max(100),
  licenseUrl: safeLink.optional(),
  attribution: z.string().max(1000),
  status: z.enum(["available", "link_only"]),
  note: z.string().max(2000),
  entryCount: z.number().int().nonnegative(),
});

export const promptLibraryEntrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  title: z.string().min(1).max(240),
  prompt: z.string().min(1).max(24000),
  category: z.string().min(1).max(80),
  tags: z.array(z.string().max(100)).max(20),
  sourceId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  sourceUrl: safeLink,
  author: z.string().max(240).optional(),
  modelHints: z.array(z.string().max(100)).max(10),
  requiresReference: z.boolean(),
  imageUrl: promptPreviewUrlSchema.optional(),
  // Gallery previews are not user-provided inputImages and must not be sent to
  // an image model automatically. Cover is first, followed by source examples.
  previewImageUrls: z.array(promptPreviewUrlSchema).max(8).optional(),
});

export const promptLibraryResponseSchema = z.object({
  version: z.string().min(1).max(100),
  items: z.array(promptLibraryEntrySchema).max(48),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  sources: z.array(promptLibrarySourceSchema).max(30),
  categories: z.array(z.string().max(80)).max(40),
});

export type PromptLibraryEntry = z.infer<typeof promptLibraryEntrySchema>;
export type PromptLibrarySource = z.infer<typeof promptLibrarySourceSchema>;
export type PromptLibraryResponse = z.infer<typeof promptLibraryResponseSchema>;
