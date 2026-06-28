/**
 * processImage.js
 *
 * Pipeline for image (photo) jobs - much simpler than video since there's
 * only one frame and no audio/fps/encoding concerns. Downloads the source
 * image and its single mask, runs the same compositeBlurOnFrame logic used
 * for video frames, and returns the result. Output is saved as a PNG to
 * avoid introducing JPEG compression artifacts on top of the original.
 */

const fs = require('fs/promises');
const fetch = require('node-fetch');
const { compositeBlurOnFrame } = require('./compositeBlur');

/**
 * @param {string} imageUrl - signed URL to the original source image
 * @param {string} maskUrl - signed URL to the mask image (white = blur)
 * @param {string} outputPath - where to write the final PNG
 * @param {Object} blurOpts - { blurStrength, featherPixels }
 * @returns {Promise<string>} outputPath
 */
async function processImage({ imageUrl, maskUrl, outputPath, blurOpts }) {
  const fetchOrRead = async (urlOrPath) => {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      const res = await fetch(urlOrPath);
      if (!res.ok) throw new Error(`Failed to download ${urlOrPath}: ${res.status}`);
      return res.buffer();
    }
    return fs.readFile(urlOrPath);
  };

  const [imageBuffer, maskBuffer] = await Promise.all([
    fetchOrRead(imageUrl),
    fetchOrRead(maskUrl),
  ]);

  const result = await compositeBlurOnFrame(imageBuffer, maskBuffer, blurOpts);
  await fs.writeFile(outputPath, result);

  return outputPath;
}

module.exports = { processImage };
