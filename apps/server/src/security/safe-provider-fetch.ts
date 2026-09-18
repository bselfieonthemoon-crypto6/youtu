import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

import { isPublicNetworkAddress } from "./safe-download.js";

const CONNECT_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 10 * 60_000;

export class SafeProviderUrlError extends Error {
  constructor(message = "Provider URL is not a public HTTPS endpoint.") {
    super(message);
    this.name = "SafeProviderUrlError";
  }
}

/**
 * Canonicalize the administrator-supplied base URL without resolving DNS.
 * DNS is deliberately checked again by the connection-level lookup below so
 * a host cannot pass validation and then rebind to loopback/link-local/private
 * infrastructure before the paid model request connects.
 */
export function normalizePublicProviderBaseUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 500) throw new Error();
    const url = new URL(value.trim());
    const hostname = unbracket(url.hostname).toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      (isIP(hostname) !== 0 && !isPublicNetworkAddress(hostname))
    ) throw new Error();
    url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new SafeProviderUrlError();
  }
}

export type SafeProviderFetchDependencies = {
  /** Unit-test seam. Production callers must leave this undefined. */
  fetch?: typeof fetch;
  /** Unit-test seam for deterministic DNS validation. */
  resolve?: (hostname: string) => Promise<string[]>;
};

/**
 * Build an origin- and path-confined fetch implementation for an
 * OpenAI-compatible provider. Redirects are always disabled. In production,
 * the custom Undici dispatcher validates every DNS lookup used to establish a
 * connection, closing the DNS-rebinding/connection TOCTOU gap.
 */
export function createSafeProviderFetch(
  rawBaseUrl: string,
  dependencies: SafeProviderFetchDependencies = {},
): typeof fetch {
  const baseUrl = new URL(normalizePublicProviderBaseUrl(rawBaseUrl));
  const basePath = baseUrl.pathname.replace(/\/+$/, "") || "/";
  const injectedFetch = dependencies.fetch;
  const dispatcher = injectedFetch ? undefined : providerDispatcher;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = requestUrl(input);
    assertConfinedTarget(target, baseUrl, basePath);
    await assertPublicResolution(target.hostname, dependencies.resolve);
    // Convert a global Request to URL + RequestInit explicitly. The package's
    // Undici Request class is not guaranteed to share identity with Node's
    // global Request, and passing it through directly can stringify to
    // "[object Request]". Copy the security- and payload-relevant fields,
    // including the streaming body and abort signal.
    const inherited = input instanceof Request ? requestInitFromRequest(input) : {};
    // "manual" exposes a 3xx to the caller for stable error classification but
    // never follows Location or forwards the Authorization header elsewhere.
    let requestInit = { ...inherited, ...init, redirect: "manual" as const };
    // Node's global FormData and the installed Undici FormData have different
    // brands. Passing the former directly to package fetch serializes it as
    // "[object FormData]". Encode with its owning Request first, then bridge
    // the exact multipart bytes and generated boundary as a stream.
    if (requestInit.body instanceof FormData) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-type");
      const encoded = new Request(target, { ...requestInit, headers });
      requestInit = { ...requestInit, ...requestInitFromRequest(encoded), redirect: "manual" as const };
    }
    if (injectedFetch) return injectedFetch(target, requestInit);
    return undiciFetch(target, {
      ...requestInit,
      dispatcher,
    } as never) as unknown as Promise<Response>;
  }) as typeof fetch;
}

function requestInitFromRequest(request: Request): RequestInit & { duplex?: "half" } {
  const carriesBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  return {
    method: request.method,
    headers: request.headers,
    ...(carriesBody ? { body: request.body, duplex: "half" as const } : {}),
    signal: request.signal,
  };
}

function requestUrl(input: string | URL | Request): URL {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    throw new SafeProviderUrlError("Provider request URL is invalid.");
  }
}

function assertConfinedTarget(target: URL, base: URL, basePath: string): void {
  const pathAllowed = basePath === "/" ||
    target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  if (
    target.protocol !== "https:" ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    !pathAllowed
  ) {
    throw new SafeProviderUrlError("Provider request escaped its configured base URL.");
  }
}

async function assertPublicResolution(
  rawHostname: string,
  resolve: ((hostname: string) => Promise<string[]>) | undefined,
): Promise<void> {
  const hostname = unbracket(rawHostname);
  const addresses = isIP(hostname) !== 0
    ? [hostname]
    : await (resolve ?? resolveHostname)(hostname);
  if (addresses.length === 0 || addresses.some(address => !isPublicNetworkAddress(address))) {
    throw new SafeProviderUrlError();
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.map(address => address.address);
  } catch {
    throw new SafeProviderUrlError("Provider host could not be resolved.");
  }
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true })
    .then(addresses => {
      if (addresses.length === 0 || addresses.some(address => !isPublicNetworkAddress(address.address))) {
        callback(new SafeProviderUrlError(), "");
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      if (!first) {
        callback(new SafeProviderUrlError(), "");
        return;
      }
      callback(null, first.address, first.family);
    })
    .catch((error: NodeJS.ErrnoException) => callback(error, ""));
};

const providerDispatcher = new Agent({
  connect: { timeout: CONNECT_TIMEOUT_MS, lookup: safeLookup },
  headersTimeout: BODY_TIMEOUT_MS,
  bodyTimeout: BODY_TIMEOUT_MS,
});
