import { describe, expect, it } from "vitest";

import { PROVIDER_FAILURE_CODES, providerFailureDescription } from "../../agent/provider-failure-copy.js";
import {
  JOB_FAILURE_CLASS_LABELS,
  classifyJobFailure,
  isFailureClass,
  type JobFailureClass,
} from "./job-failure-class.js";

describe("job failure classification", () => {
  // Status outranks the code: whatever interrupted a job the user stopped, the only
  // thing they need to read is that they stopped it.
  it("treats a cancellation as a cancellation even when it carries a failure code", () => {
    expect(classifyJobFailure({ status: "canceled", errorCode: "provider_rate_limited" })).toBe("canceled");
    expect(isFailureClass("canceled")).toBe(false);
  });

  // The defect this whole file exists to prevent: one generic "生成失败" for causes
  // that need different actions. An unrecognised code must therefore stay
  // unrecognised rather than being blamed on the channel or on the user.
  it("keeps an unrecognised code unrecognised instead of inventing a cause", () => {
    expect(classifyJobFailure({ status: "dead_letter", errorCode: "some_future_code" })).toBe("unknown");
    expect(classifyJobFailure({ status: "dead_letter", errorCode: null })).toBe("unknown");
    expect(classifyJobFailure({ status: "failed" })).toBe("unknown");
    expect(isFailureClass("unknown")).toBe(false);
    expect(JOB_FAILURE_CLASS_LABELS.unknown).toBe("原因未知");
  });

  it.each([
    ["invalid_input", "user_input"],
    ["safety_filter", "user_input"],
    ["provider_rate_limited", "provider"],
    ["provider_rejected", "provider"],
    ["image_generation_result_unknown", "provider"],
    ["outpaint_geometry_mismatch", "provider"],
    ["http_401", "platform"],
    ["provider_snapshot_invalid", "platform"],
    ["job_attempt_increment_failed", "platform"],
    ["source_grounding_ambiguous", "agent_routing"],
    ["source_grounding_unavailable", "agent_routing"],
    ["skill_output_kind_conflict", "agent_routing"],
    ["image_nonstandard_size_skill_required", "agent_routing"],
    ["invalid_command", "unsupported_entry"],
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyJobFailure({ status: "dead_letter", errorCode: code })).toBe(expected);
  });

  it("classifies every code the provider copy function names", () => {
    // The two lists must not drift: a code with a specific Chinese sentence that the
    // classifier does not know would surface as "原因未知" right next to it.
    for (const code of PROVIDER_FAILURE_CODES) {
      expect(providerFailureDescription(code), code).toBeTruthy();
      expect(classifyJobFailure({ status: "dead_letter", errorCode: code }), code).not.toBe("unknown");
    }
  });

  it("labels every class in Chinese, and calls only real problems failures", () => {
    for (const failureClass of Object.keys(JOB_FAILURE_CLASS_LABELS) as JobFailureClass[])
      expect(JOB_FAILURE_CLASS_LABELS[failureClass], failureClass).toMatch(/[\u4e00-\u9fa5]/);
    expect(isFailureClass("provider")).toBe(true);
    expect(isFailureClass("user_input")).toBe(true);
    expect(isFailureClass("agent_routing")).toBe(true);
    expect(isFailureClass("platform")).toBe(true);
    expect(isFailureClass("unsupported_entry")).toBe(true);
  });
});
