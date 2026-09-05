import sharp from 'sharp';
import { expect, it } from 'vitest';
import { readImageDimensions } from './image-dimensions.js';

it('uses actual rectangular pixels, not requested square dimensions', async () => {
  const bytes = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();
  expect(await readImageDimensions(bytes)).toEqual({ width: 1536, height: 1024 });
});

it('rejects undecodable image data before persistence', async () => {
  await expect(readImageDimensions(Buffer.from('not an image'))).rejects.toThrow();
});
