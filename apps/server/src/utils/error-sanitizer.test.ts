import { describe, expect, it, vi } from "vitest";
import { sanitizeErrorForClient, sanitizeRunErrorForClient } from "./error-sanitizer.js";

describe("provider quota failure receipt", () => {
  it("recognizes the wrapped distributor pre-consumption failure without disclosing account data", () => {
    const source = new Error("403 user [PRIVATE_ACCOUNT] quota [2107] preConsumedQuota [13923] is not enough");
    const wrapped = new Error("MiddlewareError", { cause: new Error("MiddlewareError", { cause: source }) });
    const receipt = sanitizeRunErrorForClient(wrapped);
    expect(receipt.details).toEqual({ reasonCode: "provider_quota_insufficient", automaticRetry: false });
    expect(receipt.message).toContain("额度不足");
    expect(receipt.message).toContain("对话和已有图片会保留");
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_ACCOUNT");
    expect(sanitizeErrorForClient(source)).toBe(receipt.message);
  });
  it("supports explicit insufficient_quota but does not treat ordinary rate limits as exhausted balance", () => {
    expect(sanitizeRunErrorForClient({ code: "insufficient_quota" }).details?.reasonCode)
      .toBe("provider_quota_insufficient");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(sanitizeRunErrorForClient(new Error("429 rate limit exceeded")).details).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});

describe("tool schema failure receipt", () => {
  it("explains the real wrapped Gemini failure without exposing provider data", () => {
    const cause = new Error('400 Invalid JSON payload received. Unknown name "$ref" at tools[0].function_declarations[1].parameters.properties[4].value.items: Cannot find field. secret=DO_NOT_EXPOSE');
    const receipt = sanitizeRunErrorForClient(new Error("MiddlewareError", { cause }));
    expect(receipt.details).toEqual({ reasonCode: "tool_schema_incompatible", automaticRetry: false });
    expect(receipt.message).toContain("工具参数格式");
    expect(JSON.stringify(receipt)).not.toContain("DO_NOT_EXPOSE");
    expect(sanitizeErrorForClient(cause)).toBe(receipt.message);
  });
  it("handles OpenAI function schema errors too", () => {
    expect(sanitizeRunErrorForClient(new Error("Invalid schema for function 'example': missing required"))
      .details?.reasonCode).toBe("tool_schema_incompatible");
    expect(sanitizeRunErrorForClient({ code: "provider_tool_schema_unsupported", message: "local invalid ref" })
      .details?.reasonCode).toBe("tool_schema_incompatible");
  });
  it("does not relabel unrelated errors and terminates cyclic wrappers", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error: { message: string; cause?: unknown } = { message: "plain failure" };
      error.cause = error;
      expect(sanitizeRunErrorForClient(error).details).toBeUndefined();
      expect(sanitizeRunErrorForClient("400 Invalid JSON payload received: unrelated input").details).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
