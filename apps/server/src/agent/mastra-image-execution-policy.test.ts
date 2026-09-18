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
});
