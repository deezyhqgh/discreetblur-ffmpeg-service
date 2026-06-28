/**
 * callbackClient.js
 *
 * Replaces the old direct-Supabase integration. This service no longer holds
 * any Supabase credentials at all (Lovable Cloud does not expose the
 * service-role key to outside services, which is correct security practice).
 *
 * Instead, once a job finishes, this service sends the result back to a
 * Supabase Edge Function ("ffmpeg-callback") that you build inside Lovable.
 * That edge function already has the service-role key internally (it runs
 * inside Supabase), so IT does the Storage upload and the jobs-table update.
 * This service's only job is to do the blur work and hand the finished file
 * back over HTTP, authenticated with the same shared secret used for the
 * inbound /apply-blur request.
 */

const fs = require('fs/promises');
const fetch = require('node-fetch');
const FormData = require('form-data');

const CALLBACK_URL = process.env.CALLBACK_URL;
const SERVICE_SECRET = process.env.SERVICE_SECRET;

function assertConfigured() {
  if (!CALLBACK_URL || !SERVICE_SECRET) {
    throw new Error('CALLBACK_URL and SERVICE_SECRET must both be set as environment variables');
  }
}

/**
 * Sends the completed file to the Supabase edge function for storage +
 * job-status update.
 *
 * @param {Object} params
 * @param {string} params.jobId
 * @param {string} params.localFilePath - path to the finished blurred file
 * @param {string} params.fileName - e.g. "output.mp4" or "output.png"
 * @param {string} params.contentType - e.g. "video/mp4" or "image/png"
 */
async function reportSuccess({ jobId, localFilePath, fileName, contentType }) {
  assertConfigured();

  const fileBuffer = await fs.readFile(localFilePath);

  const form = new FormData();
  form.append('job_id', jobId);
  form.append('status', 'complete');
  form.append('file', fileBuffer, { filename: fileName, contentType });

  const res = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: {
      'x-service-secret': SERVICE_SECRET,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Callback to edge function failed (${res.status}): ${text}`);
  }
}

/**
 * Reports a failed job back to the edge function so it can mark the jobs
 * row as failed with a readable error message. No file is sent in this case.
 */
async function reportFailure({ jobId, errorMessage }) {
  if (!CALLBACK_URL || !SERVICE_SECRET) {
    console.error(
      `CRITICAL: cannot report failure for job ${jobId} - CALLBACK_URL/SERVICE_SECRET not configured. Error was: ${errorMessage}`
    );
    return;
  }

  try {
    const form = new FormData();
    form.append('job_id', jobId);
    form.append('status', 'failed');
    form.append('error_message', String(errorMessage).slice(0, 1000));

    const res = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'x-service-secret': SERVICE_SECRET,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`CRITICAL: failure-callback itself failed (${res.status}) for job ${jobId}: ${text}`);
    }
  } catch (e) {
    // If even reporting the failure fails (e.g. network down), log loudly.
    // The job will appear stuck as "processing" to the user, which is the
    // worst case here, but at least it's visible in these logs.
    console.error(`CRITICAL: could not reach callback URL to report failure for job ${jobId}:`, e);
  }
}

module.exports = { reportSuccess, reportFailure };
