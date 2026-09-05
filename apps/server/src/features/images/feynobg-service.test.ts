import { describe, expect, it } from "vitest";
import {
  describeFeynobgWorkerExit,
  resolveFeynobgCpuThreads,
} from "./feynobg-service.js";

describe("FeyNoBG local runtime safeguards", () => {
  it("uses a conservative Windows thread budget with a bounded override", () => {
    expect(resolveFeynobgCpuThreads(undefined, "win32")).toBe(2);
    expect(resolveFeynobgCpuThreads(undefined, "linux")).toBe(8);
    expect(resolveFeynobgCpuThreads("4", "win32")).toBe(4);
    expect(resolveFeynobgCpuThreads("0", "win32")).toBe(2);
    expect(resolveFeynobgCpuThreads("100", "win32")).toBe(2);
    expect(resolveFeynobgCpuThreads("invalid", "win32")).toBe(2);
  });

  it("explains the Windows native access-violation exit", () => {
    const unsigned = describeFeynobgWorkerExit(0xc0000005, "win32");
    const signed = describeFeynobgWorkerExit(-1073741819, "win32");

    expect(unsigned).toContain("0xC0000005");
    expect(unsigned).toContain("memory pressure");
    expect(signed).toBe(unsigned);
    expect(describeFeynobgWorkerExit(1, "win32")).toContain("(1)");
  });
});
