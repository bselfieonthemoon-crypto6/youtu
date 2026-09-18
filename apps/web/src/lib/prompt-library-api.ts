import {
  promptLibraryResponseSchema,
  type PromptLibraryResponse,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";

export type PromptLibraryQuery = {
  q?: string;
  source?: string;
  category?: string;
  offset?: number;
  limit?: number;
};

export async function fetchPromptLibrary(
  accessToken: string,
  query: PromptLibraryQuery = {},
  signal?: AbortSignal,
): Promise<PromptLibraryResponse> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.source) params.set("source", query.source);
  if (query.category) params.set("category", query.category);
  params.set("offset", String(query.offset ?? 0));
  params.set("limit", String(query.limit ?? 24));
  const response = await fetch(
    `${getServerBaseUrl()}/api/prompt-library?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "登录已过期，请重新登录后打开提示词库。"
        : "提示词库暂时无法加载，请重试。",
    );
  }
  const result = promptLibraryResponseSchema.safeParse(await response.json());
  if (!result.success)
    throw new Error("提示词库数据格式异常，请重试或联系管理员。");
  return result.data;
}

export type PromptLibraryApplyMode = "replace" | "append";

/** Only changes the prompt; model, references and generation remain user-controlled. */
export function composeLibraryPrompt(
  current: string,
  selected: string,
  mode: PromptLibraryApplyMode,
): string {
  if (mode === "replace" || !current.trim()) return selected;
  return `${current.trimEnd()}\n\n${selected.trimStart()}`;
}
