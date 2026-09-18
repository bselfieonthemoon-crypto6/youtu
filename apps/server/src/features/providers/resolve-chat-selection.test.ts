import { describe, expect, it, vi } from "vitest";
import { resolveChatSelection } from "./resolve-chat-selection.js";

const user = { id: "owner", accessToken: "token", email: "", userMetadata: {} };
const id = "workspace:current-deepseek";
function catalog() {
  return { listPublished: vi.fn(async () => [{ model: { id, modality: "text" }, upstreamModelId: "deepseek" }]),
    resolvePublishedModel: vi.fn(async () => null) } as any;
}
describe("live product chat model selection", () => {
  it("Auto replaces an unpublished environment default with the current catalogue", async () => {
    expect(await resolveChatSelection({ user, workspaceId: "w", defaultModel: "apiyi:gemini", catalog: catalog() })).toBe(id);
  });
  it("never allows an explicit stale alias even when it equals the environment default", async () => {
    await expect(resolveChatSelection({ user, workspaceId: "w", requested: "apiyi:gemini", defaultModel: "apiyi:gemini", catalog: catalog() })).rejects.toThrow();
  });
  it("fails closed on an empty or failed catalogue", async () => {
    const empty = catalog(); empty.listPublished.mockResolvedValue([]);
    await expect(resolveChatSelection({ user, workspaceId: "w", defaultModel: "apiyi:gemini", catalog: empty })).rejects.toThrow();
    empty.listPublished.mockRejectedValue(new Error("offline"));
    await expect(resolveChatSelection({ user, workspaceId: "w", catalog: empty })).rejects.toThrow("offline");
  });
  it("keeps a currently published workspace default", async () => {
    expect(await resolveChatSelection({ user, workspaceId: "w", defaultModel: id, catalog: catalog() })).toBe(id);
  });
});
