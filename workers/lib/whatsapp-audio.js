// Durable inbound voice transcription for the existing shared WhatsApp drain.
// Never sends client messages. Raw audio stays in memory and media IDs remain
// in a private, leased database queue, not in communication or AI telemetry.
import { createSupabaseClient } from './supabase.js';
import { selectWhatsappBinding, GRAPH_API_VERSION } from './whatsapp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_ID = /^[0-9]{5,32}$/;
const INTEGRATION_KEY = /^[a-z][a-z0-9_-]{2,79}$/;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MODEL = '@cf/openai/whisper-large-v3-turbo';
const ALLOWED_MIME = new Set([
  'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/amr', 'audio/wav', 'audio/x-wav',
]);

export class WhatsappAudioError extends Error {
  constructor(code) {
    super('WhatsApp audio transcription failed');
    this.name = 'WhatsappAudioError';
    this.code = code;
  }
}

function failure(code) {
  throw new WhatsappAudioError(code);
}

function safeCode(error) {
  return error instanceof WhatsappAudioError ? error.code : 'whatsapp_audio_unavailable';
}

function validateJob(job) {
  if (!UUID.test(job?.job_id ?? '') || !UUID.test(job?.artist_id ?? '')
    || !INTEGRATION_KEY.test(job?.integration_key ?? '')
    || !MEDIA_ID.test(job?.media_id ?? '')) {
    failure('whatsapp_audio_job_invalid');
  }
  return job;
}

function getBinding(env, job) {
  const route = {
    kind: 'whatsapp_message',
    integration_type: 'whatsapp',
    provider: 'meta_cloud_api',
    integration_key: job.integration_key,
  };
  const binding = selectWhatsappBinding(env, route);
  if (!binding.ok) failure('whatsapp_audio_binding_unavailable');

  // New envelopes pin artist and integration identity. Legacy envelopes have
  // one deterministic binding per route and are guarded by the DB queue.
  let envelope;
  try {
    envelope = JSON.parse(env[binding.bindingName]);
  } catch {
    failure('whatsapp_audio_binding_invalid');
  }
  if ((envelope.artistId && envelope.artistId !== job.artist_id)
     || (envelope.integrationKey && envelope.integrationKey !== job.integration_key)) {
    failure('whatsapp_audio_artist_mismatch');
  }
  return binding;
}

function validMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.port && (
        parsed.hostname === 'lookaside.fbsbx.com'
        || parsed.hostname === 'lookaside.facebook.com'
        || parsed.hostname.endsWith('.fbcdn.net')
      );
  } catch {
    return false;
  }
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const parts = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  }
  return btoa(parts.join(''));
}

export async function transcribeWhatsappAudio(env, job, fetchImpl = fetch) {
  validateJob(job);
  if (!env?.AI || typeof env.AI.run !== 'function') failure('whatsapp_audio_ai_missing');
  const binding = getBinding(env, job);
  const headers = { Authorization: 'Bearer ' + binding.accessToken };

  let meta;
  try {
    meta = await fetchImpl(
      'https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + job.media_id
        + '?phone_number_id=' + encodeURIComponent(binding.phoneNumberId),
      { method: 'GET', headers, redirect: 'manual' },
    );
  } catch {
    failure('whatsapp_audio_meta_unreachable');
  }
  if (!meta.ok) failure(meta.status === 401 || meta.status === 403
    ? 'whatsapp_audio_meta_unauthorised' : 'whatsapp_audio_meta_error');

  let descriptor;
  try {
    descriptor = await meta.json();
  } catch {
    failure('whatsapp_audio_meta_invalid');
  }
  if (!validMediaUrl(descriptor?.url) || !ALLOWED_MIME.has(descriptor?.mime_type)
      || !Number.isFinite(Number(descriptor?.file_size))
      || Number(descriptor.file_size) < 1
      || Number(descriptor.file_size) > MAX_AUDIO_BYTES) {
    failure('whatsapp_audio_media_invalid');
  }

  let media;
  try {
    media = await fetchImpl(descriptor.url, {
      method: 'GET', headers, redirect: 'manual',
    });
  } catch {
    failure('whatsapp_audio_download_unreachable');
  }
  if (!media.ok) failure('whatsapp_audio_download_failed');
  const declaredSize = Number(media.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_AUDIO_BYTES) {
    failure('whatsapp_audio_too_large');
  }
  let buffer;
  try {
    buffer = await media.arrayBuffer();
  } catch {
    failure('whatsapp_audio_download_failed');
  }
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_AUDIO_BYTES
      || buffer.byteLength !== Number(descriptor.file_size)) {
    failure('whatsapp_audio_size_mismatch');
  }

  let result;
  try {
    result = await env.AI.run(MODEL, { audio: bufferToBase64(buffer), task: 'transcribe' });
  } catch {
    failure('whatsapp_audio_inference_failed');
  }
  const transcript = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!transcript || transcript.length > 4096) failure('whatsapp_audio_transcript_invalid');
  return transcript;
}

export async function drainWhatsappAudioTranscriptions(env, {
  supabase = null,
  fetchImpl = fetch,
  workerId = 'audio-' + crypto.randomUUID().replace(/-/g, ''),
} = {}) {
  if (env?.WHATSAPP_AUDIO_TRANSCRIPTION_ENABLED !== 'true') {
    return { skipped: true, claimed: 0, succeeded: 0, failed: 0, unrecorded: 0 };
  }
  if (env?.VISHAR_ENVIRONMENT !== 'production') {
    failure('whatsapp_audio_environment_invalid');
  }
  const db = supabase || createSupabaseClient(env);
  const rows = await db.rpc('service_claim_whatsapp_audio_transcriptions', {
    p_worker_id: workerId, p_limit: 3, p_lease_seconds: 180,
  });
  if (!Array.isArray(rows) || rows.length > 3) failure('whatsapp_audio_claim_invalid');

  const outcome = { skipped: false, claimed: rows.length, succeeded: 0, failed: 0, unrecorded: 0 };
  for (const raw of rows) {
    let transcript = null;
    let errorCode = null;
    try {
      transcript = await transcribeWhatsappAudio(env, validateJob(raw), fetchImpl);
    } catch (error) {
      errorCode = safeCode(error);
    }
    try {
      await db.rpc('service_complete_whatsapp_audio_transcription', {
        p_job_id: raw.job_id,
        p_worker_id: workerId,
        p_transcript: transcript,
        p_error_code: errorCode,
      });
      outcome[transcript ? 'succeeded' : 'failed'] += 1;
    } catch {
      outcome.unrecorded += 1;
    }
  }
  return outcome;
}

export const __testing = {
  validMediaUrl, bufferToBase64, validateJob, getBinding, safeCode,
  MAX_AUDIO_BYTES, MODEL,
};
