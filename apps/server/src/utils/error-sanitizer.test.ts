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

describe("transient upstream failure receipt", () => {
  it("explains the observed empty-bodied gateway 502 instead of the generic retry text", () => {
    const gatewayBody = JSON.stringify({
      error: { message: "", type: "shell_api_error", param: "502", code: "bad_response_status_code" },
    });
    const receipt = sanitizeRunErrorForClient(new Error(gatewayBody));
    expect(receipt).toEqual({
      code: "run_failed",
      message: expect.stringContaining("模型服务暂时不可用"),
      details: { reasonCode: "provider_unavailable", automaticRetry: false },
    });
    // The two facts the empty body hid: it retried, and nothing was submitted.
    expect(receipt.message).toContain("自动重试");
    expect(receipt.message).toContain("没有提交任何生成任务");
    expect(receipt.message).toContain("502");
    expect(sanitizeErrorForClient(new Error(gatewayBody))).toBe(receipt.message);
  });

  it("reads the status from structured fields, nested data, and a response body", () => {
    expect(sanitizeRunErrorForClient({ statusCode: 502, message: "upstream down" }).details?.reasonCode)
      .toBe("provider_unavailable");
    expect(sanitizeRunErrorForClient({ status: 503, message: "unavailable" }).details?.reasonCode)
      .toBe("provider_unavailable");
    expect(sanitizeRunErrorForClient({ data: { statusCode: 504 }, message: "timeout" }).details?.reasonCode)
      .toBe("provider_unavailable");
    expect(sanitizeRunErrorForClient(new Error('upstream said {"status":500}')).details?.reasonCode)
      .toBe("provider_unavailable");
  });

  it("walks the cause chain and classifies 429 as rate limiting with its own wording", () => {
    const wrapped = new Error("MiddlewareError", {
      cause: new Error("MiddlewareError", { cause: { statusCode: 429, message: "too many requests" } }),
    });
    const receipt = sanitizeRunErrorForClient(wrapped);
    expect(receipt.details).toEqual({ reasonCode: "provider_rate_limited", automaticRetry: false });
    expect(receipt.message).toContain("429");
    expect(receipt.message).toContain("稍等");
    expect(receipt.message).toContain("不会产生扣费");
  });

  it("keeps the quota receipt ahead of a transient status so exhausted balance is not read as a hiccup", () => {
    expect(sanitizeRunErrorForClient({ code: "insufficient_quota", statusCode: 429 }).details?.reasonCode)
      .toBe("provider_quota_insufficient");
  });

  it("leaves client errors and prose numbers alone", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(sanitizeRunErrorForClient({ statusCode: 400, message: "bad request" }).details).toBeUndefined();
      expect(sanitizeRunErrorForClient({ statusCode: 404, message: "not found" }).details).toBeUndefined();
      // A bare number in prose must not be mistaken for a gateway status.
      expect(sanitizeRunErrorForClient(new Error("processed 500 records")).details).toBeUndefined();
      expect(sanitizeRunErrorForClient(new Error("retrying 429 times")).details).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
