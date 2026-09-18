/**
 * Provider tool-schema normalization, preserved from the retired LangChain
 * chat-model adapter.
 *
 * Several OpenAI-compatible Gemini gateways forward function schemas to
 * Google's `FunctionDeclaration` API. That API does not accept JSON Schema
 * references, while Zod legitimately emits `$ref`/`$defs` for shared nested
 * shapes. Inline local references so the same schema stays valid on both
 * OpenAI and Gemini adapters.
 */

type JsonObject = Record<string, unknown>;

const EMPTY_TOOLS: readonly WorkspaceToolLike[] = Object.freeze([]);

export type WorkspaceToolLike = {
  /** Tool name used to populate a function-schema name when absent. */
  name?: string;
  description?: string;
  /** JSON Schema for the tool input, or an already-built provider definition. */
  parameters?: JsonObject;
  /** A pre-built provider-native definition takes precedence over `parameters`. */
  providerToolDefinition?: JsonObject;
  /** Provider-native tools without a function schema pass through untouched. */
  type?: string;
  defer_loading?: boolean;
};

/**
 * Normalize the tools handed to the budget guard before any provider call.
 * Provider-native tools and tools without a parameters schema are unchanged.
 */
export function prepareWorkspaceVisionTools(tools: readonly unknown[] | undefined): readonly WorkspaceToolLike[] {
  if (!tools?.length) return EMPTY_TOOLS;
  return tools.map(toReferenceFreeOpenAITool);
}

/** Convert one tool to an OpenAI function declaration with local `$ref`s inlined. */
export function toReferenceFreeOpenAITool(tool: unknown): WorkspaceToolLike {
  if (!isRecord(tool)) return tool as WorkspaceToolLike;
  const extras = isRecord(tool.extras) ? tool.extras : undefined;
  const candidate = isRecord(extras?.providerToolDefinition)
    ? extras.providerToolDefinition
    : isRecord(tool.providerToolDefinition)
      ? tool.providerToolDefinition
      : tool.type === "function" || !tool.parameters
        ? tool
        : openAIFunctionFromSchemaTool(tool);
  if (candidate.type !== "function" || !isRecord(candidate.function)) return candidate as WorkspaceToolLike;
  const parameters = candidate.function.parameters;
  if (!isRecord(parameters)) return candidate as WorkspaceToolLike;
  return {
    ...candidate,
    ...(extras?.defer_loading === true || candidate.defer_loading === true ? { defer_loading: true } : {}),
    function: {
      ...candidate.function,
      parameters: inlineLocalJsonSchemaReferences(parameters),
    },
  } as WorkspaceToolLike;
}

/** Shape a Zod-backed tool into the OpenAI function declaration form. */
function openAIFunctionFromSchemaTool(tool: JsonObject): JsonObject {
  return {
    type: "function",
    function: {
      ...(typeof tool.name === "string" ? { name: tool.name } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  };
}

/** Gemini FunctionDeclaration schemas reject `$ref`. Only local references are
 * accepted here; external references fail locally instead of producing a
 * delayed paid provider error. */
export function inlineLocalJsonSchemaReferences(schema: JsonObject): JsonObject {
  const root = structuredClone(schema);
  // Memoize expanded local definitions so a shared DAG is not re-expanded for
  // every occurrence (which can blow up exponentially). A cyclic reference
  // throws during expansion and is therefore never cached.
  const resolvedCache = new Map<string, JsonObject>();
  const visit = (value: unknown, activeRefs: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map(entry => visit(entry, activeRefs));
    if (!isRecord(value)) return value;
    const ref = value.$ref;
    if (typeof ref === "string") {
      if (!ref.startsWith("#/")) throw unsupportedSchemaReference(ref, "external");
      if (activeRefs.has(ref)) throw unsupportedSchemaReference(ref, "recursive");
      let target = resolvedCache.get(ref);
      if (target === undefined) {
        const resolved = resolveJsonPointer(root, ref);
        if (!isRecord(resolved)) throw unsupportedSchemaReference(ref, "unresolved");
        target = visit(resolved, new Set([...activeRefs, ref])) as JsonObject;
        resolvedCache.set(ref, target);
      }
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      return Object.keys(siblings).length === 0
        ? target
        : visit({ ...target, ...siblings }, new Set([...activeRefs, ref]));
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "$defs" && key !== "definitions")
      .map(([key, entry]) => [key, visit(entry, activeRefs)]));
  };
  return visit(root, new Set()) as JsonObject;
}

function resolveJsonPointer(root: JsonObject, ref: string): unknown {
  return ref.slice(2).split("/").reduce<unknown>((current, raw) => {
    if (!isRecord(current)) return undefined;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    return current[key];
  }, root);
}

function unsupportedSchemaReference(ref: string, reason: string) {
  const error = new Error(`Provider tool schema contains an ${reason} JSON Schema reference: ${ref}`);
  (error as Error & { code?: string }).code = "provider_tool_schema_unsupported";
  return error;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
