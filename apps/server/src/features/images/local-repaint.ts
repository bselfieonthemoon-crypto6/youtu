import sharp from "sharp";

export type PreparedLocalRepaint = {
  width: number;
  height: number;
  sourcePng: Buffer;
  providerMaskPng: Buffer;
  maskPixels: Buffer;
  background: "transparent" | "opaque";
};

function invalidInput(message: string) {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

/**
 * Browser erase masks use black=preserve and white=repaint. OpenAI-compatible
 * edit masks use transparent=repaint, so convert the luminance to inverse
 * alpha while preserving the source canvas dimensions exactly.
 */
export async function prepareLocalRepaint(
  source: Buffer,
  mask: Buffer,
): Promise<PreparedLocalRepaint> {
  const sourceMetadata = await sharp(source).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw invalidInput("Local repaint source has no readable dimensions.");
  }
  const maskResult = await sharp(mask)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({
      resolveWithObject: true,
    });
  if (
    maskResult.info.width !== sourceMetadata.width ||
    maskResult.info.height !== sourceMetadata.height
  ) {
    throw invalidInput(
      "Local repaint mask dimensions must match the source image.",
    );
  }
  const maskPixels = Buffer.from(maskResult.data);
  if (!maskPixels.some((value) => value >= 8)) {
    throw invalidInput("Local repaint mask is empty.");
  }

  const providerMaskPixels = Buffer.alloc(maskPixels.length * 4);
  for (let index = 0; index < maskPixels.length; index += 1) {
    const offset = index * 4;
    providerMaskPixels[offset] = 255;
    providerMaskPixels[offset + 1] = 255;
    providerMaskPixels[offset + 2] = 255;
    providerMaskPixels[offset + 3] = 255 - maskPixels.readUInt8(index);
  }

  const width = sourceMetadata.width;
  const height = sourceMetadata.height;
  const [sourcePng, providerMaskPng] = await Promise.all([
    sharp(source).toColourspace("srgb").ensureAlpha().png().toBuffer(),
    sharp(providerMaskPixels, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer(),
  ]);
  const sourceStats = await sharp(sourcePng).stats();
  const background = sourceStats.channels[3]!.min < 255 ? "transparent" : "opaque";
  return { width, height, sourcePng, providerMaskPng, maskPixels, background };
}

/** Source pixels, not conversation history or the mere presence of an alpha
 * channel, determine the output background for this image editing tool. */
export function localRepaintRequest(prepared: PreparedLocalRepaint, instruction: string) {
  return {
    prompt: [
      "Edit the provided source image in place. The separate mask's transparent pixels mark the region to modify; opaque mask pixels must remain unchanged. The mask is not image content: never draw the mask or fill it with black.",
      "Apply the user's instruction only within the marked region. Preserve the original composition, alignment, scale, and visual style. For text replacement, replace the selected text with the requested text and preserve its typography unless instructed otherwise. Do not move or rescale the whole image.",
      prepared.background === "transparent"
        ? "The source is a transparent layer. Return a PNG with real alpha transparency, retaining the transparent background. Do not add a solid background, checkerboard, or black fill. Allow the modified subject to have its new silhouette within the mask."
        : "The source is opaque. Return an opaque image retaining its background; do not introduce transparency.",
      `User's local edit instruction: ${instruction}`,
    ].join("\n"),
    background: prepared.background,
    outputFormat: "png" as const,
    inputImages: [`data:image/png;base64,${prepared.sourcePng.toString("base64")}`],
    maskImage: `data:image/png;base64,${prepared.providerMaskPng.toString("base64")}`,
  };
}

/**
 * Providers may redraw outside the requested region or return another size.
 * Re-compose against the original pixels so mask=0 remains byte-identical.
 *
 * A differently shaped frame cannot be spliced into the source frame without
 * either warping the painted patch (stretch) or moving it (letterbox), so it is
 * refused the same way the outpaint compose refuses one. The provider bytes are
 * archived before this runs, so refusing never causes another paid call.
 *
 * The 2% bound is measured, not arbitrary: the native size resolver
 * (`resolveNativeImageSize`) itself snaps a requested ratio onto a 16px grid with
 * up to 1% error, and a real 900x1200 repaint was served at 880x1184 - a 0.90%
 * shape difference. A 1% guard would sit exactly on the pipeline's own noise
 * floor and could refuse a paid result for an invisible difference, while the
 * mismatches worth refusing (an orientation-only size such as 3:2 for a 16:9
 * source, or a square answer for a wide image) are an order of magnitude larger.
 */
export async function composeLocalRepaint(
  prepared: PreparedLocalRepaint,
  generated: Buffer,
): Promise<Buffer> {
  const generatedMetadata = await sharp(generated).metadata();
  if (!generatedMetadata.width || !generatedMetadata.height) {
    throw invalidInput("Local repaint provider image has no readable dimensions.");
  }
  const generatedRatio = generatedMetadata.width / generatedMetadata.height;
  if (Math.abs(generatedRatio / (prepared.width / prepared.height) - 1) > 0.02) {
    throw Object.assign(
      new Error(
        `局部重绘返回的图片尺寸 ${generatedMetadata.width}x${generatedMetadata.height} 与选区所在图片 ${prepared.width}x${prepared.height} 的比例不一致。为避免在选区内产生拉伸或错位，本次没有合成结果；供应商原始结果已保存，已扣费的积分会自动退回。请换用输出尺寸与该图片比例匹配的模型（例如 gpt-image-2）后重试。`,
      ),
      { code: "local_repaint_geometry_mismatch" },
    );
  }
  const [sourcePixels, generatedPixels] = await Promise.all([
    sharp(prepared.sourcePng).ensureAlpha().raw().toBuffer(),
    // Matching shapes have already been proven above, so `fill` maps the model's
    // frame onto the source frame proportionally: the patch keeps the position
    // the model drew it at. `contain` would move it and `cover` would crop it.
    sharp(generated)
      .resize(prepared.width, prepared.height, { fit: "fill" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer(),
  ]);
  const output = Buffer.alloc(sourcePixels.length);
  for (let index = 0; index < prepared.maskPixels.length; index += 1) {
    const weight = prepared.maskPixels.readUInt8(index);
    const offset = index * 4;
    if (weight === 0) {
      sourcePixels.copy(output, offset, offset, offset + 4);
      continue;
    }
    if (weight === 255 && prepared.background === "transparent") {
      generatedPixels.copy(output, offset, offset, offset + 4);
      continue;
    }
    const mix = weight / 255;
    const sourceAlpha = sourcePixels[offset + 3]! / 255;
    const generatedAlpha = generatedPixels[offset + 3]! / 255;
    // Transparent RGB values are arbitrary. Blend premultiplied colors so
    // invisible black pixels cannot create dark mask-edge fringes.
    const generatedContribution = mix * generatedAlpha;
    const sourceContribution = prepared.background === "opaque"
      ? 1 - generatedContribution
      : (1 - mix) * sourceAlpha;
    const alpha = sourceContribution + generatedContribution;
    for (let channel = 0; channel < 3; channel += 1) {
      output[offset + channel] = alpha > 0 ? Math.round(
        (sourcePixels[offset + channel]! * sourceContribution + generatedPixels[offset + channel]! * generatedContribution) / alpha,
      ) : 0;
    }
    output[offset + 3] = Math.round(alpha * 255);
  }
  return sharp(output, {
    raw: { width: prepared.width, height: prepared.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
