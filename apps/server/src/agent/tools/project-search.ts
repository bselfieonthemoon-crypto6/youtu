import type { ToolRuntime } from "@langchain/core/tools";
import {
  adaptBackendProtocol,
  type AnyBackendProtocol,
} from "deepagents";
import { tool } from "langchain";
import { z } from "zod";

import type { SyncBackendFactory } from "../backends/index.js";

const DEFAULT_SEARCH_ROOT = "/workspace";
const DEFAULT_MAX_MATCHES = 5;

const projectSearchSchema = z.object({
  query: z.string().min(1),
  glob: z.string().min(1).optional(),
  maxMatches: z.number().int().min(1).max(20).optional(),
});

type ProjectSearchInput = z.infer<typeof projectSearchSchema>;

type ProjectSearchResult = {
  matchCount: number;
  matches: Array<{
    line: number;
    path: string;
    text: string;
  }>;
  summary: string;
};

export async function runProjectSearch(
  backend: AnyBackendProtocol,
  input: ProjectSearchInput,
): Promise<ProjectSearchResult> {
  const result = await adaptBackendProtocol(backend).grep(
    input.query,
    DEFAULT_SEARCH_ROOT,
    input.glob ?? null,
  );

  if (result.error) {
    return {
      matchCount: 0,
      matches: [],
      summary: result.error,
    };
  }

  const rawMatches = result.matches ?? [];

  const sortedMatches = [...rawMatches].sort((left, right) => {
    if (left.path === right.path) {
      return left.line - right.line;
    }

    return left.path.localeCompare(right.path);
  });
  const matchCount = sortedMatches.length;
  const limitedMatches = sortedMatches.slice(
    0,
    input.maxMatches ?? DEFAULT_MAX_MATCHES,
  );
  const fileCount = new Set(sortedMatches.map((match) => match.path)).size;

  return {
    matchCount,
    matches: limitedMatches.map((match) => ({
      line: match.line,
      path: match.path,
      text: match.text,
    })),
    summary:
      matchCount === 0
        ? `No workspace matches found for "${input.query}".`
        : `Found ${matchCount} workspace match(es) for "${input.query}" across ${fileCount} file(s).`,
  };
}

export function createProjectSearchTool(
  backend: AnyBackendProtocol | SyncBackendFactory,
) {
  return tool(
    async (input, runtime: ToolRuntime) => {
      return await runProjectSearch(resolveBackend(backend, runtime), input);
    },
    {
      name: "project_search",
      description:
        "Search the Loomic workspace for matching project text without using shell execution.",
      schema: projectSearchSchema,
    },
  );
}

function resolveBackend(
  backend: AnyBackendProtocol | SyncBackendFactory,
  runtime: ToolRuntime,
): AnyBackendProtocol {
  if (typeof backend === "function") {
    return backend({
      state: runtime.state,
    });
  }

  return backend;
}
