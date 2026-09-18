import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggedRequestPath, safeRequestLoggerOptions, serializeLoggedRequest } from "./request-logger.js";

describe("credential-safe request logging", () => {
  it.each([
    "/api/ws?token=FAKE_QUERY_SECRET&access_token=FAKE_ACCESS_SECRET&canvas=abc",
    "/api/ws?tok%65n=FAKE_ENCODED_SECRET&ACCESS_TOKEN=FAKE_UPPER_SECRET&token=FAKE_DUPLICATE_SECRET",
    "https://FAKE_USER:FAKE_PASSWORD@example.invalid/api/ws?token=FAKE_QUERY_SECRET#FAKE_FRAGMENT_SECRET",
  ])("records only the path of %s", input => {
    expect(loggedRequestPath(input)).toBe("/api/ws");
  });

  it("whitelists safe fields and does not mutate the original request", () => {
    const request = { id: "req-1", method: "GET", url: "/api/ws?access_token=FAKE_SECRET", ip: "127.0.0.1",
      headers: { authorization: "Bearer FAKE_HEADER_SECRET" }, query: { access_token: "FAKE_SECRET" },
      raw: { url: "/api/ws?token=FAKE_RAW_SECRET" }, body: { private: "FAKE_BODY_SECRET" }, routeOptions: { url: "/api/ws" } };
    const original = structuredClone(request);
    expect(serializeLoggedRequest(request)).toEqual({ id: "req-1", method: "GET", url: "/api/ws", queryRedacted: true, remoteAddress: "127.0.0.1", route: "/api/ws" });
    expect(request).toEqual(original);
    expect(JSON.stringify(serializeLoggedRequest(request))).not.toContain("FAKE_");
  });

  it("cannot throw for absent or malformed request fields", () => {
    expect(loggedRequestPath("http://[")).toBe("/[invalid-path]");
    expect(serializeLoggedRequest(null)).toEqual({ url: "/[unknown-path]" });
    expect(serializeLoggedRequest({ get url() { throw new Error("getter failed"); } })).toEqual({ url: "/[unavailable-path]" });
  });

  it("redacts real Fastify automatic, explicit and child log output without changing auth input", async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { ...safeRequestLoggerOptions(), stream: { write: (line: string) => { lines.push(line); } } } });
    app.get("/api/ws", async request => {
      expect(request.headers.authorization).toBe("Bearer FAKE_AUTH_SECRET");
      expect(request.query).toMatchObject({ token: "FAKE_QUERY_SECRET", access_token: "FAKE_ACCESS_SECRET", canvas: "canvas-123" });
      request.log.info({ req: request, request, url: request.url, headers: request.headers, query: request.query }, "safe route diagnostics");
      return { ok: true };
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/ws?tok%65n=FAKE_QUERY_SECRET&access_token=FAKE_ACCESS_SECRET&canvas=canvas-123",
        headers: { authorization: "Bearer FAKE_AUTH_SECRET", cookie: "session=FAKE_COOKIE_SECRET" } });
      expect(response.statusCode).toBe(200);
      const missing = await app.inject({ method: "GET", url: "/missing?token=FAKE_404_SECRET&access_token=FAKE_404_ACCESS" });
      expect(missing.statusCode).toBe(404);
      app.log.info({ headers: { AuThOrIzAtIoN: "FAKE_MIXED_HEADER_SECRET", "x-api-key": "FAKE_API_SECRET", "content-type": "application/json" } }, "headers check");
      app.log.child({ headers: { authorization: "FAKE_CHILD_SECRET" } }).info("child check");
      app.log.info({ diagnostic: { headers: { authorization: "FAKE_NESTED_SECRET" }, query: { token: "FAKE_NESTED_TOKEN", access_token: "FAKE_NESTED_ACCESS" } } }, "redact defense");
      const output = lines.join("");
      expect(output).not.toMatch(/FAKE_[A-Z_]+/);
      const entries = lines.flatMap(line => line.trim().split("\n").filter(Boolean).map(value => JSON.parse(value)));
      expect(entries.find(entry => entry.msg === "incoming request").req.url).toBe("/api/ws");
      expect(entries.find(entry => entry.msg === "safe route diagnostics")).toMatchObject({ req: { url: "/api/ws" }, url: "/api/ws", query: "[REDACTED_QUERY]", headers: { authorization: "[REDACTED]" } });
      expect(entries.find(entry => entry.msg === "headers check").headers).toMatchObject({ AuThOrIzAtIoN: "[REDACTED]", "x-api-key": "[REDACTED]", "content-type": "application/json" });
      expect(entries.some(entry => entry.msg === "Route GET:/missing not found")).toBe(true);
    } finally { await app.close(); }
  });
});
