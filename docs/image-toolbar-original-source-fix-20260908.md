# Image toolbar original-source repair — 2026-09-08

## Confirmed failure

The real local canvas region-matting request submitted a 390×390 WebP even
though its source was a 1024×1024 PNG. Pixel comparison found mean absolute
error 1.286 against the source's top-left crop, versus 82.872 against the
whole source resized to 390×390. Missing intrinsic dimensions caused display
dimensions to be used as source coordinates.

## Changes

- Preserve the current asset binding on hydrated Excalidraw files. Display
  previews remain lightweight; operations download the original via the
  authenticated content endpoint without `preview=1`.
- Resolve source identity from the current file before inherited element
  metadata. A new inline crop/edit must not revert to an older asset.
- Decode intrinsic dimensions for processing. Remap existing preview-space
  crops to original coordinates; preserve reflections without baking rotation
  into a padded bounding-box image.
- Share source preparation across remove-background, split-layers,
  region-matting, erasing, regeneration, upscale, text recognition/replacement,
  crop export and download. Image and erase mask use matching source dimensions.
- Original download failures are reported instead of silently using a preview.
- Cropped exports are lossless PNGs and retain independent file identities.

## Verification

- 34 related web unit/component tests passed, including 8 new source-resolution
  cases; TypeScript check passed.
- 3 Chromium tests passed against the running local replica: upload/navigation
  persistence plus ordinary-upload and asset-preview toolbar scenarios.
- Real browser requests for remove-background, split-layers, region-matting and
  transparent erase contained bytes identical to the original fixture, even
  after reload and at 390-pixel display size. Asset fixture was 1536×1536,
  exceeding the 1280-pixel preview bound; ordinary upload was 1024×1024.
- Erase mask dimensions matched the original. Downloads matched original bytes.
  Subsequent processing of a local crop matched expected source-crop pixels.

Browser generation requests were intercepted at submission to inspect inputs;
these tests do not re-evaluate model output quality or incur generation charges.
No model weights, decomposition algorithm, user canvas contents, or database
schema were changed in this repair. New browser fixtures use isolated projects.
