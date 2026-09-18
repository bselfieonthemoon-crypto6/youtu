import { describe, expect, it } from "vitest";
import { namedImageCancellationSubject, matchesNamedImageCancellation } from "./named-image-cancellation.js";
describe("named image cancellation", () => {
  it("resolves the real stop-and-cancel sentence without dropping orientation", () => {
    const subject = namedImageCancellationSubject("先不要生成了，取消刚才的冷泡茶横版方案。");
    expect(subject).toBe("冷泡茶横版");
    expect(matchesNamedImageCancellation(subject!, "澄屿 CHENGDAO 系列横版辅助图「冷泡茶」16:9")).toBe(true);
    expect(matchesNamedImageCancellation(subject!, "澄屿 竖版冷泡茶")).toBe(false);
    expect(namedImageCancellationSubject("先不要生成了，取消冷泡茶，然后生成海报")).toBeNull();
  });
  it.each(["取消刚才那个优惠券方案", "请取消优惠券方案。", "帮我取消优惠券生成任务"])("extracts the named subject: %s", text => {
    expect(namedImageCancellationSubject(text)).toBe("优惠券");
  });
  it.each(["不要取消优惠券", "取消优惠券吗？", "如果失败取消优惠券", "取消优惠券然后生成海报", "取消生成", "例如取消优惠券"])("rejects unsafe or unbound wording: %s", text => {
    expect(namedImageCancellationSubject(text)).toBeNull();
  });
  it("matches only the named material", () => {
    expect(matchesNamedImageCancellation("优惠券", "Mellow Coffee 优惠券方案")).toBe(true);
    expect(matchesNamedImageCancellation("优惠券", "Mellow Coffee 会员卡方案")).toBe(false);
  });
});
