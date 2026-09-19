import { describe, expect, it } from "vitest";
import { mastraImageAuthorizationCases } from "./mastra-image-authorization-cases.js";
import { mastraImageExecutionPolicy, validateMastraImageExecution } from "./mastra-image-execution-policy.js";

describe("current original user image execution authorization", () => {
  it.each(mastraImageAuthorizationCases)("validates $text independently of the model request", ({ text, quality, resolution, expectedCode, expectedLimit }) => {
    expect(validateMastraImageExecution({ quality, resolution }, text)?.code ?? null).toBe(expectedCode);
    expect(mastraImageExecutionPolicy(text, 4).limit).toBe(expectedLimit);
  });

  it("bounds configured defaults and honors explicit output count", () => {
    expect(mastraImageExecutionPolicy("制作海报", 2).limit).toBe(2);
    expect(mastraImageExecutionPolicy("制作海报", 8).limit).toBe(4);
  });

  it("counts 版/款/组 as outputs, which used to be missed entirely", () => {
    // Regression: these units were absent, so an explicit request fell back to
    // the default limit, silently capped the count and then refused the rest as
    // `image_generation_run_limit` — the exact shape of the reported incident.
    expect(mastraImageExecutionPolicy("出三版不同风格的主图").limit).toBe(3);
    expect(mastraImageExecutionPolicy("来两款方案").limit).toBe(2);
    expect(mastraImageExecutionPolicy("做两组图").limit).toBe(2);
    expect(mastraImageExecutionPolicy("做成六个版本").limit).toBe(6);
  });

  it("counts a count that is stated through 出 before any later verb", () => {
    // The reported turn: the 三版 is stated through 出. Counting only from the
    // next verb ("做一版轮播") would have produced a limit of 1 for a four-output
    // request, which is worse than the default it replaced.
    const reported = "先分析这张参考图，再出三版不同风格的主图，最后做一版轮播";
    expect(mastraImageExecutionPolicy(reported).limit).toBe(4);
  });

  it("keeps 套 and 页 out of the unit table so a bundle is not double-counted", () => {
    // "一套五张" is FIVE outputs; counting 套 too would read it as six.
    expect(mastraImageExecutionPolicy("做一套五张的产品物料").limit).toBe(5);
    // 页 names a deliverable as often as an image count.
    expect(mastraImageExecutionPolicy("做一个详情页").limit).toBe(4);
  });

  it("does not read a pricing or capability question as an output count", () => {
    // A simulated user asked how much one image costs; the question compressed
    // the turn's budget to a single image and the agent then repeated "本轮最多
    // 1 张" to the user as if it were the rule.
    for (const question of [
      "生成一张图要花多少积分？",
      "一张图多少钱？",
      "生成一张的计费方式是什么",
      "这个模型支持生成几张？",
      "生图的单价怎么算",
    ]) {
      expect(mastraImageExecutionPolicy(question).limit).toBe(4);
    }
    // A real count request still reads its count.
    expect(mastraImageExecutionPolicy("生成一张 1:1 的无线耳机产品图").limit).toBe(1);
  });
});
