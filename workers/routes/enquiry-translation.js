// POST /crm/enquiry-translations/<job id>
//
// Runs one manual Russian translation that the artist started in the CRM.
// The job id is created by request_enquiry_translation, which checks the
// artist's access; this route only executes that job and answers with a
// status. It never returns the translated text: the CRM reads it through
// get_enquiry_translation, which checks access again. A random or reused id
// therefore reveals nothing and costs one database lookup.
//
// Failures are stored on the job for the button to show. Nothing here creates
// a notification or an alert.

import { createSupabaseClient } from '../lib/supabase.js';
import { runModelTask } from '../lib/ai/router.js';
import { buildAiRunRecord, recordAiRun } from '../lib/ai/telemetry.js';
import {
  TRANSLATION_PROMPT_VERSION, TRANSLATION_SCHEMA_VERSION, TRANSLATION_SYSTEM,
  buildTranslationInput, diagnoseTranslation, validateTranslation,
} from '../lib/ai/translation.js';
import { createLogger, newRequestId } from '../lib/logging.js';

export const TRANSLATION_PATH_RE = /^\/crm\/enquiry-translations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const TASK = 'enquiry_translation';
const WORKER_ID = 'tattooai-translation';

export function isEnquiryTranslationPath(request) {
  try {
    return TRANSLATION_PATH_RE.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    ...(origin === CRM_ORIGIN ? {
      'Access-Control-Allow-Origin': CRM_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    } : {}),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

const reply = (request, status, body) => Response.json(body, { status, headers: corsHeaders(request) });

export async function handleEnquiryTranslationRequest(request, env, deps = {}) {
  if (env?.CRM_TRANSLATION_ENABLED !== 'true') return reply(request, 404, { ok: false, error: 'not_found' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return reply(request, 405, { ok: false, error: 'method_not_allowed' });

  const jobId = TRANSLATION_PATH_RE.exec(new URL(request.url).pathname)?.[1];
  const supabase = deps.supabase ?? createSupabaseClient(env, deps.fetchImpl);
  const runTask = deps.runTask ?? runModelTask;

  let claim;
  try {
    claim = await supabase.rpc('service_claim_enquiry_translation', { p_job_id: jobId, p_worker_id: WORKER_ID });
  } catch {
    return reply(request, 503, { ok: false, status: 'unavailable' });
  }
  if (claim?.status !== 'claimed' || typeof claim.source_text !== 'string') {
    return reply(request, 200, { ok: true, status: 'not_claimed' });
  }

  const source = claim.source_text;
  const routed = await runTask(env, TASK, { system: TRANSLATION_SYSTEM, input: buildTranslationInput(source) }, {
    validateJson: (value) => diagnoseTranslation(value, source) ?? true,
    logger: createLogger(newRequestId()),
  });
  const translation = routed?.ok ? validateTranslation(routed.json, source) : null;
  const telemetry = (outcome, errorCode) => recordAiRun(supabase, buildAiRunRecord({
    task: TASK, jobKind: 'enquiry_translation', jobId,
    promptVersion: TRANSLATION_PROMPT_VERSION, schemaVersion: TRANSLATION_SCHEMA_VERSION,
    routed, outcome, errorCode, inputChars: source.length,
  })).catch(() => null);

  if (!translation) {
    const errorCode = routed?.ok ? 'output_invalid' : 'ai_unavailable';
    await supabase.rpc('service_fail_enquiry_translation', {
      p_job_id: jobId, p_lease_token: claim.lease_token, p_error_code: errorCode,
    }).catch(() => null);
    await telemetry('failed', routed?.errorCode ?? errorCode);
    return reply(request, 200, { ok: false, status: 'failed', errorCode });
  }

  let completed;
  try {
    completed = await supabase.rpc('service_complete_enquiry_translation', {
      p_job_id: jobId, p_lease_token: claim.lease_token, p_translation: translation,
      p_provider: routed.provider, p_model: routed.model,
    });
  } catch {
    await telemetry('not_applied', 'store_failed');
    return reply(request, 503, { ok: false, status: 'unavailable' });
  }
  await telemetry(completed?.status === 'succeeded' ? 'succeeded' : 'not_applied', null);
  return reply(request, 200, { ok: completed?.status === 'succeeded', status: completed?.status ?? 'unknown' });
}
