/**
 * supabaseClient.js
 *
 * Lightweight REST-based integration with Supabase - intentionally not using
 * the full @supabase/supabase-js SDK to keep this service's dependency
 * footprint small. Uses the SERVICE ROLE key, which bypasses Row Level
 * Security, so this service can write results regardless of the app's
 * normal auth rules. This key must never be exposed to the browser/frontend.
 */

const fs = require('fs/promises');
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESULTS_BUCKET = process.env.SUPABASE_RESULTS_BUCKET || 'results';

function assertConfigured() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as environment variables'
    );
  }
}

/**
 * Uploads a local file to the Supabase Storage results bucket.
 * @param {string} localFilePath
 * @param {string} storagePath - destination path inside the bucket, e.g. `${jobId}/output.mp4`
 * @param {string} contentType
 * @returns {Promise<string>} the storage path that was used (for building a signed URL later)
 */
async function uploadResultFile(localFilePath, storagePath, contentType) {
  assertConfigured();
  const fileBuffer = await fs.readFile(localFilePath);

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${RESULTS_BUCKET}/${storagePath}`;

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Storage upload failed (${res.status}): ${text}`);
  }

  return storagePath;
}

/**
 * Updates a row in the `jobs` table via PostgREST.
 * @param {string} jobId
 * @param {Object} fields - columns to update, e.g. { status: 'complete', result_file_url: '...' }
 */
async function updateJob(jobId, fields) {
  assertConfigured();

  const url = `${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase jobs table update failed (${res.status}): ${text}`);
  }
}

/**
 * Convenience helper: mark a job as failed with a readable error message.
 */
async function markJobFailed(jobId, errorMessage) {
  try {
    await updateJob(jobId, { status: 'failed', error_message: String(errorMessage).slice(0, 1000) });
  } catch (e) {
    // If even the failure-update fails, log loudly - this job will appear
    // stuck as "processing" to the user, which is the worst case here.
    console.error(`CRITICAL: could not mark job ${jobId} as failed:`, e);
  }
}

module.exports = { uploadResultFile, updateJob, markJobFailed };
