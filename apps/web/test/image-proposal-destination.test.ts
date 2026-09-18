import { describe, expect, it } from "vitest";
import { imageProposalDestination } from "../src/lib/image-proposal-destination";
describe("frozen image proposal destination", () => {
  it("distinguishes canvas edits, new board layers and background replacements", () => {
    expect(imageProposalDestination({ target: null })).toContain("保留原图，不修改画板");
    expect(imageProposalDestination({ target: { kind: "design", design_id: "board", placement: {} } })).toBe("设计画板 board · 新增图片图层");
    expect(imageProposalDestination({ target: { kind: "design", design_id: "board", placement: { role: "background", replace_object_id: "old" } } })).toBe("设计画板 board · 替换现有背景图层");
    expect(imageProposalDestination({})).toContain("未记录");
  });
});
