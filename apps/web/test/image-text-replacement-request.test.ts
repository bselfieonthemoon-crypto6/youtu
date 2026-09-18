import { describe, expect, it } from "vitest";
import { buildTextReplacementContent } from "../src/lib/image-text-replacement-request";

describe("text replacement source framing", () => {
  it.each([[1916, 821], [821, 1916], [1024, 1024]])("preserves decoded %s:%s", (width, height) => {
    const request = buildTextReplacementContent({ dataURL: "data:image/png;base64,test", width, height },
      [{ original: "你好", replacement: "我不好" }]);
    expect(request.aspect_ratio).toBe(`${width}:${height}`);
    expect(request.input_images).toEqual(["data:image/png;base64,test"]);
    expect(request.prompt).toContain('将“你好”替换为“我不好”');
    expect(request.prompt).toContain("不要拼图");
  });
  it("does not silently default unreadable dimensions to square", () => {
    expect(() => buildTextReplacementContent({ dataURL: "", width: 0, height: 100 }, [])).toThrow();
  });
});
