const REDACTED = "[REDACTED]";

/** Request logs need a route, not authentication/query values. Removing the
 * entire query also covers duplicate, encoded and mixed-case credential keys. */
export function loggedRequestPath(value: unknown): string {
  if (typeof value !== "string") return "/[unknown-path]";
  try {
    const path = new URL(value, "http://request.invalid").pathname;
    return path.startsWith("/") ? path.slice(0, 4096) : "/[invalid-path]";
  } catch { return "/[invalid-path]"; }
}

function safeLoggedHeaders(value: unknown): Record<string, unknown> | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return REDACTED;
  try {
    return Object.fromEntries(Object.entries(value).map(([key, header]) => [key,
      /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key) ? REDACTED : header]));
  } catch { return REDACTED; }
}

function safeLoggedMessage(value: unknown): unknown {
  // Fastify's built-in 404 logger embeds the raw URL directly into msg instead
  // of req.url. Cover that diagnostic channel without changing request routing.
  return typeof value === "string"
    ? value.replace(/((?:https?:\/\/|\/)[^\s?<>\"]*)\?[^\s<>\"]*/g, (_match, path: string) => loggedRequestPath(path))
    : value;
}

/** Never return request.raw, headers, query, cookies, body, or arbitrary fields. */
export function serializeLoggedRequest(value: unknown) {
  try {
    const request = (value ?? {}) as { method?: unknown; url?: unknown; id?: unknown;
      ip?: unknown; socket?: { remoteAddress?: unknown; remotePort?: unknown }; routeOptions?: { url?: unknown } };
    return {
      ...(typeof request.id === "string" ? { id: request.id } : {}),
      ...(typeof request.method === "string" ? { method: request.method } : {}),
      url: loggedRequestPath(request.url),
      ...(typeof request.url === "string" && /[?#]/.test(request.url) ? { queryRedacted: true } : {}),
      ...(typeof request.routeOptions?.url === "string" ? { route: loggedRequestPath(request.routeOptions.url) } : {}),
      ...(typeof request.ip === "string" ? { remoteAddress: request.ip } : {}),
      ...(typeof request.socket?.remotePort === "number" ? { remotePort: request.socket.remotePort } : {}),
    };
  } catch { return { url: "/[unavailable-path]" }; }
}

/** This changes logging only. Authentication still receives the original URL,
 * parsed query and headers; serializers operate on copies and redact log output. */
export function safeRequestLoggerOptions() {
  return {
    level: "info",
    serializers: {
      req: serializeLoggedRequest,
      request: serializeLoggedRequest,
      url: loggedRequestPath,
      headers: safeLoggedHeaders,
      msg: safeLoggedMessage,
      // Explicit diagnostic logging of parsed query must not leak credentials.
      query: () => "[REDACTED_QUERY]",
    },
    redact: {
      censor: REDACTED,
      paths: [
        "authorization", "Authorization", "token", "access_token",
        "headers.authorization", "headers.Authorization", "headers['proxy-authorization']", "headers.cookie",
        "req.headers.authorization", "req.headers.Authorization", "request.headers.authorization", "request.headers.Authorization",
        "req.raw.headers.authorization", "request.raw.headers.authorization", "*.headers.authorization", "*.headers.Authorization",
        "query.token", "query.access_token", "req.query.token", "req.query.access_token", "request.query.token", "request.query.access_token",
        "*.query.token", "*.query.access_token",
      ],
    },
  };
}
