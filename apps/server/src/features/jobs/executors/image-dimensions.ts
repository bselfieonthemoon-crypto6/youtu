import sharp from 'sharp';

/** Provider size fields can describe requested size rather than returned pixels. */
export async function readImageDimensions(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Generated image has no readable dimensions');
  return { width: metadata.width, height: metadata.height };
}
