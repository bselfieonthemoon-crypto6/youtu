import { describe, expect, it } from "vitest";

import {
  isApiYiAggregateGptImageModel,
  isNativeGptImageModel,
} from "./image-model-identifiers.js";

describe("image model identifier matrix", () => {
  it.each([
    "gpt-image-2",
    "gpt-image-2-2026-09-16",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare-2026-09-16",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-16",
  ])("classifies %s as a native-size GPT image model", model => {
    expect(isNativeGptImageModel(model)).toBe(true);
    expect(isApiYiAggregateGptImageModel(model)).toBe(false);
  });

  it.each([
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2-all",
    "gpt-image-2.5-all",
    "gpt-image-2-vip",
    "gpt-image-2.5-flare-all",
    "GPT-IMAGE-2",
    "openai/gpt-image-2",
    "gpt-image-2-2026-9-16",
  ])("does not grant native-size semantics to %s", model => {
    expect(isNativeGptImageModel(model)).toBe(false);
  });

  it.each(["gpt-image-2-all", "gpt-image-2.5-all", "gpt-image-12.25-all"])(
    "classifies %s as an APIYI aggregate route",
    model => expect(isApiYiAggregateGptImageModel(model)).toBe(true),
  );
});
