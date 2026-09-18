import sharp from 'sharp';

/** Provider size fields can describe requested size rather than returned pixels. */
export async function readImageDimensions(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Generated image has no readable dimensions');
  return { width: metadata.width, height: metadata.height };
}

/** Reject provider output that would have to be stretched, cropped or padded. */
export function assertImageAspectRatio(
  dimensions: { width: number; height: number },
  expected: string,
  tolerance = 0.01,
) {
  const parts = expected.split(':');
  const [expectedWidth, expectedHeight] = parts.map(Number);
  if (parts.length !== 2 || !Number.isFinite(expectedWidth) || !Number.isFinite(expectedHeight) ||
    !(expectedWidth! > 0) || !(expectedHeight! > 0)) {
    throw Object.assign(new Error(`Invalid requested image aspect ratio: ${expected}`), { code: 'invalid_input' });
  }
  const expectedValue = expectedWidth! / expectedHeight!;
  const actualValue = dimensions.width / dimensions.height;
  const relativeError = Math.abs(actualValue - expectedValue) / expectedValue;
  if (relativeError > tolerance) {
    throw Object.assign(new Error(
      `生成图片实际尺寸 ${dimensions.width}x${dimensions.height} 与请求比例 ${expected} 不一致；未裁切、补边、拉伸或发布该图片。已保存供应商原始结果，不会自动重复付费生成。`,
    ), { code: 'image_aspect_ratio_mismatch' });
  }
}
