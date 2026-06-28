/**
 * processVideo.js
 *
 * Pipeline for video jobs:
 *  1. Probe the source video for exact fps, resolution, duration (so output
 *     matches input precisely - this matters for the "no quality loss" goal).
 *  2. Extract every frame as a lossless PNG sequence.
 *  3. For each frame, run compositeBlurOnFrame() using that frame's mask
 *     (masks come in per-frame from SAM2's video tracking output).
 *  4. Reassemble the blurred frame sequence into a video at the exact
 *     original fps, using a high-quality, low-CRF encode.
 *  5. Mux the original audio track back in untouched (stream copy, not
 *     re-encoded) so audio quality is unaffected.
 *
 * Notes on quality:
 *  - We never resample/downscale resolution at any point.
 *  - CRF 17 with preset "slow" is visually indistinguishable from source for
 *    almost all real-world footage while still producing a sane file size.
 *    (CRF 0 is technically lossless but produces enormous files - 17 is the
 *    accepted "perceptually lossless" practical threshold.)
 */

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const { compositeBlurOnFrame } = require('./compositeBlur');

function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');
      if (!videoStream) return reject(new Error('No video stream found in source file'));

      // fps can come as "30/1" or "29.97" depending on container - normalize it
      let fps = 30;
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
        if (den) fps = num / den;
      }

      resolve({
        width: videoStream.width,
        height: videoStream.height,
        fps,
        hasAudio: !!audioStream,
        durationSeconds: parseFloat(data.format.duration || '0'),
      });
    });
  });
}

function extractFrames(inputPath, framesDir) {
  // Deliberately do NOT pass a target fps here. "-vsync 0" (a.k.a. -fps_mode passthrough)
  // tells ffmpeg to write out every decoded frame exactly as stored, with no
  // resampling/duplication/dropping. Combining -vsync 0 with a forced -r (which
  // is what .fps() adds) is contradictory and ffmpeg will refuse to run - confirmed
  // by direct testing. Extracting at native timing is also the right choice for
  // the "no quality loss" goal: we never want to resample frame rate.
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(path.join(framesDir, 'frame-%06d.png'))
      .outputOptions(['-vsync', '0'])
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function reassembleVideo({ framesDir, fps, outputPath, audioSourcePath, hasAudio }) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(path.join(framesDir, 'blurred-%06d.png'))
      .inputFPS(fps);

    if (hasAudio && audioSourcePath) {
      command.input(audioSourcePath);
    }

    command
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '17',           // visually near-lossless
        '-pix_fmt', 'yuv420p',  // broad compatibility
        ...(hasAudio ? ['-c:a', 'copy', '-map', '0:v:0', '-map', '1:a:0'] : []),
        // Note: deliberately NOT using -shortest here. Since the frame
        // sequence is extracted from the same source as the audio, durations
        // already match - -shortest was found (via direct testing) to cause
        // ffmpeg to truncate 1-2 trailing frames due to audio-boundary
        // rounding, which is exactly the quality/fidelity loss we want to avoid.
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * @param {string} videoUrl - signed URL to the original source video
 * @param {Array<{frameIndex: number, maskUrl: string}>} frameMasks - one entry
 *        per frame that should be processed; maskUrl points to a PNG/grayscale
 *        mask image for that exact frame, same dimensions as the video.
 * @param {string} workDir - scratch directory unique to this job (caller creates
 *        and cleans this up)
 * @param {Object} blurOpts - { blurStrength, featherPixels } passed through
 * @returns {Promise<string>} path to the final output video file
 */
async function processVideo({ videoUrl, frameMasks, workDir, blurOpts }) {
  const inputPath = path.join(workDir, 'source.mp4');
  const framesDir = path.join(workDir, 'frames');
  const outputPath = path.join(workDir, 'output.mp4');

  await fs.mkdir(framesDir, { recursive: true });

  // Download source video (supports both remote URLs and local file paths,
  // the latter mainly useful for local testing without a running HTTP server)
  if (videoUrl.startsWith('http://') || videoUrl.startsWith('https://')) {
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`);
    await fs.writeFile(inputPath, await videoRes.buffer());
  } else {
    await fs.copyFile(videoUrl, inputPath);
  }

  const { fps, hasAudio, width, height } = await probeVideo(inputPath);

  // Extract every frame at the source's native timing - keeps frame count and
  // timing exactly matched to the original (no resampling)
  await extractFrames(inputPath, framesDir);

  const extractedFrames = (await fs.readdir(framesDir))
    .filter((f) => f.startsWith('frame-'))
    .sort();

  // Build a quick lookup: frameIndex -> maskUrl
  const maskByFrame = new Map();
  for (const fm of frameMasks) {
    maskByFrame.set(fm.frameIndex, fm.maskUrl);
  }

  // Cache downloaded mask buffers so we don't re-fetch the same mask URL
  // repeatedly if SAM2 returned fewer masks than frames (e.g. it only
  // returns masks at keyframes and expects interpolation - in that case
  // we hold the most recent mask steady, which is a safe fallback)
  const maskBufferCache = new Map();
  let lastMaskBuffer = null;

  for (let i = 0; i < extractedFrames.length; i++) {
    const frameFile = extractedFrames[i];
    const frameIndex = i; // 0-based, matches extraction order
    const framePath = path.join(framesDir, frameFile);
    const frameBuffer = await fs.readFile(framePath);

    let maskBuffer;
    const maskUrl = maskByFrame.get(frameIndex);

    if (maskUrl) {
      if (maskBufferCache.has(maskUrl)) {
        maskBuffer = maskBufferCache.get(maskUrl);
      } else if (maskUrl.startsWith('http://') || maskUrl.startsWith('https://')) {
        const maskRes = await fetch(maskUrl);
        if (!maskRes.ok) {
          throw new Error(`Failed to download mask for frame ${frameIndex}: ${maskRes.status}`);
        }
        maskBuffer = await maskRes.buffer();
        maskBufferCache.set(maskUrl, maskBuffer);
      } else {
        maskBuffer = await fs.readFile(maskUrl);
        maskBufferCache.set(maskUrl, maskBuffer);
      }
      lastMaskBuffer = maskBuffer;
    } else if (lastMaskBuffer) {
      // No mask for this exact frame index - reuse the last known mask
      // rather than leaving the frame completely unblurred (safer default
      // for a sensitive-content use case: when in doubt, keep blurring)
      maskBuffer = lastMaskBuffer;
    } else {
      // No mask data at all yet (shouldn't normally happen) - skip blur
      // for this frame only, leave it untouched, but log it so it's visible
      // in service logs for debugging.
      console.warn(`No mask available for frame ${frameIndex}, leaving unblurred`);
      const outFramePath = path.join(framesDir, `blurred-${String(i + 1).padStart(6, '0')}.png`);
      await fs.writeFile(outFramePath, frameBuffer);
      continue;
    }

    const blurredFrame = await compositeBlurOnFrame(frameBuffer, maskBuffer, blurOpts);
    const outFramePath = path.join(framesDir, `blurred-${String(i + 1).padStart(6, '0')}.png`);
    await fs.writeFile(outFramePath, blurredFrame);
  }

  await reassembleVideo({
    framesDir,
    fps,
    outputPath,
    audioSourcePath: hasAudio ? inputPath : null,
    hasAudio,
  });

  return outputPath;
}

module.exports = { processVideo, probeVideo };
