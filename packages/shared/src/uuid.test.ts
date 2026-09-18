import { describe, expect, it } from "vitest";

import { extractUuids, isUuid, parseWorkspaceModelId, workspaceModelIdPattern } from "./uuid.js";

const byVersion = Array.from({ length: 8 }, (_, index) =>
  `123e4567-e89b-${index + 1}2d3-a456-426614174000`,
);

describe("UUID contract", () => {
  it.each(byVersion)("accepts RFC-variant UUID version %s", value => {
    expect(isUuid(value)).toBe(true);
    expect(workspaceModelIdPattern.test(`workspace:${value}`)).toBe(true);
    expect(parseWorkspaceModelId(`WORKSPACE:${value.toUpperCase()}`)).toBe(value);
  });

  it.each([
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-92d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-42d3-c456-426614174000",
    "123e4567e89b42d3a456426614174000",
    "123e4567-e89b-42d3-a456-42661417400z",
  ])("rejects non-project UUID %s", value => {
    expect(isUuid(value)).toBe(false);
    expect(parseWorkspaceModelId(`workspace:${value}`)).toBeNull();
  });

  it("extracts supported UUIDs uniquely and honors the limit", () => {
    expect(extractUuids(`${byVersion[6]} ${byVersion[0]} ${byVersion[6]}`, 2))
      .toEqual([byVersion[6], byVersion[0]]);
  });
});
