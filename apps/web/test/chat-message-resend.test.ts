import { describe, expect, it } from "vitest";
import { messageResendReferences } from "../src/lib/chat-message-resend";

describe("message resend references", () => {
  it("keeps original image, skill, brand and exact model references", () => {
    const result = messageResendReferences([
      { type: "text", text: "change the logo" },
      { type: "image", assetId: "original", url: "https://example.com/logo.png", mimeType: "image/png", source: "canvas-ref", name: "Logo" },
      { type: "mention", mentionType: "image-model", id: "workspace:exact-model", label: "gpt-image-2" },
      { type: "mention", mentionType: "skill", id: "skill", label: "Logo", slug: "logo-design" },
      { type: "mention", mentionType: "brand-kit-asset", id: "brand", label: "Brand", assetType: "color", textContent: "#FF0000" },
    ]);
    expect(result.attachments).toEqual([{ assetId: "original", url: "https://example.com/logo.png", mimeType: "image/png", source: "canvas-ref", name: "Logo" }]);
    expect(result.imageGenerationPreference).toEqual({ mode: "manual", models: ["workspace:exact-model"] });
    expect(result.mentions.map(item => item.mentionType)).toEqual(["image-model", "skill", "brand-kit-asset"]);
  });
  it("returns explicit empty references instead of inheriting a composer attachment", () => {
    expect(messageResendReferences([{ type: "text", text: "658*176" }])).toEqual({ attachments: [], mentions: [], imageGenerationPreference: undefined });
  });
});
