import { describe, expect, it } from "vitest";

import { parseRecognizedTexts } from "./image-text-recognizer.js";

describe("image text recognition response parsing", () => {
  it("parses fenced JSON, trims text and removes duplicates", () => {
    expect(parseRecognizedTexts("```json\n{\"texts\":[\" aaaa. \",\"com\",\"com\"]}\n```"))
      .toEqual(["aaaa.", "com"]);
  });

  it("fails closed when the model response is not structured JSON", () => {
    expect(parseRecognizedTexts("I found some text")).toEqual([]);
  });
});
