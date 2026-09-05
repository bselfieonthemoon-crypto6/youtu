import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, type LookupFunction, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type DownloadKind = "image" | "video" | "archive" | "text" | "binary";

export type SafeDownloadOptions = {
  kind: DownloadKind;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedHosts?: string[];
  allowedMimeTypes?: string[];
  expectedMimeType?: string;
  allowDataUri?: boolean;
  headers?: Record<string, string>;
};

export type SafeDownloadResult = {
  buffer: Buffer;
  mimeType: string;
  finalUrl: string;
  status: number;
  sha256: string;
};

export type SafeDownloadDependencies = {
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
};

export type SafeDownloadErrorCode =
  | "invalid_url"
  | "forbidden_host"
  | "forbidden_address"
  | "redirect_blocked"
  | "timeout"
  | "upstream_status"
  | "too_large"
  | "invalid_mime"
  | "invalid_content"
  | "network_error";

export class SafeDownloadError extends Error {
  constructor(
    public readonly code: SafeDownloadErrorCode,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "SafeDownloadError";
  }
}

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
blockedIpv6.addSubnet("2001:db8::", 32, "ipv6");
blockedIpv6.addSubnet("2002::", 16, "ipv6");

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) {
    return (
      globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6")
    );
  }
  return false;
}

export function isAllowedHostname(
  hostname: string,
  allowedHosts?: string[],
): boolean {
  if (!allowedHosts?.length) return true;
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => {
    const boundary = allowed.toLowerCase().replace(/\.$/, "");
    return normalized === boundary || normalized.endsWith(`.${boundary}`);
  });
}

export async function validateRemoteUrl(
  rawUrl: string,
  options: Pick<SafeDownloadOptions, "allowedHosts"> = {},
  resolve: (hostname: string) => Promise<string[]> = resolveHostname,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeDownloadError("invalid_url", "The download URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SafeDownloadError(
      "invalid_url",
      "Only credential-free HTTPS URLs are allowed.",
    );
  }
  if (!isAllowedHostname(url.hostname, options.allowedHosts)) {
    throw new SafeDownloadError(
      "forbidden_host",
      "The download host is not allowed.",
    );
  }

  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [url.hostname]
    : await resolve(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicNetworkAddress(address))
  ) {
    throw new SafeDownloadError(
      "forbidden_address",
      "The download host resolves to a non-public address.",
    );
  }
  return url;
}

export async function safeDownload(
  rawUrl: string,
  options: SafeDownloadOptions,
  dependencies: SafeDownloadDependencies = {},
): Promise<SafeDownloadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }
  if (rawUrl.startsWith("data:")) {
    if (!options.allowDataUri) {
      throw new SafeDownloadError(
        "invalid_url",
        "Data URLs are not allowed here.",
      );
    }
    return decodeDataUri(rawUrl, options);
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 2;
  const resolve = dependencies.resolve ?? resolveHostname;
  const injectedFetch = dependencies.fetch;
  const dispatcher = injectedFetch ? null : createSafeDispatcher(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = await validateRemoteUrl(rawUrl, options, resolve);
    for (let redirectCount = 0; ; redirectCount += 1) {
      let response: Response;
      try {
        const requestInit = {
          method: "GET",
          redirect: "manual" as const,
          signal: controller.signal,
          ...(options.headers ? { headers: options.headers } : {}),
        };
        if (injectedFetch) {
          response = await injectedFetch(current, requestInit);
        } else {
          if (!dispatcher) {
            throw new SafeDownloadError(
              "network_error",
              "The safe download dispatcher is unavailable.",
            );
          }
          response = (await undiciFetch(current, {
            ...requestInit,
            dispatcher,
          })) as unknown as Response;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SafeDownloadError("timeout", "The download timed out.");
        }
        if (error instanceof SafeDownloadError) throw error;
        throw new SafeDownloadError(
          "network_error",
          "The remote file could not be downloaded.",
        );
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirectCount >= maxRedirects) {
          throw new SafeDownloadError(
            "redirect_blocked",
            "The download redirect was rejected.",
          );
        }
        current = await validateRemoteUrl(
          new URL(location, current).toString(),
          options,
          resolve,
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SafeDownloadError(
          "upstream_status",
          `The remote server returned HTTP ${response.status}.`,
          response.status,
        );
      }

      const declaredLength = Number(
        response.headers.get("content-length") ?? 0,
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > options.maxBytes
      ) {
        await response.body?.cancel();
        throw new SafeDownloadError(
          "too_large",
          "The remote file is too large.",
        );
      }

      const headerMime = normalizeMimeType(
        response.headers.get("content-type"),
      );
      const expectedMime = normalizeMimeType(options.expectedMimeType ?? null);
      const mimeType =
        !headerMime || headerMime === "application/octet-stream"
          ? expectedMime || headerMime
          : headerMime;
      assertMimeAllowed(mimeType, options);
      let buffer: Buffer;
      try {
        buffer = await readLimitedBody(response, options.maxBytes);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SafeDownloadError("timeout", "The download timed out.");
        }
        if (error instanceof SafeDownloadError) throw error;
        throw new SafeDownloadError(
          "network_error",
          "The remote file stream could not be downloaded.",
        );
      }
      assertContentMatches(buffer, options.kind, mimeType);
      return {
        buffer,
        mimeType,
        finalUrl: current.toString(),
        status: response.status,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    }
  } finally {
    clearTimeout(timer);
    await dispatcher?.close();
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => entry.address);
  } catch {
    throw new SafeDownloadError(
      "network_error",
      "The download host could not be resolved.",
    );
  }
}

function createSafeDispatcher(timeoutMs: number): Agent {
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true })
      .then((addresses) => {
        const safe = addresses.filter((entry) =>
          isPublicNetworkAddress(entry.address),
        );
        if (safe.length !== addresses.length || safe.length === 0) {
          callback(
            new SafeDownloadError(
              "forbidden_address",
              "The download connection resolved to a non-public address.",
            ),
            "",
          );
          return;
        }
        if (options.all) {
          callback(null, safe);
          return;
        }
        const first = safe[0];
        if (!first) {
          callback(
            new SafeDownloadError(
              "forbidden_address",
              "The download connection has no public address.",
            ),
            "",
          );
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: safeLookup,
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

function decodeDataUri(
  rawUrl: string,
  options: SafeDownloadOptions,
): SafeDownloadResult {
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(rawUrl);
  if (!match)
    throw new SafeDownloadError(
      "invalid_content",
      "The data URL is malformed.",
    );
  const mimeType =
    normalizeMimeType(match[1] ?? null) || "application/octet-stream";
  assertMimeAllowed(mimeType, options);
  const encoded = match[2];
  if (!encoded) {
    throw new SafeDownloadError(
      "invalid_content",
      "The data URL is malformed.",
    );
  }
  const buffer = Buffer.from(encoded.replace(/[\r\n]/g, ""), "base64");
  if (buffer.length > options.maxBytes) {
    throw new SafeDownloadError("too_large", "The inline file is too large.");
  }
  assertContentMatches(buffer, options.kind, mimeType);
  return {
    buffer,
    mimeType,
    finalUrl: "data:",
    status: 200,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function validateDownloadedBuffer(
  buffer: Buffer,
  options: Pick<
    SafeDownloadOptions,
    "kind" | "maxBytes" | "allowedMimeTypes"
  > & {
    mimeType: string;
  },
): void {
  if (buffer.length === 0) {
    throw new SafeDownloadError(
      "invalid_content",
      "The downloaded file is empty.",
    );
  }
  if (buffer.length > options.maxBytes) {
    throw new SafeDownloadError(
      "too_large",
      "The downloaded file is too large.",
    );
  }
  const mimeType = normalizeMimeType(options.mimeType);
  assertMimeAllowed(mimeType, options);
  assertContentMatches(buffer, options.kind, mimeType);
}

function normalizeMimeType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertMimeAllowed(
  mimeType: string,
  options: SafeDownloadOptions,
): void {
  if (!mimeType)
    throw new SafeDownloadError(
      "invalid_mime",
      "The remote file has no MIME type.",
    );
  if (
    options.allowedMimeTypes?.length &&
    !options.allowedMimeTypes.includes(mimeType)
  ) {
    throw new SafeDownloadError(
      "invalid_mime",
      `The remote MIME type ${mimeType} is not allowed.`,
    );
  }
  if (options.kind === "image" && !mimeType.startsWith("image/")) {
    throw new SafeDownloadError(
      "invalid_mime",
      "The remote file is not an image.",
    );
  }
  if (options.kind === "video" && !mimeType.startsWith("video/")) {
    throw new SafeDownloadError(
      "invalid_mime",
      "The remote file is not a video.",
    );
  }
  if (
    options.kind === "text" &&
    !(mimeType.startsWith("text/") || mimeType === "application/json")
  ) {
    throw new SafeDownloadError("invalid_mime", "The remote file is not text.");
  }
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body)
    throw new SafeDownloadError("invalid_content", "The remote file is empty.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeDownloadError("too_large", "The remote file is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0)
    throw new SafeDownloadError("invalid_content", "The remote file is empty.");
  return Buffer.concat(chunks, total);
}

function assertContentMatches(
  buffer: Buffer,
  kind: DownloadKind,
  mimeType: string,
): void {
  if (kind === "image" && !looksLikeImage(buffer)) {
    throw new SafeDownloadError(
      "invalid_content",
      "The image content does not match its MIME type.",
    );
  }
  if (kind === "video" && !looksLikeVideo(buffer)) {
    throw new SafeDownloadError(
      "invalid_content",
      "The video content does not match its MIME type.",
    );
  }
  if (kind === "archive" && !looksLikeArchive(buffer, mimeType)) {
    throw new SafeDownloadError(
      "invalid_content",
      "The archive content is invalid.",
    );
  }
}

function looksLikeImage(buffer: Buffer): boolean {
  return (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
    buffer.subarray(0, 6).toString("ascii") === "GIF89a" ||
    (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP") ||
    buffer.subarray(0, 2).toString("ascii") === "BM" ||
    ["II*\u0000", "MM\u0000*"].includes(
      buffer.subarray(0, 4).toString("binary"),
    ) ||
    buffer.subarray(4, 12).toString("ascii").includes("ftypavif")
  );
}

function looksLikeVideo(buffer: Buffer): boolean {
  return (
    buffer.subarray(4, 8).toString("ascii") === "ftyp" ||
    buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  );
}

function looksLikeArchive(buffer: Buffer, mimeType: string): boolean {
  if (mimeType.includes("gzip"))
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
  return (
    buffer.length >= 512 &&
    buffer.subarray(257, 262).toString("ascii") === "ustar"
  );
}
