/**
 * server.js
 *
 * Entry point. Exposes:
 *
 *   GET  /health          - simple liveness check, no auth required
 *   POST /apply-blur      - main job endpoint, requires x-service-secret header
 *
 * Design: this endpoint responds 202 Accepted immediately after validating
 * the request, then does the actual (slow) frame extraction / blur / re-encode
 * work in the background. When finished, it POSTs the finished file to
 * whichever URL was given as `callback_url` in the request body - a Supabase
 * Edge Function that handles the actual Storage upload and jobs-table update
 * on its side. This service holds NO Supabase credentials and no fixed
 * callback URL setting at all: Lovable's edge functions compute the right
 * callback URL per-request and include it in the job payload, so Railway
 * never needs to know the Supabase project URL.
 *
 * Request body shape expected from the Supabase Edge Function:
 * {
 *   "job_id": "uuid",
 *   "file_type": "image" | "video",
 *   "source_url": "https://...",      // signed URL to original file
 *   "callback_url": "https://...",    // where to POST the finished result
 *   "blur_strength": 35,               // optional, default 35
 *   "feather_pixels": 8,               // optional, default 8
 *
 *   // for images:
 *   "mask_url": "https://...",         // signed URL to a single mask image
 *
 *   // for videos:
 *   "frame_masks": [
 *     { "frame_index": 0, "mask_url": "https://..." },
 *     { "frame_index": 1, "mask_url": "https://..." },
 *     ...
 *   ]
 * }
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

const { processImage } = require('./processImage');
const { processVideo } = require('./processVideo');
const { reportSuccess, reportFailure } = require('./callbackClient');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const SERVICE_SECRET = process.env.SERVICE_SECRET;
const TMP_ROOT = path.join(__dirname, 'tmp');

// --- Auth middleware for all job-submitting routes ---
function requireServiceSecret(req, res, next) {
  if (!SERVICE_SECRET) {
    console.error('SERVICE_SECRET is not configured on this deployment - refusing all requests');
    return res.status(500).json({ error: 'Service misconfigured' });
  }
  const provided = req.header('x-service-secret');
  if (!provided || provided !== SERVICE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/apply-blur', requireServiceSecret, async (req, res) => {
  const body = req.body || {};
  const { job_id, file_type, source_url, callback_url } = body;

  // --- Validate the request shape before accepting the job ---
  if (!job_id || !file_type || !source_url || !callback_url) {
    return res.status(400).json({
      error: 'job_id, file_type, source_url, and callback_url are required',
    });
  }
  if (file_type !== 'image' && file_type !== 'video') {
    return res.status(400).json({ error: 'file_type must be "image" or "video"' });
  }
  if (file_type === 'image' && !body.mask_url) {
    return res.status(400).json({ error: 'mask_url is required for image jobs' });
  }
  if (file_type === 'video' && (!Array.isArray(body.frame_masks) || body.frame_masks.length === 0)) {
    return res.status(400).json({ error: 'frame_masks (non-empty array) is required for video jobs' });
  }

  // Respond immediately - actual processing happens after this point,
  // asynchronously, so the caller (Supabase Edge Function) never times out
  // waiting on a long video job.
  res.status(202).json({ status: 'accepted', job_id });

  // Run the job in the background. Any error here is caught and reported
  // back to callback_url via reportFailure so the job never gets stuck
  // silently in "processing" forever.
  runJob(body).catch(async (err) => {
    console.error(`Job ${job_id} failed:`, err);
    await reportFailure({ callbackUrl: callback_url, jobId: job_id, errorMessage: err.message || String(err) });
  });
});

async function runJob(body) {
  const { job_id, file_type, source_url, mask_url, frame_masks, callback_url } = body;
  const blurOpts = {
    blurStrength: body.blur_strength ?? 35,
    featherPixels: body.feather_pixels ?? 8,
  };

  const workDir = path.join(TMP_ROOT, `${job_id}-${uuidv4()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    let localOutputPath;
    let fileName;
    let contentType;

    if (file_type === 'image') {
      localOutputPath = path.join(workDir, 'output.png');
      await processImage({
        imageUrl: source_url,
        maskUrl: mask_url,
        outputPath: localOutputPath,
        blurOpts,
      });
      fileName = 'output.png';
      contentType = 'image/png';
    } else {
      // video
      localOutputPath = await processVideo({
        videoUrl: source_url,
        frameMasks: frame_masks.map((fm) => ({
          frameIndex: fm.frame_index,
          maskUrl: fm.mask_url,
        })),
        workDir,
        blurOpts,
      });
      fileName = 'output.mp4';
      contentType = 'video/mp4';
    }

    // Hand the finished file to the callback URL given in this job's
    // payload - IT does the Storage upload and jobs-table update, since it
    // has the service-role key and this service deliberately does not.
    await reportSuccess({
      callbackUrl: callback_url,
      jobId: job_id,
      localFilePath: localOutputPath,
      fileName,
      contentType,
    });

    console.log(`Job ${job_id} completed successfully and was handed off to the callback`);
  } finally {
    // Always clean up the scratch directory for this job, success or failure,
    // so disk usage doesn't grow unbounded across many jobs.
    await fs.rm(workDir, { recursive: true, force: true }).catch((e) => {
      console.warn(`Could not clean up work dir ${workDir}:`, e.message);
    });
  }
}

async function ensureTmpRoot() {
  await fs.mkdir(TMP_ROOT, { recursive: true });
}

ensureTmpRoot().then(() => {
  app.listen(PORT, () => {
    console.log(`DiscreetBlur FFmpeg service listening on port ${PORT}`);
    if (!SERVICE_SECRET) {
      console.warn('WARNING: SERVICE_SECRET is not set - all requests will be rejected until it is configured.');
    }
  });
});
