// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCanvasStorageAsDataURL } from "../src/lib/canvas-elements";
afterEach(() => vi.unstubAllGlobals());
describe("canvas private storage download", () => {
  it("fetches authorized local storage directly, never via the external proxy", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], {type:"image/png"}) });
    vi.stubGlobal("fetch", request);
    const signal = new AbortController().signal;
    const url = "http://127.0.0.1:54421/storage/v1/object/sign/workspace-assets/test.png?token=test";
    expect(await fetchCanvasStorageAsDataURL(url, signal)).toMatch(/^data:image\/png;base64,/);
    expect(request).toHaveBeenCalledWith(url, { signal, credentials: "omit" });
  });
  it("rejects error pages rather than caching them as images", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(["error"],{type:"text/html"})}));
    await expect(fetchCanvasStorageAsDataURL("http://localhost/image")).rejects.toThrow("not an image");
  });
});
