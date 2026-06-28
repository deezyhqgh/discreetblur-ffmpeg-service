# DiscreetBlur — FFmpeg Blur Service

This is the standalone service that does the actual pixel-level blur work for
the DiscreetBlur app. It receives a job from your Supabase Edge Function,
downloads the source image/video plus the SAM2 mask data, applies a tracked,
feathered blur, re-encodes the result at near-original quality, uploads it to
Supabase Storage, and updates the `jobs` table.

This runs as its own deployed service because Supabase Edge Functions (Deno)
cannot execute the FFmpeg binary — this service is plain Node.js + FFmpeg in
a Docker container, deployable on Railway, Render, Fly.io, or any host that
supports Docker.

## What's been tested

This codebase has been verified end-to-end on:
- Image blur compositing (feathered mask edges, no harsh cutout)
- Video blur compositing across many frames with a MOVING mask (confirms
  tracked blur correctly follows a moving subject across frames)
- Frame count, resolution, frame rate, and duration of output exactly match
  the source video (no quality-affecting resampling)
- Audio passthrough (stream-copied, not re-encoded, so audio quality is
  unaffected)
- Auth middleware (rejects requests without the correct `x-service-secret`)
- Request validation (rejects incomplete job payloads with a clear 400 error)
- Graceful failure handling (a failed job updates the `jobs` table with
  `status: 'failed'` and a readable error message rather than hanging forever
  or crashing the service)

What has NOT been tested here (since it requires real credentials): the
actual live calls to fal.ai and to your real Supabase project. Test those
once deployed, using a real job from the app.

## 1. Deploy to Railway (recommended — simplest path)

1. Push this folder to its own GitHub repo (or a subfolder of an existing one).
2. Go to https://railway.app, sign in, click **New Project → Deploy from GitHub repo**.
3. Select this repo. Railway will detect the `Dockerfile` automatically and build it.
4. Once deployed, go to the service's **Settings → Networking** and click
   **Generate Domain** to get a public URL, e.g. `https://your-service.up.railway.app`.
   This URL is what you'll paste into Lovable as `FFMPEG_SERVICE_URL`.
5. Go to **Variables** and add the following (see `.env.example` for descriptions):
   - `SERVICE_SECRET` — make up any long random string. Use the SAME value in Lovable's `FFMPEG_SERVICE_SECRET` field.
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Dashboard → Project Settings → API → `service_role` secret (NOT the public anon key)
   - `SUPABASE_RESULTS_BUCKET` — defaults to `results` if not set
6. Railway will redeploy automatically when you save variables. Check the
   **Deployments → Logs** tab — you should see:
   `DiscreetBlur FFmpeg service listening on port 8080`
7. Test it's alive: visit `https://your-service.up.railway.app/health` in a
   browser — you should see `{"status":"ok"}`.

## 2. What to paste into Lovable

- `FFMPEG_SERVICE_URL` → the Railway-generated domain from step 4 above
- `FFMPEG_SERVICE_SECRET` → the same value you set for `SERVICE_SECRET` in Railway

## 3. API contract (what the Supabase Edge Function should send)

`POST {FFMPEG_SERVICE_URL}/apply-blur`
Header: `x-service-secret: {FFMPEG_SERVICE_SECRET}`

```json
{
  "job_id": "uuid-of-the-row-in-the-jobs-table",
  "file_type": "image",
  "source_url": "https://signed-url-to-original-file",
  "mask_url": "https://signed-url-to-the-mask-image",
  "blur_strength": 35,
  "feather_pixels": 8
}
```

or for video:

```json
{
  "job_id": "uuid-of-the-row-in-the-jobs-table",
  "file_type": "video",
  "source_url": "https://signed-url-to-original-video",
  "frame_masks": [
    { "frame_index": 0, "mask_url": "https://..." },
    { "frame_index": 1, "mask_url": "https://..." }
  ],
  "blur_strength": 35,
  "feather_pixels": 8
}
```

The service responds immediately with `202 { "status": "accepted", "job_id": "..." }`
and does the actual work in the background. When done, it writes the result
to the `results` Storage bucket at `{job_id}/output.png` or `{job_id}/output.mp4`,
and updates the `jobs` row:
- `status = 'complete'`, `result_file_url = '{job_id}/output.mp4'` on success
- `status = 'failed'`, `error_message = '...'` on failure

Your frontend should keep polling the `jobs` table (as already planned in
the Lovable prompt) and build a signed download URL from `result_file_url`
once `status = 'complete'`.

## 4. A note on mask data from fal.ai

This service expects masks as downloadable image URLs (white = blur this
area, black = leave alone), one per video frame, or one for a single image.
Check what shape fal.ai's SAM2 video endpoint actually returns when you wire
it up — if it returns mask data as something other than per-frame image URLs
(e.g. RLE-encoded arrays or only keyframe masks), the Edge Function calling
this service needs to convert that into the `frame_masks` array shape shown
above before calling `/apply-blur`. This service has a built-in fallback: if
a frame has no mask provided, it reuses the most recent known mask rather
than leaving that frame unblurred, as a safety default for this use case.

## 5. Local development

```bash
npm install
cp .env.example .env   # then fill in real values
npm start
```

Requires `ffmpeg` and `ffprobe` installed locally (not needed if only running
via Docker/Railway, which installs it automatically per the Dockerfile).
