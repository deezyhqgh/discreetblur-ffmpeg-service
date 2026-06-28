# DiscreetBlur — FFmpeg Blur Service

This is the standalone service that does the actual pixel-level blur work for
the DiscreetBlur app. It receives a job from your Supabase Edge Function,
downloads the source image/video plus the SAM2 mask data, applies a tracked,
feathered blur, re-encodes the result at near-original quality, and sends
the finished file back to whichever callback URL was included in that job's
request.

This runs as its own deployed service because Supabase Edge Functions (Deno)
cannot execute the FFmpeg binary — this service is plain Node.js + FFmpeg in
a Docker container, deployable on Railway, Render, Fly.io, or any host that
supports Docker.

## Architecture — this service needs ONLY one setting: SERVICE_SECRET

Lovable Cloud does not expose your Supabase service-role key or even your
Supabase project URL to outside services — that's correct, intentional
security behavior. So this service never touches your database directly,
and doesn't even need to know your Supabase URL as a fixed setting. Instead:

1. Lovable's edge function (`start-processing`, or `fal-webhook-handler` for
   video) sends this service a job: source file, mask data, AND a
   `callback_url` field computed fresh for that specific job
2. This service does the blur work
3. This service POSTs the finished file to whatever `callback_url` came with
   that job (a Supabase Edge Function called `ffmpeg-callback`)
4. That edge function — running inside Supabase, where it already has
   service-role access — uploads the result to Storage and updates the
   `jobs` row

This service holds no Supabase credentials and no fixed callback URL at all
— just `SERVICE_SECRET`, used both to authenticate incoming jobs and to
authenticate this service's own outgoing callback request.

## What's been tested

This codebase has been verified end-to-end on:
- Image blur compositing (feathered mask edges, no harsh cutout)
- Video blur compositing across many frames with a MOVING mask (confirms
  tracked blur correctly follows a moving subject across frames)
- Frame count, resolution, frame rate, and duration of output exactly match
  the source video (no quality-affecting resampling)
- Audio passthrough (stream-copied, not re-encoded, so audio quality is
  unaffected)
- Auth middleware (rejects requests without the correct x-service-secret)
- Request validation (rejects payloads missing job_id, file_type,
  source_url, or callback_url with a clear 400 error)
- The per-job callback routing: ran two simultaneous jobs each with a
  DIFFERENT callback_url and confirmed each one's result was correctly
  delivered to its own specific URL, not a shared/fixed one
- The failure path: confirmed a failed job correctly POSTs status=failed
  with a readable error message to that job's callback_url, with no file
  attached

What has NOT been tested here (since it requires your real, deployed Lovable
project): the actual live call to your real `ffmpeg-callback` edge function.
Test that once both sides are deployed, using a real job from the app.

## 1. Deploy to Railway

1. Push this folder to its own GitHub repo (or a subfolder of an existing one).
2. Go to https://railway.app, sign in, click New Project then Deploy from GitHub repo.
3. Select this repo. Railway will detect the Dockerfile automatically and build it.
4. Once deployed, go to the service's Settings then Networking and click
   Generate Domain to get a public URL, e.g. https://your-service.up.railway.app
   This URL is what you'll paste into Lovable as FFMPEG_SERVICE_URL.
5. Go to Variables and add just one:
   - SERVICE_SECRET — make up any long random string. Use the SAME value in Lovable's FFMPEG_SERVICE_SECRET field.
6. Railway will redeploy automatically when you save.
7. Test it's alive: visit https://your-service.up.railway.app/health — you should see {"status":"ok"}

That's it — no CALLBACK_URL, no SUPABASE_URL, no service-role key. Just the one secret.

## 2. What to paste into Lovable

- FFMPEG_SERVICE_URL -> the Railway-generated domain
- FFMPEG_SERVICE_SECRET -> the same value you set for SERVICE_SECRET in Railway

## 3. API contract, inbound (what Lovable's edge functions send here)

POST {FFMPEG_SERVICE_URL}/apply-blur
Header: x-service-secret: {FFMPEG_SERVICE_SECRET}

For an image job:
{
  "job_id": "uuid-of-the-row-in-the-jobs-table",
  "file_type": "image",
  "source_url": "https://signed-url-to-original-file",
  "mask_url": "https://signed-url-to-the-mask-image",
  "callback_url": "https://your-project.supabase.co/functions/v1/ffmpeg-callback",
  "blur_strength": 35,
  "feather_pixels": 8
}

For a video job:
{
  "job_id": "uuid-of-the-row-in-the-jobs-table",
  "file_type": "video",
  "source_url": "https://signed-url-to-original-video",
  "callback_url": "https://your-project.supabase.co/functions/v1/ffmpeg-callback",
  "frame_masks": [
    { "frame_index": 0, "mask_url": "https://..." },
    { "frame_index": 1, "mask_url": "https://..." }
  ],
  "blur_strength": 35,
  "feather_pixels": 8
}

This service responds immediately with 202 {"status":"accepted","job_id":"..."}
and does the actual work in the background.

## 4. API contract, outbound (what this service sends to callback_url)

POST {callback_url}    (the exact URL given in that job's request)
Header: x-service-secret: {SERVICE_SECRET}
Body: multipart/form-data with fields:

- On success: job_id, status=complete, file (the actual finished video/image)
- On failure: job_id, status=failed, error_message

## 5. A note on mask data from fal.ai

This service expects masks as downloadable image URLs (white = blur this
area, black = leave alone), one per video frame, or one for a single image.
Check what shape fal.ai's SAM2 video endpoint actually returns when you wire
it up -- if it returns mask data as something other than per-frame image URLs
(e.g. RLE-encoded arrays or only keyframe masks), Lovable's edge function
needs to convert that into the frame_masks array shape shown above before
calling /apply-blur. This service has a built-in fallback: if a frame has
no mask provided, it reuses the most recent known mask rather than leaving
that frame unblurred, as a safety default for this use case.

## 6. Local development

npm install
cp .env.example .env   (then fill in a value for SERVICE_SECRET)
npm start

Requires ffmpeg and ffprobe installed locally (not needed if only running
via Docker/Railway, which installs it automatically per the Dockerfile).
