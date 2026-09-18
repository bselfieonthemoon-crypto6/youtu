import { describe, expect, it } from "vitest";
import { standardSchemaToJSONSchema } from "@mastra/core/schema";
import { assertContextBudget, createContextBudget, estimateContextTokens, resolveContextModelProfile, resolveContextOperatingPolicy, resolveKnownContextModelProfile } from "./context-budget.js";
import { createMainAgentTools } from "./tools/index.js";

/** Wire shape the provider sees: Mastra tool id/description plus its JSON Schema. */
function toWireTool(tool: ReturnType<typeof createMainAgentTools>[number]) {
  return { type: "function" as const, function: { name: tool.id, description: tool.description,
    parameters: standardSchemaToJSONSchema(tool.inputSchema as never, { io: "input" }) } };
}

// The legacy DeepAgent system prompt was retired with the legacy runtime; the
// Mastra runtime composes its own instructions. A representative prompt keeps
// this budget assertion meaningful.
const LOOMIC_SYSTEM_PROMPT = "You are Loomic's design agent. Use the registered tools directly and preserve the user's exact constraints.";

const verified = { profileSource: "administrator_verified", verifiedAt: "2026-09-09T00:00:00Z",
  contextWindowTokens: 128_000, maxInputTokens: 128_000, maxOutputTokens: 16_000 };

describe("context operating budget", () => {
  it("selects lean only for exact DeepSeek aliases and keeps ordinary models conservative", () => {
    expect(resolveContextOperatingPolicy("deepseek-v4-flash-vision-exp")).toBe("lean-expandable");
    expect(resolveContextOperatingPolicy("deepseek-v4-flash")).toBe("lean-expandable");
    expect(resolveContextOperatingPolicy("deepseek-flash")).toBe("lean-expandable");
    expect(resolveContextOperatingPolicy("deepseek-v4-flash-preview")).toBe("conservative");
    expect(resolveContextOperatingPolicy("gateway-model")).toBe("conservative");
  });

  it("gives lean DeepSeek an expandable ceiling without filling short requests", () => {
    expect(createContextBudget(undefined, "lean-expandable")).toMatchObject({
      verification: "unverified", inputCeilingTokens: 128_000, softLimitTokens: 48_000,
      targetTokens: 16_000, keepTokens: 8_000, generationReserveTokens: 8_000,
    });
  });

  it("supports extended output while retaining the 128K input ceiling", () => {
    expect(createContextBudget(undefined, "lean-extended-output")).toMatchObject({
      inputCeilingTokens: 128_000, softLimitTokens: 48_000, targetTokens: 32_000,
      keepTokens: 8_000, generationReserveTokens: 16_000,
    });
  });
  it("does not advertise a capacity for unknown models", () => {
    const budget = createContextBudget({ contextWindowTokens: 1_000_000 });
    expect(budget).toMatchObject({ verification: "unverified", modelContextWindowTokens: null,
      applicationWindowTokens: 64_000, inputCeilingTokens: 40_000, softLimitTokens: 24_000,
      targetTokens: 16_000, generationReserveTokens: 8_000 });
  });

  it("reserves output, tool growth and uncertainty in a verified 128K window", () => {
    expect(createContextBudget({ ...verified, contextWindowTokens: 128_000 })).toMatchObject({
      verification: "verified", inputCeilingTokens: 80_000, softLimitTokens: 48_000,
      targetTokens: 32_000, generationReserveTokens: 16_000, toolGrowthReserveTokens: 16_000,
      uncertaintyReserveTokens: 16_000,
    });
  });

  it("respects small provider input/output limits without scaling larger windows automatically", () => {
    const budget = createContextBudget({ ...verified, contextWindowTokens: 16_000, maxInputTokens: 6_000, maxOutputTokens: 1_000 });
    expect(budget.inputCeilingTokens).toBe(6_000);
    expect(budget.generationReserveTokens).toBe(1_000);
    expect(createContextBudget({ ...verified, contextWindowTokens: 1_000_000 }).inputCeilingTokens).toBe(80_000);
  });

  it("clamps lean policy to verified small provider capacity", () => {
    const small = { ...verified, contextWindowTokens: 16_000, maxInputTokens: 6_000, maxOutputTokens: 1_000 };
    expect(createContextBudget(small, "lean-expandable")).toMatchObject({
      verification: "verified", inputCeilingTokens: 6_000, generationReserveTokens: 1_000,
    });
  });

  it("uses one verified image allowance for both the budget and estimator", () => {
    const profile = { ...verified, imageTokensPerImage: 1_024 };
    const budget = createContextBudget(profile, "lean-expandable");
    const message = { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/a" } }] };
    expect(budget.imageTokensPerImage).toBe(1_024);
    expect(estimateContextTokens([message], undefined, budget).estimatedImageTokens).toBe(1_024);
    expect(estimateContextTokens([message], undefined, profile).estimatedImageTokens).toBe(1_024);
  });

  it("selects only an exact configured ref, without guessing by model family", () => {
    const json = JSON.stringify({ "apiyi:example": verified, example: { ...verified, contextWindowTokens: 64_000, maxInputTokens: 64_000 } });
    expect(resolveContextModelProfile("apiyi:example", json, "example")?.contextWindowTokens).toBe(128_000);
    expect(resolveContextModelProfile("other:example", json, "example")?.contextWindowTokens).toBe(64_000);
    expect(resolveContextModelProfile("apiyi:example-preview", json)).toBeUndefined();
  });

  it("uses built-in evidence only for the exact documented APIYI endpoint and model", () => {
    const profile = resolveKnownContextModelProfile("gemini-3.1-flash-lite", "https://api.apiyi.com/v1");
    expect(profile).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxInputTokens: 983_040,
      maxOutputTokens: 65_536,
      profileSource: "https://docs.apiyi.com/news/gemini-3-1-flash-lite-launch",
      verifiedAt: "2026-09-10T00:00:00+08:00",
      profileVersion: "apiyi-gemini-3.1-flash-lite-ga-2026-05-09",
    });
    expect(createContextBudget(profile)).toMatchObject({ verification: "verified", applicationWindowTokens: 128_000,
      inputCeilingTokens: 80_000, generationReserveTokens: 16_000 });
    expect(resolveKnownContextModelProfile("gemini-3.1-flash-lite", "https://gateway.example/v1")).toBeUndefined();
    expect(resolveKnownContextModelProfile("gemini-3.1-flash-lite-preview", "https://api.apiyi.com/v1")).toBeUndefined();
    expect(resolveKnownContextModelProfile("gemini-3.1-flash-lite", "https://api.apiyi.com/v2")).toBeUndefined();
    expect(resolveKnownContextModelProfile("gemini-3.1-flash-lite", "https://api.apiyi.com:8443/v1")).toBeUndefined();
  });

  it("does not expose administrator input in invalid configuration errors", () => {
    expect(() => resolveContextModelProfile("m", "secret-not-json")).toThrow("模型上下文能力配置无效");
    expect(() => resolveContextModelProfile("m", '{"m":{"maxOutputTokens":-1}}')).toThrow();
    expect(() => createContextBudget({ ...verified, contextWindowTokens: 8 })).toThrow();
    expect(() => resolveContextModelProfile("m", '{"m":{"maxInputToken":32000}}')).toThrow();
    expect(() => createContextBudget({ ...verified, maxInputTokens: 256_000 })).toThrow();
  });

  it("does not treat incomplete or explicitly unverified profiles as verified", () => {
    expect(createContextBudget({ profileSource: "admin", verifiedAt: verified.verifiedAt, contextWindowTokens: 128_000 }).verification).toBe("unverified");
    expect(createContextBudget({ ...verified, profileSource: " unverified " }).verification).toBe("unverified");
  });
});

describe("conservative multimodal estimator", () => {
  it("fits the actual main design tool catalog after converting Zod to wire schemas", () => {
    const tools = createMainAgentTools({
      createUserClient: () => { throw new Error("Test must not access the database"); },
      designTools: { designService: {}, designResourceService: {}, designTemplateService: {} } as never,
    });
    const wireTools = tools.map(tool => toWireTool(tool));
    const estimate = estimateContextTokens([{ role: "system", content: LOOMIC_SYSTEM_PROMPT }], wireTools);
    expect(tools.length).toBeGreaterThan(8);
    expect(estimate.estimatedToolTokens).toBeGreaterThan(1_000);
    expect(estimate.estimatedInputTokens).toBeLessThan(createContextBudget().inputCeilingTokens);
  });

  it("counts Chinese, instructions, tool-call arguments and tool results", () => {
    // Plain message objects: the estimator is duck-typed on the fields the
    // provider wire actually carries (content, tool_calls, tool_call_id).
    const messages = [{ role: "system", content: "系统" }, { role: "user", content: "保留原始标题" },
      { role: "assistant", content: "", tool_calls: [{ id: "call", name: "edit", args: { text: "夏日上新" } }] },
      { role: "tool", content: "已保存", tool_call_id: "call" }];
    const estimate = estimateContextTokens(messages, [{ function: { name: "edit", parameters: { title: "文本修改" } } }]);
    expect(estimate.source).toBe("conservative_estimate");
    expect(estimate.estimatedTextTokens).toBeGreaterThan(3 * "系统保留原始标题夏日上新已保存".length);
    expect(estimate.estimatedToolTokens).toBeGreaterThan(16);
  });

  it("counts the parsed tool call once when the provider-raw form is also retained", () => {
    const parsed = { id: "call", name: "edit", args: { text: "夏日上新" }, type: "tool_call" as const };
    const raw = { id: "call", type: "function" as const, function: { name: "edit", arguments: JSON.stringify(parsed.args) } };
    const parsedOnly = { content: "", tool_calls: [parsed] };
    const duplicatedRawForm = { content: "", tool_calls: [parsed], additional_kwargs: { tool_calls: [raw] } };
    expect(estimateContextTokens([duplicatedRawForm])).toEqual(estimateContextTokens([parsedOnly]));

    const rawOnly = estimateContextTokens([{ content: "", additional_kwargs: { tool_calls: [raw] } }]);
    expect(rawOnly.estimatedInputTokens).toBeGreaterThan(estimateContextTokens([{ content: "" }]).estimatedInputTokens);
  });

  it("charges images independent of URL or base64 string size", () => {
    const make = (url: string) => ({ role: "user", content: [{ type: "image_url", image_url: { url } }] });
    const short = estimateContextTokens([make("https://example.invalid/image.png")]);
    const large = estimateContextTokens([make(`data:image/png;base64,${"A".repeat(1_000_000)}`)]);
    expect(short.imageCount).toBe(1);
    expect(short.estimatedImageTokens).toBe(8_192);
    expect(large.estimatedInputTokens).toBe(short.estimatedInputTokens);
  });

  it("refuses an oversized packet without silently cutting user constraints", () => {
    const message = { role: "user", content: "固定标题".repeat(10_000) };
    const estimate = estimateContextTokens([message]);
    expect(() => assertContextBudget(estimate, createContextBudget())).toThrow("未向模型发送");
    expect(message.content).toHaveLength(40_000);
  });

  it("reports the 15k fixed-base image boundary for one, three, and ten current images", () => {
    const fixedBase = { role: "system", content: "fixed prepared-agent prompt ".repeat(1_500) };
    const imageMessage = (count: number) => ({ role: "user", content: [
      { type: "text" as const, text: "当前用户原文：只修改当前图片背景，保留文字。" },
      ...Array.from({ length: count }, (_, index) => ({ type: "image_url" as const,
        image_url: { url: `https://example.invalid/current-${index}.png` } })),
    ] });
    const results = [1, 3, 10].map(imageCount => {
      const estimate = estimateContextTokens([fixedBase, imageMessage(imageCount)]);
      console.info("[offline-current-image-boundary]", {
        imageCount, estimatedInputTokens: estimate.estimatedInputTokens,
        estimatedImageTokens: estimate.estimatedImageTokens,
      });
      return { imageCount, estimate };
    });
    expect(results[0]!.estimate.imageCount).toBe(1);
    expect(results[1]!.estimate.imageCount).toBe(3);
    expect(results[2]!.estimate.imageCount).toBe(10);
    expect(results[0]!.estimate.estimatedInputTokens).toBeLessThanOrEqual(40_000);
    expect(results[1]!.estimate.estimatedInputTokens).toBeLessThanOrEqual(40_000);
    expect(results[2]!.estimate.estimatedInputTokens).toBeGreaterThan(40_000);
    assertContextBudget(results[0]!.estimate, createContextBudget());
    assertContextBudget(results[1]!.estimate, createContextBudget());
    expect(() => assertContextBudget(results[2]!.estimate, createContextBudget()))
      .toThrow("未向模型发送");
  });

  it("fits nine explicitly referenced images under lean's 128K offline ceiling", () => {
    const lean = createContextBudget(undefined, "lean-expandable");
    const message = { role: "user", content: Array.from({ length: 9 }, (_, index) => ({
      type: "image_url" as const, image_url: { url: `https://example.invalid/ref-${index}.png` },
    })) };
    const estimate = estimateContextTokens([message], undefined, lean);
    expect(estimate.imageCount).toBe(9);
    expect(estimate.estimatedImageTokens).toBe(9 * 8_192);
    expect(estimate.estimatedInputTokens).toBeLessThanOrEqual(lean.inputCeilingTokens);
    expect(() => assertContextBudget(estimate, lean)).not.toThrow();
  });
});
