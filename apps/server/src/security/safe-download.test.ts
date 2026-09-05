import { describe, expect, it, vi } from "vitest";
import {
  SafeDownloadError,
  isAllowedHostname,
  isPublicNetworkAddress,
  safeDownload,
  validateRemoteUrl,
} from "./safe-download.js";

const publicResolver = async () => ["93.184.216.34"];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

describe("safe download network boundary", () => {
  it("rejects non-HTTPS, credentials, private literals and mixed DNS answers", async () => {
    await expect(
      validateRemoteUrl("http://example.com/a", {}, publicResolver),
    ).rejects.toMatchObject({
      code: "invalid_url",
    });
    await expect(
      validateRemoteUrl("https://user:pass@example.com/a", {}, publicResolver),
    ).rejects.toMatchObject({
      code: "invalid_url",
    });
    await expect(
      validateRemoteUrl("https://127.0.0.1/a"),
    ).rejects.toMatchObject({
      code: "forbidden_address",
    });
    await expect(
      validateRemoteUrl("https://mixed.example/a", {}, async () => [
        "93.184.216.34",
        "10.0.0.2",
      ]),
    ).rejects.toMatchObject({ code: "forbidden_address" });
  });

  it("recognizes reserved IPv4 and IPv6 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicNetworkAddress(address), address).toBe(false);
    }
    expect(isPublicNetworkAddress("93.184.216.34")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("uses exact hostname boundaries", () => {
    expect(
      isAllowedHostname("replicate.delivery", ["replicate.delivery"]),
    ).toBe(true);
    expect(
      isAllowedHostname("cdn.replicate.delivery", ["replicate.delivery"]),
    ).toBe(true);
    expect(
      isAllowedHostname("evilreplicate.delivery", ["replicate.delivery"]),
    ).toBe(false);
  });

  it("downloads a valid raster image with a bounded body", async () => {
    const result = await safeDownload(
      "https://cdn.example/image.png",
      { kind: "image", maxBytes: 1024, allowedMimeTypes: ["image/png"] },
      {
        resolve: publicResolver,
        fetch: vi.fn(
          async () =>
            new Response(png, {
              status: 200,
              headers: { "content-type": "image/png" },
            }),
        ),
      },
    );
    expect(result.buffer).toEqual(png);
    expect(result.mimeType).toBe("image/png");
  });

  it("rejects an oversized chunked body and forged media content", async () => {
    await expect(
      safeDownload(
        "https://cdn.example/large.png",
        { kind: "image", maxBytes: 8 },
        {
          resolve: publicResolver,
          fetch: async () =>
            new Response(Buffer.alloc(9), {
              headers: { "content-type": "image/png" },
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "too_large" });

    await expect(
      safeDownload(
        "https://cdn.example/fake.png",
        { kind: "image", maxBytes: 1024 },
        {
          resolve: publicResolver,
          fetch: async () =>
            new Response("<html>not an image</html>", {
              headers: { "content-type": "image/png" },
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_content" });
  });

  it("enforces the same deadline while reading a stalled response body", async () => {
    await expect(
      safeDownload(
        "https://cdn.example/stalled.bin",
        { kind: "binary", maxBytes: 1024, timeoutMs: 10 },
        {
          resolve: publicResolver,
          fetch: async (_url, init) => {
            const signal = init?.signal;
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal?.addEventListener("abort", () => {
                    controller.error(new DOMException("aborted", "AbortError"));
                  });
                },
              }),
              { headers: { "content-type": "application/octet-stream" } },
            );
          },
        },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("revalidates every redirect and blocks a redirect to private DNS", async () => {
    await expect(
      safeDownload(
        "https://public.example/start",
        { kind: "image", maxBytes: 1024, maxRedirects: 2 },
        {
          resolve: async (hostname) =>
            hostname === "internal.example" ? ["127.0.0.1"] : ["93.184.216.34"],
          fetch: async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://internal.example/secret" },
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden_address" });
  });

  it("limits data URLs and validates their magic bytes", async () => {
    const valid = `data:image/png;base64,${png.toString("base64")}`;
    await expect(
      safeDownload(valid, {
        kind: "image",
        maxBytes: 1024,
        allowDataUri: true,
      }),
    ).resolves.toMatchObject({ mimeType: "image/png", finalUrl: "data:" });

    const error = await safeDownload(valid, {
      kind: "image",
      maxBytes: 2,
      allowDataUri: true,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SafeDownloadError);
    expect(error.code).toBe("too_large");
  });
});
