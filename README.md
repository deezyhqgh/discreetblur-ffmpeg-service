# DiscreetBlur — FFmpeg Blur Service

This is the standalone service that does the actual pixel-level blur work for
the DiscreetBlur app. It receives a job from your Supabase Edge Function,
downloads the source image/video plus the SAM2 mask data, applies a tracked,
feathered blur, re-encodes the result at near-original quality, and **sends
the finished file back to a Supabase Edge Function** which handles saving it
to Storage and updating the `jobs` table.

This runs as its own deployed service because Supabase Edge Functions (Deno)
cannot execute the FFmpeg binary — this service is plain Node.js + FFmpeg in
a Docker container, deployable on Railway, Render, Fly.io, or any host that
supports Docker.

## Important: this service holds NO Supabase credentials

Lovable Cloud does not expose your Supabase service-role key to outside
services — that's correct, intentional security behavior, not a bug. So this
service never touches your database or Storage directly. Instead:

1. Lovable's edge function sends this service a job (source file + mask data)
2. This service does the blur work
3. This service POSTs the finished file to a callback URL (another edge
   function you build in Lovable, called e.g. `ffmpeg-callback`)
4. THAT edge function — running inside Supabase, where it already has
   service-role access — uploads the result to Storage and updates the
   `jobs` row

This service only ever needs two settings: `SERVICE_SECRET` and `CALLBACK_URL`.
No database URL, no service-role key, nothing Supabase-specific at all.

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
- Request validation (rejects incomplete job payloads with a clear 400 error)
- The full callback flow: ran a real job against a stand-in edge function and
  confirmed the finished file arrives correctly with the right auth header,
  job_id, and status fields
- The failure path: confirmed a failed job correctly POSTs status=failed
  with a readable error message to the callback URL, with no file attached

What has NOT been tested here (since it requires your real, deployed Lovable
project): the actual live call to a real ffmpeg-callback edge function.
Test that once both sides are deployed, using a real job from the app.

## 1. Deploy to Railway (recommended, simplest path)

1. Push this folder to its own GitHub repo (or a subfolder of an existing one).
2. Go to https://railway.app, sign in, click New Project then Deploy from GitHub repo.
3. Select this repo. Railway will detect the Dockerfile automatically and build it.
4. Once deployed, go to the service's Settings then Networking and click
   Generate Domain to get a public URL, e.g. https://your-service.up.railway.app
   This URL is what you'll paste into Lovable as FFMPEG_SERVICE_URL.
5. Go to Variables and add:
   - SERVICE_SECRET — make up any long random string. Use the SAME value in Lovable's FFMPEG_SERVICE_SECRET field.
   - CALLBACK_URL — the URL of the ffmpeg-callback edge function (see Part 2 below). It'll look like https://your-project.supabase.co/functions/v1/ffmpeg-callback
6. Railway will redeploy automatically when you save variables.
7. Test it's alive: visit https://your-service.up.railway.app/health — you should see {"status":"ok"}

## 2. Ask Lovable to build the ffmpeg-callback edge function

This is the piece that lives on Lovable's side and actually has database
access. Tell Lovable something like this:

"Create a new Supabase Edge Function called ffmpeg-callback. It should:
- Require a header x-service-secret matching a secret stored as
  FFMPEG_SERVICE_SECRET (reject with 401 if missing or wrong)
- Accept multipart/form-data with fields: job_id (string), status
  (string, either complete or failed), error_message (string,
  optional), and file (the binary file, only present when status is
  complete)
- If status is complete: upload the file to the results Storage bucket
  at path {job_id}/output.mp4 or {job_id}/output.png depending on the
  file's content type, then update the jobs table row where id = job_id,
  setting status = complete and result_file_url = that storage path
- If status is failed: update the jobs table row where id = job_id,
  setting status = failed and error_message = the provided error_message
- Return a simple JSON success response in either case"

Once that's built, copy its URL (Lovable/Supabase will show you the deployed
function's URL) — that's your CALLBACK_URL for Railway's Variables, step 5
above.

## 3. What to paste into Lovable

- FFMPEG_SERVICE_URL -> the Railway-generated domain
- FFMPEG_SERVICE_SECRET -> the same value you set for SERVICE_SECRET in Railway
- Lovable's own edge function that calls /apply-blur also needs to know
  this service's URL and secret -- same two values, just used on the
  outbound side

## 4. API contract, inbound (what Lovable's edge function sends here)

POST {FFMPEG_SERVICE_URL}/apply-blur
Header: x-service-secret: {FFMPEG_SERVICE_SECRET}

For an image job:
{
  "job_id": "uuid-of-the-row-in-the-jobs-table",
  "file_type": "image",
  "source_url": "https://signed-url-to-original-file",
  "mask_url": "https://signed-url-to-the-mask-image",
  "blur_strength": 35,
  "feather_pixels": 8
}

For a video job:
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

This service responds immediately with 202 {"status":"accepted","job_id":"..."}
and does the actual work in the background.

## 5. API contract, outbound (what this service sends to CALLBACK_URL)

POST {CALLBACK_URL}
Header: x-service-secret: {SERVICE_SECRET}
Body: multipart/form-data with fields:

- On success: job_id, status=complete, file (the actual finished video/image)
- On failure: job_id, status=failed, error_message

## 6. A note on mask data from fal.ai

This service expects masks as downloadable image URLs (white = blur this
area, black = leave alone), one per video frame, or one for a single image.
Check what shape fal.ai's SAM2 video endpoint actually returns when you wire
it up -- if it returns mask data as something other than per-frame image URLs
(e.g. RLE-encoded arrays or only keyframe masks), Lovable's edge function
needs to convert that into the frame_masks array shape shown above before
calling /apply-blur. This service has a built-in fallback: if a frame has
no mask provided, it reuses the most recent known mask rather than leaving
that frame unblurred, as a safety default for this use case.

## 7. Local development

npm install
cp .env.example .env   (then fill in real values)
npm start

Requires ffmpeg and ffprobe installed locally (not needed if only running
via Docker/Railway, which installs it automatically per the Dockerfile).
