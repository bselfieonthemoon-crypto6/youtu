import { describe, expect, it } from "vitest";

import { isAllowedWebOrigin } from "./app.js";

describe("isAllowedWebOrigin", () => {
  it("accepts the configured origin", () => {
    expect(
      isAllowedWebOrigin(
        "https://app.loomic.example",
        "https://app.loomic.example",
      ),
    ).toBe(true);
  });

  it("accepts localhost and 127.0.0.1 aliases on the configured port", () => {
    expect(
      isAllowedWebOrigin("http://127.0.0.1:3002", "http://localhost:3002"),
    ).toBe(true);
  });

  it("rejects a loopback origin on another port", () => {
    expect(
      isAllowedWebOrigin("http://127.0.0.1:3003", "http://localhost:3002"),
    ).toBe(false);
  });

  it("rejects unrelated origins", () => {
    expect(
      isAllowedWebOrigin(
        "https://attacker.example",
        "https://app.loomic.example",
      ),
    ).toBe(false);
  });
});
