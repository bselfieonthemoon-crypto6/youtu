import { describe, expect, it } from "vitest";

import {
  inlineLocalJsonSchemaReferences,
  prepareWorkspaceVisionTools,
  toReferenceFreeOpenAITool,
} from "./provider-tool-schema.js";

/**
 * This coverage replaces the retired `openai-compatible-chat-model.test.ts`,
 * which tested `toAIMessage`/`toAIMessageChunk` — LangChain-only adapters that
 * no longer exist. `toReferenceFreeOpenAITool` is the one provider adapter that
 * survives the migration, because the final budget guard still charges tool
 * schemas on the wire.
 */
describe("provider tool schema normalization", () => {
  it("inlines local JSON Schema references for Gemini FunctionDeclaration compatibility", () => {
    const normalized = toReferenceFreeOpenAITool({
      type: "function",
      function: {
        name: "generate_image",
        parameters: {
          type: "object",
          properties: { size: { $ref: "#/$defs/Size" } },
          $defs: { Size: { type: "string", enum: ["1k", "2k"] } },
        },
      },
    }) as { function: { parameters: Record<string, unknown> } };

    expect(normalized.function.parameters.properties).toEqual({
      size: { type: "string", enum: ["1k", "2k"] },
    });
    // The definitions block itself is dropped once references are inlined.
    expect(normalized.function.parameters.$defs).toBeUndefined();
  });

  it("keeps sibling keys next to a reference and merges them over the target", () => {
    const normalized = toReferenceFreeOpenAITool({
      type: "function",
      function: {
        name: "t",
        parameters: {
          type: "object",
          properties: { a: { $ref: "#/$defs/A", description: "override" } },
          $defs: { A: { type: "string", description: "original" } },
        },
      },
    }) as { function: { parameters: { properties: Record<string, unknown> } } };

    expect(normalized.function.parameters.properties.a).toEqual({
      type: "string",
      description: "override",
    });
  });

  it("leaves provider-native tools without function parameters untouched", () => {
    const native = { type: "web_search_preview" };
    expect(toReferenceFreeOpenAITool(native)).toBe(native);
  });

  it("honours a provider-supplied definition and its deferred-loading flag", () => {
    const normalized = toReferenceFreeOpenAITool({
      name: "deferred",
      schema: {},
      extras: {
        defer_loading: true,
        providerToolDefinition: {
          type: "function",
          function: { name: "deferred", parameters: { type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: { type: "number" } } } },
        },
      },
    }) as Record<string, unknown>;

    expect(normalized.defer_loading).toBe(true);
    expect((normalized.function as { parameters: Record<string, unknown> }).parameters.properties).toEqual({
      x: { type: "number" },
    });
  });

  it("fails locally on external and recursive references instead of paying for a provider error", () => {
    expect(() => inlineLocalJsonSchemaReferences({ $ref: "https://example.test/schema.json" }))
      .toThrow(/external JSON Schema reference/);
    expect(() => inlineLocalJsonSchemaReferences({
      type: "object",
      properties: { self: { $ref: "#/$defs/Self" } },
      $defs: { Self: { type: "object", properties: { self: { $ref: "#/$defs/Self" } } } },
    })).toThrow(/recursive JSON Schema reference/);
    expect(() => inlineLocalJsonSchemaReferences({ $ref: "#/$defs/Missing" }))
      .toThrow(/unresolved JSON Schema reference/);
  });

  it("expands a shared definition once per occurrence without exponential blow-up", () => {
    const shared = { type: "object", properties: Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`f${index}`, { type: "string" }]),
    ) };
    const normalized = inlineLocalJsonSchemaReferences({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`p${index}`, { $ref: "#/$defs/Shared" }])),
      $defs: { Shared: shared },
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toHaveLength(6);
    expect(properties.p0).toEqual(shared);
  });

  it("charges an empty tool list as no tool schema at all", () => {
    expect(prepareWorkspaceVisionTools(undefined)).toEqual([]);
    expect(prepareWorkspaceVisionTools([])).toEqual([]);
    expect(prepareWorkspaceVisionTools([{ type: "web_search_preview" }]))
      .toEqual([{ type: "web_search_preview" }]);
  });
});
