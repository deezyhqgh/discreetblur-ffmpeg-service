/**
 * compositeBlur.js
 *
 * Core function: given a source image buffer and a mask (white = blur this area,
 * black = leave untouched), produce an output image where only the masked region
 * is blurred, with a soft feathered edge so it doesn't look like a harsh
 * rectangle/cutout.
 *
 * Approach:
 *  1. Blur the FULL source image heavily (this is cheap and avoids ever
 *     needing to find exact pixel boundaries by hand).
 *  2. Feather the mask itself (blur the mask a little) so the transition
 *     between sharp and blurred regions is smooth, not a hard edge.
 *  3. Use the feathered mask as an alpha channel to composite:
 *     final = blurred * mask + original * (1 - mask)
 *
 * This is the same technique used in professional video editing tools for
 * "tracked blur" effects.
 */

const sharp = require('sharp');

/**
 * @param {Buffer} sourceBuffer - raw image bytes (the original frame/photo)
 * @param {Buffer} maskBuffer - raw image bytes, same dimensions as source.
 *        White/light pixels = region to blur. Black = leave alone.
 *        Can be grayscale or RGBA; we normalize it.
 * @param {Object} opts
 * @param {number} opts.blurStrength - gaussian sigma for the blur itself.
 *        Roughly: 15-25 = light/medium blur, 30-50 = heavy/strong blur.
 *        Default 35 (strong enough to be unambiguous for moderation purposes).
 * @param {number} opts.featherPixels - how soft the mask edge is, in pixels.
 *        Default 8. Higher = softer transition.
 * @returns {Promise<Buffer>} composited PNG buffer at original resolution
 */
async function compositeBlurOnFrame(sourceBuffer, maskBuffer, opts = {}) {
  const blurStrength = opts.blurStrength ?? 35;
  const featherPixels = opts.featherPixels ?? 8;

  const sourceImg = sharp(sourceBuffer);
  const sourceMeta = await sourceImg.metadata();
  const { width, height } = sourceMeta;

  if (!width || !height) {
    throw new Error('Could not read source image dimensions');
  }

  // Normalize the mask: resize to exactly match source dimensions (in case
  // SAM2 returned a mask at a slightly different resolution), convert to
  // single-channel grayscale, and feather it with a light blur so edges
  // are soft rather than a hard cutout.
  const normalizedMask = await sharp(maskBuffer)
    .resize(width, height, { fit: 'fill' })
    .grayscale()
    .blur(featherPixels)
    .raw()
    .toBuffer();

  // Produce a fully blurred version of the entire source image.
  const blurredFull = await sourceImg
    .clone()
    .blur(blurStrength)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sharpFull = await sharp(sourceBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: blurredData } = blurredFull;
  const { data: sharpData, info } = sharpFull;
  const channels = info.channels; // expect 4 (RGBA)

  const output = Buffer.alloc(sharpData.length);

  // Manual per-pixel alpha blend: output = blurred*maskAlpha + sharp*(1-maskAlpha)
  // normalizedMask is single-channel (grayscale), one byte per pixel, 0-255.
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const maskAlpha = normalizedMask[pixelIndex] / 255; // 0 = keep sharp, 1 = fully blurred
    const base = pixelIndex * channels;

    for (let c = 0; c < channels; c++) {
      if (c === 3) {
        // alpha channel - keep fully opaque (preserve original transparency
        // handling isn't a concern for photos/video frames, which are opaque)
        output[base + c] = sharpData[base + c];
        continue;
      }
      const blurredVal = blurredData[base + c];
      const sharpVal = sharpData[base + c];
      output[base + c] = Math.round(blurredVal * maskAlpha + sharpVal * (1 - maskAlpha));
    }
  }

  // Re-encode as PNG to avoid any additional lossy compression at this stage
  // (final video re-encoding settings are handled separately in the ffmpeg step)
  return sharp(output, { raw: { width, height, channels } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

module.exports = { compositeBlurOnFrame };
