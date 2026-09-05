import { describe, expect, it } from "vitest";

import { calculateDesignImageLayout } from "../src/lib/design-image-layout";

describe("calculateDesignImageLayout", () => {
  it.each([
    ["contain", 1, 1, 50, 0],
    ["original", 1, 1, 50, 0],
    ["cover", 2, 2, 0, -50],
    ["fill", 2, 1, 0, 0],
  ] as const)(
    "matches server %s preserveAspectRatio semantics",
    (fit, scaleX, scaleY, offsetX, offsetY) => {
      expect(
        calculateDesignImageLayout({
          sourceWidth: 100,
          sourceHeight: 100,
          frameWidth: 200,
          frameHeight: 100,
          fit,
        }),
      ).toMatchObject({ scaleX, scaleY, offsetX, offsetY });
    },
  );

  it("stretches a normalized source crop exactly into the frame", () => {
    expect(
      calculateDesignImageLayout({
        sourceWidth: 400,
        sourceHeight: 200,
        frameWidth: 300,
        frameHeight: 120,
        fit: "cover",
        crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 },
      }),
    ).toMatchObject({
      cropX: 100,
      cropY: 20,
      sourceWidth: 200,
      sourceHeight: 100,
      scaleX: 1.5,
      scaleY: 1.2,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("converts a destination-local rounded mask to image-local coordinates", () => {
    expect(
      calculateDesignImageLayout({
        sourceWidth: 100,
        sourceHeight: 100,
        frameWidth: 200,
        frameHeight: 100,
        fit: "cover",
        mask: {
          shape: "rounded_rect",
          x: 0.25,
          y: 0.1,
          width: 0.5,
          height: 0.8,
          radius: 0.25,
        },
      }).clip,
    ).toEqual({
      shape: "rounded_rect",
      left: -25,
      top: -20,
      width: 50,
      height: 40,
      radiusX: 10,
      radiusY: 10,
    });
  });
});
