/**
 * callbackClient.js
 *
 * This service holds NO Supabase credentials and no fixed callback URL.
 * Lovable Cloud does not expose the service-role key to outside services
 * (correct security practice), and the callback URL itself is also no
 * longer a fixed setting - it's computed by Lovable's edge functions
 * (start-processing / fal-webhook-handler) on each request and passed in
 * as part of the job payload. This avoids needing to know/store the
 * Supabase project URL on Railway at all.
 *
 * Flow: each /apply-blur request includes a `callback_url` field. Once the
 * job finishes (or fails), this service POSTs the result directly to that
 * exact URL, authenticated with the same shared SERVICE_SECRET used for the
 * inbound request. The edge function on the other end already has the
 * service-role key internally, so IT does the Storage upload and the
 * jobs-table update.
 */

const fs = require('fs/promises');
const fetch = require('node-fetch');
const FormData = require('form-data');

const SERVICE_SECRET = process.env.SERVICE_SECRET;

function assertConfigured(callbackUrl) {
  if (!callbackUrl) {
    throw new Error('callback_url is required (expected in the job payload, got none)');
  }
  if (!SERVICE_SECRET) {
    throw new Error('SERVICE_SECRET must be set as an environment variable on this service');
  }
}

/**
 * Sends the completed file to the callback URL for storage + job-status update.
 *
 * @param {Object} params
 * @param {string} params.callbackUrl - where to POST the result (came from the job payload)
 * @param {string} params.jobId
 * @param {string} params.localFilePath - path to the finished blurred file
 * @param {string} params.fileName - e.g. "output.mp4" or "output.png"
 * @param {string} params.contentType - e.g. "video/mp4" or "image/png"
 */
async function reportSuccess({ callbackUrl, jobId, localFilePath, fileName, contentType }) {
  assertConfigured(callbackUrl);

  const fileBuffer = await fs.readFile(localFilePath);

  const form = new FormData();
  form.append('job_id', jobId);
  form.append('status', 'complete');
  form.append('file', fileBuffer, { filename: fileName, contentType });

  const res = await fetch(callbackUrl, {
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
 * Reports a failed job back to the callback URL so it can mark the jobs
 * row as failed with a readable error message. No file is sent in this case.
 *
 * @param {Object} params
 * @param {string} params.callbackUrl
 * @param {string} params.jobId
 * @param {string} params.errorMessage
 */
async function reportFailure({ callbackUrl, jobId, errorMessage }) {
  if (!callbackUrl || !SERVICE_SECRET) {
    console.error(
      `CRITICAL: cannot report failure for job ${jobId} - callback_url/SERVICE_SECRET missing. Error was: ${errorMessage}`
    );
    return;
  }

  try {
    const form = new FormData();
    form.append('job_id', jobId);
    form.append('status', 'failed');
    form.append('error_message', String(errorMessage).slice(0, 1000));

    const res = await fetch(callbackUrl, {
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
    // If even reporting the failure fails (e.g. network down, bad URL), log
    // loudly. The job will appear stuck as "processing" to the user, which
    // is the worst case here, but at least it's visible in these logs.
    console.error(`CRITICAL: could not reach callback URL to report failure for job ${jobId}:`, e);
  }
}

module.exports = { reportSuccess, reportFailure };
