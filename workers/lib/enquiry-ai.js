import { createSupabaseClient } from './supabase.js';
import { runModelTask } from './ai/router.js';
import {
  ENQUIRY_AI_PROMPT_VERSION, ENQUIRY_AI_SCHEMA_VERSION, ENQUIRY_AI_SYSTEM,
  diagnoseEnquiryAnalysis, normalizeEnquiryAnalysis, validateEnquiryAnalysis,
} from './ai/enquiry-schema.js';
import { buildAiRunRecord, recordAiRun } from './ai/telemetry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK = 'enquiry_intake';
const enabled = (env) => env?.CRM_AI_INTAKE_ENABLED === 'true';
const pick = (source, keys, max = 1000) => Object.fromEntries(keys.flatMap((key) => {
  const value = source?.[key];
  if (typeof value === 'boolean') return [[key, value]];
  if (typeof value === 'string') return [[key, value.slice(0, max)]];
  return [];
}));

// Explicit projection, not JSON.stringify(job): lease, actor, routing identifiers
// and unrelated client history never enter the prompt, even after RPC evolution.
export function projectEnquiryAiInput(input) {
  const data = {
    client: pick(input?.client, ['full_name', 'email', 'phone'], 500),
    enquiry: pick(input?.enquiry, ['project_type', 'placement', 'approximate_size', 'cover_up',
      'preferred_timing', 'idea', 'discovery_source', 'discovery_source_detail'], 2000),
    artist: pick(input?.artist, ['display_name'], 150),
    reference_images_present: input?.reference_images_present === true,
  };
  if (typeof input?.source_text === 'string') data.email_text = input.source_text.slice(0, 6000);
  const json = JSON.stringify({ untrusted_client_data: data });
  return json.length <= 12000 ? json : null;
}

const validateNormalizedEnquiryAnalysis = (value) => validateEnquiryAnalysis(normalizeEnquiryAnalysis(value));
// Returns the validated object (truthy) when valid, or a bounded failure code.
const checkEnquiryAnswer = (value) => validateNormalizedEnquiryAnalysis(value)
  ?? diagnoseEnquiryAnalysis(normalizeEnquiryAnalysis(value)) ?? 'contract';

export async function processEnquiryAiJob(env, job, deps = {}) {
  const { supabase = createSupabaseClient(env), runTask = runModelTask } = deps;
  if (!enabled(env) || !UUID.test(job?.job_id ?? '') || !UUID.test(job?.lease_token ?? '')) {
    return { outcome: 'ignored' };
  }
  // IDs here come exclusively from the authenticated database claim, never AI.
  const args = { p_job_id: job.job_id, p_lease_token: job.lease_token };
  const fail = async (code) => {
    try { await supabase.rpc('service_fail_enquiry_ai_job', { ...args, p_error_code: code }); } catch { /* lease expiry recovers */ }
    return { outcome: 'failed', errorCode: code };
  };
  // Telemetry is written after the job's own state change and never alters it.
  const telemetry = (routed, outcome, errorCode = null, inputChars = null) => recordAiRun(supabase, buildAiRunRecord({
    task: TASK, jobKind: 'enquiry_intake', jobId: job.job_id,
    promptVersion: ENQUIRY_AI_PROMPT_VERSION, schemaVersion: ENQUIRY_AI_SCHEMA_VERSION,
    routed, outcome, errorCode, inputChars,
  }));
  const failWith = async (code, routed, telemetryCode, inputChars = null) => {
    const failed = await fail(code);
    await telemetry(routed, 'failed', telemetryCode, inputChars);
    return failed;
  };
  try {
    const input = projectEnquiryAiInput(job.input);
    if (!input) return failWith('input_invalid', null, 'input_invalid');
    const model = await runTask(
      env,
      TASK,
      { system: ENQUIRY_AI_SYSTEM, input },
      { validateJson: checkEnquiryAnswer },
    );
    if (!model?.ok) return failWith('ai_unavailable', model, model?.errorCode ?? 'ai_unavailable', input.length);
    const result = validateNormalizedEnquiryAnalysis(model.json);
    if (!result) return failWith('output_invalid', model, 'output_invalid', input.length);
    const saved = await supabase.rpc('service_complete_enquiry_ai_job', {
      ...args, p_result: result, p_provider: model.provider, p_model: model.model,
    });
    await telemetry(model, saved?.status === 'stale' ? 'stale'
      : (saved?.status === undefined || saved?.status === 'succeeded') ? 'succeeded' : 'not_applied',
    null, input.length);
    return { outcome: saved?.status ?? 'completed' };
  } catch {
    // Provider/DB exceptions can contain private text. Never log error objects.
    return fail('processing_failed');
  }
}

export async function drainEnquiryAi(env, { enquiryId = null, limit = 1, ...deps } = {}) {
  if (!enabled(env)) return { processed: 0 };
  if (enquiryId !== null && !UUID.test(enquiryId)) return { processed: 0 };
  try {
    const supabase = deps.supabase ?? createSupabaseClient(env, deps.fetchImpl ?? fetch);
    const jobs = await supabase.rpc('service_claim_enquiry_ai_jobs', {
      p_limit: Math.min(3, Math.max(1, Math.trunc(limit) || 1)), p_enquiry_id: enquiryId,
    });
    if (!Array.isArray(jobs)) return { processed: 0 };
    const outcomes = [];
    for (const job of jobs.slice(0, 3)) outcomes.push(await processEnquiryAiJob(env, job, { ...deps, supabase }));
    return { processed: outcomes.length, outcomes };
  } catch {
    return { processed: 0, errorCode: 'queue_unavailable' };
  }
}

export function scheduleEnquiryAi(env, enquiryId, schedule, deps = {}) {
  if (!enabled(env) || typeof schedule !== 'function') return;
  try { schedule(drainEnquiryAi(env, { enquiryId, ...deps })); } catch { /* durable queue handles recovery */ }
}