import type { FastifyInstance } from "fastify";
import { SafeDownloadError, safeDownload } from "../security/safe-download.js";

/**
 * Proxy endpoint for fetching external images server-side, bypassing browser CORS restrictions.
 * Used by the frontend to load generated images into Excalidraw canvas.
 */
export function registerImageProxyRoute(app: FastifyInstance) {
  // Build allowed domains list: static CDNs + dynamic Supabase host
  const staticAllowed = [
    "replicate.delivery",
    "replicate.com",
    "pbxt.replicate.delivery",
    "supabase.co",
  ];

  const supabaseUrl = process.env.SUPABASE_URL;
  const dynamicAllowed = supabaseUrl
    ? (() => {
        try {
          return [new URL(supabaseUrl).hostname];
        } catch {
          return [];
        }
      })()
    : [];

  const allowed = [...staticAllowed, ...dynamicAllowed];

  app.get<{
    Querystring: { url: string };
  }>("/api/proxy-image", async (request, reply) => {
    const { url } = request.query;

    if (!url || typeof url !== "string") {
      return reply.status(400).send({ error: "Missing url parameter" });
    }

    try {
      const downloaded = await safeDownload(url, {
        kind: "image",
        maxBytes: 20 * 1024 * 1024,
        timeoutMs: 10_000,
        maxRedirects: 0,
        allowedHosts: allowed,
        allowedMimeTypes: [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/avif",
          "image/bmp",
          "image/tiff",
        ],
      });

      return reply
        .header("content-type", downloaded.mimeType)
        .header("cache-control", "public, max-age=86400")
        .send(downloaded.buffer);
    } catch (error) {
      if (error instanceof SafeDownloadError) {
        const status =
          error.code === "invalid_url" ? 400
            : error.code === "forbidden_host" || error.code === "forbidden_address" ? 403
              : error.code === "too_large" ? 413
                : error.code === "invalid_mime" || error.code === "invalid_content" ? 415
                  : error.code === "timeout" ? 504
                    : 502;
        return reply.status(status).send({ error: error.code });
      }
      return reply.status(502).send({ error: "Failed to fetch image" });
    }
  });
}
