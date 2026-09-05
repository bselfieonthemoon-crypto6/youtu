import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl, loadWebEnv } from "../src/lib/env";

describe("@loomic/web env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the browser-safe Supabase env and explicit server base url", () => {
    const env = loadWebEnv({
      serverBaseUrl: "http://localhost:4010",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    });

    expect(env).toEqual({
      serverBaseUrl: "http://localhost:4010",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    });
  });

  it("rejects missing browser-safe Supabase env values", () => {
    expect(() =>
      loadWebEnv({ supabaseUrl: "https://example.supabase.co" }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("keeps getServerBaseUrl compatible with the default fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(getServerBaseUrl()).toBe("http://localhost:3001");
  });

  it("reads getServerBaseUrl from process env when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4020");

    expect(getServerBaseUrl()).toBe("http://localhost:4020");
  });
});
