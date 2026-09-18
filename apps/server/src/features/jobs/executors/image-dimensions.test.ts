import sharp from 'sharp';
import { expect, it } from 'vitest';
import { assertImageAspectRatio, readImageDimensions } from './image-dimensions.js';

it('uses actual rectangular pixels, not requested square dimensions', async () => {
  const bytes = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();
  expect(await readImageDimensions(bytes)).toEqual({ width: 1536, height: 1024 });
});

it('rejects undecodable image data before persistence', async () => {
  await expect(readImageDimensions(Buffer.from('not an image'))).rejects.toThrow();
});

it('accepts normal pixel rounding but rejects a 2:3 image requested as 4:5', () => {
  expect(() => assertImageAspectRatio({ width: 799, height: 1000 }, '4:5')).not.toThrow();
  expect(() => assertImageAspectRatio({ width: 1024, height: 1536 }, '4:5')).toThrow(expect.objectContaining({
    code: 'image_aspect_ratio_mismatch',
  }));
});
