// Server-side orchestration for derived CRM AI state.
//
// One drain, two job types. It claims a lease, asks the router for a
// structured answer, validates it, and hands it back through a service RPC
// that re-checks scope and freshness before writing anything. Nothing here
// sends a message, books a date, quotes a price or moves money: the only
// writes it can cause are to the derived-state tables.
//
// The runtime is entirely server-side. It runs from the existing production
// scheduler through a Service Binding, so no part of it depends on a desktop,
// a local process, or anybody's machine being awake.

import { createSupabaseClient } from './supabase.js';
import { createStorageClient } from './storage.js';
import { runModelTask } from './ai/router.js';
import { MAX_IMAGE_BYTES } from './ai/tasks.js';
import {
  CLIENT_DRAFT_PROMPT_VERSION, CLIENT_DRAFT_SCHEMA_VERSION, CLIENT_DRAFT_SYSTEM,
  CLIENT_STATE_PROMPT_VERSION, CLIENT_STATE_SCHEMA_VERSION, CLIENT_STATE_SYSTEM,
  CLIENT_STATE_V2_PROMPT_VERSION, CLIENT_STATE_V2_SCHEMA_VERSION, CLIENT_STATE_V2_SYSTEM,
  DRAFTABLE_ACTION_TYPES, diagnoseClientDraft, diagnoseClientStateAnalysis, diagnoseClientStateV2,
  normalizeClientStateV2, toStoredClientState, validateClientStateAnalysis, validateClientStateV2,
} from './ai/client-state-schema.js';
import {
  REFERENCE_IMAGE_PROMPT_VERSION, REFERENCE_IMAGE_SCHEMA_VERSION, REFERENCE_IMAGE_SYSTEM,
  diagnoseReferenceImageAnalysis, normalizeReferenceImageAnalysis, validateReferenceImageAnalysis,
} from './ai/reference-image-schema.js';
import { buildAiRunRecord, recordAiRun } from './ai/telemetry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_TASK = 'crm_client_state';
const VISION_TASK = 'vision_reference_extraction';
const DRAFT_TASK = 'crm_draft_reply';

/** Phase 3 contract switch. Anything but the exact value keeps v1. */
export const contractVersion = (env) => (env?.CRM_AGENT_CONTRACT === 'v2' ? 'v2' : 'v1');

/** Router caps at 12k input chars; stay under it after JSON envelope overhead. */
const MAX_CONTEXT_CHARS = 11_000;

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A signed read exists only for the duration of one fetch. */
const SIGNED_URL_SECONDS = 60;

export const enabled = (env) => env?.CRM_AGENT_ENABLED === 'true';
export const visionEnabled = (env) => env?.CRM_AGENT_VISION_ENABLED === 'true';

const clamp = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/**
 * Language of the internal note, chosen by the database from the artist-facing
 * recipients' CRM language (client_ai_context artist.output_language). It is
 * read here, never projected into prompt data.
 */
export function outputLanguage(input) {
  return input?.artist?.output_language === 'ru' ? 'ru' : 'en';
}

/**
 * Appended to the state system prompt for a Russian reader. The artist-facing
 * text (summary, brief strings, discussed values, reason) is written in
 * Russian; the contract's keys and enum values stay exactly as specified, so
 * validation and every downstream rule are unchanged. Client-facing drafts
 * keep following the client's language and never receive this.
 */
export const RUSSIAN_OUTPUT_INSTRUCTION = `

Output language: the artist reads the CRM in Russian. Write summary, every brief string value,
every discussed value and next_action.reason in natural Russian. Keep client names, usernames,
quoted client wording, sizes and places as written. JSON keys and the enumerated values
(reply_state, action_type, priority, discussed status, missing_information field names)
stay exactly in English as specified above.`;

const stateSystem = (base, input) => (outputLanguage(input) === 'ru' ? base + RUSSIAN_OUTPUT_INSTRUCTION : base);

function boundJson(value, { maxString = 500, maxArray = 12, maxKeys = 24, maxDepth = 5 } = {}, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, maxString);
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((item) => boundJson(item, { maxString, maxArray, maxKeys, maxDepth }, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, maxKeys).map(([key, item]) => [
      key,
      boundJson(item, { maxString, maxArray, maxKeys, maxDepth }, depth + 1),
    ]));
  }
  return null;
}

const projectEnquiry = (item, ideaMax = 2000) => ({
  reference: clamp(item?.reference, 80),
  status: clamp(item?.status, 40),
  project_type: clamp(item?.project_type, 200),
  placement: clamp(item?.placement, 200),
  approximate_size: clamp(item?.approximate_size, 200),
  cover_up: clamp(item?.cover_up, 200),
  preferred_timing: clamp(item?.preferred_timing, 200),
  idea: clamp(item?.idea, ideaMax),
  created_at: clamp(item?.created_at, 40),
});

/**
 * Explicit projection of the claimed context into a prompt envelope.
 *
 * Deliberately not `JSON.stringify(job.input)`: the RPC's shape may grow, and
 * a future column added there must not silently become prompt content. Every
 * field that reaches a provider is named here.
 */
const FACT_KEYS = Object.freeze([
  'last_speaker', 'reply_state', 'workflow_stage', 'deposit_state', 'has_future_tattoo_session',
  'has_future_consultation', 'next_session_at', 'sla_state', 'sla_reason', 'waiting_on_candidate',
]);

/** The deterministic facts the v2 prompt treats as authoritative, by name. */
export function projectWorkflowFacts(attention) {
  if (!attention || typeof attention !== 'object') return null;
  const facts = {};
  for (const key of FACT_KEYS) {
    const value = attention[key];
    if (typeof value === 'boolean' || value === null) facts[key] = value;
    else if (typeof value === 'string') facts[key] = value.slice(0, 64);
  }
  facts.allowed_actions = Array.isArray(attention.allowed_actions)
    ? attention.allowed_actions.filter((a) => typeof a === 'string').slice(0, 12) : [];
  facts.conflicts = Array.isArray(attention.conflicts)
    ? attention.conflicts.filter((c) => typeof c === 'string').slice(0, 12) : [];
  return facts.allowed_actions.length ? facts : null;
}

export function projectClientStateInput(input, { contract = 'v1' } = {}) {
  if (!input || typeof input !== 'object') return null;

  const timeline = Array.isArray(input.timeline) ? input.timeline : [];
  const sourceEnquiries = Array.isArray(input.enquiries) ? input.enquiries : [];
  const sourceImages = Array.isArray(input.reference_images) ? input.reference_images : [];
  const data = {
    client: { full_name: clamp(input.client?.full_name, 160) },
    artist: { display_name: clamp(input.artist?.display_name, 160) },
    enquiries: sourceEnquiries.slice(0, 5).map((item) => projectEnquiry(item)),
    // Named `crm_facts` in the prompt too: the system prompt tells the model
    // this section outranks anything a client said, so the key must match.
    crm_facts: input.crm_facts ?? {},
    timeline: timeline.slice(0, 20).map((item) => ({
      source: clamp(item?.source, 32),
      direction: clamp(item?.direction, 16),
      text: clamp(item?.text, 1000),
      occurred_at: clamp(item?.occurred_at, 40),
    })),
    reference_images: sourceImages
      .slice(0, 6)
      .map((item) => ({ summary: clamp(item?.summary, 800), analysis: item?.analysis ?? null })),
    previous_brief: input.previous_brief ?? null,
  };
  if (contract === 'v2') {
    const facts = projectWorkflowFacts(input.attention);
    if (!facts) return null;
    data.crm_workflow_facts = facts;
  }

  let json = JSON.stringify({ untrusted_crm_data: data });
  if (json.length <= MAX_CONTEXT_CHARS) return json;

  // Over budget. Drop the oldest timeline items first: the derived brief
  // already carries the older history forward, so recency is what is scarce.
  for (let keep = 15; keep >= 3 && json.length > MAX_CONTEXT_CHARS; keep -= 3) {
    data.timeline = timeline.slice(0, keep).map((item) => ({
      source: clamp(item?.source, 32),
      direction: clamp(item?.direction, 16),
      text: clamp(item?.text, 600),
      occurred_at: clamp(item?.occurred_at, 40),
    }));
    json = JSON.stringify({ untrusted_crm_data: data });
  }

  // Timeline trimming alone is not sufficient for established clients with
  // several large enquiry ideas, reference analyses or a long previous brief.
  // Bound those optional sections before giving up on an otherwise valid job.
  if (json.length > MAX_CONTEXT_CHARS) {
    data.enquiries = sourceEnquiries.slice(0, 3).map((item) => projectEnquiry(item, 800));
    data.reference_images = sourceImages.slice(0, 3).map((item) => ({
      summary: clamp(item?.summary, 400),
      analysis: boundJson(item?.analysis, { maxString: 300, maxArray: 8, maxKeys: 18, maxDepth: 4 }),
    }));
    data.previous_brief = boundJson(input.previous_brief, { maxString: 400, maxArray: 10, maxKeys: 24, maxDepth: 5 });
    data.crm_facts = boundJson(input.crm_facts ?? {}, { maxString: 160, maxArray: 20, maxKeys: 24, maxDepth: 5 });
    json = JSON.stringify({ untrusted_crm_data: data });
  }

  // Final deterministic fallback. This keeps the newest facts and a small
  // amount of context rather than turning one oversized client into a durable
  // retry loop that can never succeed.
  if (json.length > MAX_CONTEXT_CHARS) {
    data.timeline = timeline.slice(0, 3).map((item) => ({
      source: clamp(item?.source, 32),
      direction: clamp(item?.direction, 16),
      text: clamp(item?.text, 300),
      occurred_at: clamp(item?.occurred_at, 40),
    }));
    data.enquiries = sourceEnquiries.slice(0, 2).map((item) => projectEnquiry(item, 500));
    data.reference_images = sourceImages.slice(0, 2).map((item) => ({
      summary: clamp(item?.summary, 300), analysis: null,
    }));
    data.previous_brief = boundJson(input.previous_brief, { maxString: 240, maxArray: 6, maxKeys: 16, maxDepth: 4 });
    data.crm_facts = boundJson(input.crm_facts ?? {}, { maxString: 120, maxArray: 10, maxKeys: 18, maxDepth: 4 });
    json = JSON.stringify({ untrusted_crm_data: data });
  }

  return json.length <= MAX_CONTEXT_CHARS ? json : null;
}

/**
 * Reads one private object and returns base64 bytes.
 *
 * The signed URL is minted here, used once and dropped. It is never returned,
 * never persisted, never logged and never handed to any third party: Firecrawl
 * and the rest of the web-research surface operate on public URLs a human
 * supplied, and have no path to this function.
 */
export async function loadPrivateImage(env, storagePath, deps = {}) {
  const { supabase = createSupabaseClient(env), fetchImpl = fetch } = deps;
  const storage = deps.storage ?? createStorageClient(supabase, fetchImpl);

  let response;
  try {
    const signedUrl = await storage.createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    response = await fetchImpl(signedUrl, { method: 'GET' });
  } catch {
    return { error: 'image_unavailable' };
  }
  if (!response?.ok) return { error: 'image_unavailable' };

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { error: 'image_unavailable' };
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { error: 'image_unsupported' };

  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return { dataBase64: btoa(binary) };
}

/** Maps a completion RPC status onto the telemetry outcome vocabulary. */
const appliedOutcome = (status) => (status === 'succeeded' || status === undefined
  ? 'succeeded'
  : status === 'stale' ? 'stale' : 'not_applied');

/** The newest inbound client text, bounded, for a purpose-specific draft. */
function latestInboundText(input) {
  const timeline = Array.isArray(input?.timeline) ? input.timeline : [];
  const newest = timeline.find((item) => item?.direction === 'inbound' && typeof item?.text === 'string');
  return newest ? newest.text.slice(0, 800) : null;
}

async function processClientStateJobV2(env, job, supabase, runTask) {
  const record = (routed, outcome, errorCode = null, inputChars = null, task = STATE_TASK) => buildAiRunRecord({
    task, jobKind: 'client_state', jobId: job.job_id,
    promptVersion: task === DRAFT_TASK ? CLIENT_DRAFT_PROMPT_VERSION : CLIENT_STATE_V2_PROMPT_VERSION,
    schemaVersion: task === DRAFT_TASK ? CLIENT_DRAFT_SCHEMA_VERSION : CLIENT_STATE_V2_SCHEMA_VERSION,
    routed, outcome, errorCode, inputChars,
  });

  const facts = projectWorkflowFacts(job?.input?.attention);
  const input = facts ? projectClientStateInput(job.input, { contract: 'v2' }) : null;
  if (!input) return { outcome: 'failed', errorCode: 'input_invalid', aiRun: record(null, 'failed', 'input_invalid') };

  const allowed = facts.allowed_actions;
  const model = await runTask(
    env,
    STATE_TASK,
    { system: stateSystem(CLIENT_STATE_V2_SYSTEM, job.input), input },
    { validateJson: (json) => diagnoseClientStateV2(normalizeClientStateV2(json), allowed) ?? true },
  );
  if (!model?.ok) {
    return { outcome: 'failed', errorCode: 'ai_unavailable',
      aiRun: record(model, 'failed', model?.errorCode ?? 'ai_unavailable', input.length) };
  }
  const answer = validateClientStateV2(normalizeClientStateV2(model.json), allowed);
  if (!answer) return { outcome: 'failed', errorCode: 'output_invalid', aiRun: record(model, 'failed', 'output_invalid', input.length) };

  const stored = toStoredClientState(answer, facts);
  const runs = [];

  // A short, separate draft only where the action may carry client text. A
  // rejected or failed draft leaves draft_reply null; the analysis stands.
  if (DRAFTABLE_ACTION_TYPES.includes(stored.next_action.action_type)) {
    const draftInput = JSON.stringify({ untrusted_client_data: {
      latest_client_message: latestInboundText(job.input),
      purpose: stored.next_action.action_type,
      missing_information: stored.next_action.missing_information,
    } });
    const drafted = await runTask(env, DRAFT_TASK, { system: CLIENT_DRAFT_SYSTEM, input: draftInput },
      { validateJson: (json) => diagnoseClientDraft(json) ?? true });
    if (drafted?.ok && !diagnoseClientDraft(drafted.json)) stored.next_action.draft_reply = drafted.json.draft_reply;
    runs.push(record(drafted, drafted?.ok ? 'succeeded' : 'failed',
      drafted?.ok ? null : drafted?.errorCode ?? 'draft_rejected', draftInput.length, DRAFT_TASK));
  }

  const applied = await supabase.rpc('service_complete_client_ai_state_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_summary: stored.summary,
    p_brief: stored.brief,
    p_next_action: stored.next_action,
    p_provider: model.provider,
    p_model: model.model,
  });
  runs.unshift(record(model, appliedOutcome(applied?.status), applied?.error_code ?? null, input.length));

  // The classifier result becomes an explicit reply mark only once the job
  // has succeeded; the database derives which message it answers.
  const succeeded = applied?.status === undefined || applied?.status === 'succeeded';
  if (succeeded && answer.reply_state !== 'unclear') {
    try {
      await supabase.rpc('service_record_client_reply_state', { p_job_id: job.job_id, p_reply_state: answer.reply_state });
    } catch { /* fail-open: the mark is advisory */ }
  }
  return { outcome: applied?.status ?? 'completed', aiRun: runs };
}

async function processClientStateJob(env, job, supabase, runTask) {
  if (contractVersion(env) === 'v2') return processClientStateJobV2(env, job, supabase, runTask);

  const telemetry = (routed, outcome, errorCode = null, inputChars = null) => buildAiRunRecord({
    task: STATE_TASK, jobKind: 'client_state', jobId: job.job_id,
    promptVersion: CLIENT_STATE_PROMPT_VERSION, schemaVersion: CLIENT_STATE_SCHEMA_VERSION,
    routed, outcome, errorCode, inputChars,
  });

  const input = projectClientStateInput(job.input);
  if (!input) {
    return { outcome: 'failed', errorCode: 'input_invalid', aiRun: telemetry(null, 'failed', 'input_invalid') };
  }

  const model = await runTask(
    env,
    STATE_TASK,
    { system: stateSystem(CLIENT_STATE_SYSTEM, job.input), input },
    { validateJson: (json) => (validateClientStateAnalysis(json) !== null ? true : diagnoseClientStateAnalysis(json) ?? 'contract') },
  );
  if (!model?.ok) {
    return { outcome: 'failed', errorCode: 'ai_unavailable', aiRun: telemetry(model, 'failed', model?.errorCode ?? 'ai_unavailable', input.length) };
  }

  // Re-validated rather than trusting the router's check: the router proves the
  // answer parsed, this proves the object is exactly the contract.
  const result = validateClientStateAnalysis(model.json);
  if (!result) {
    return { outcome: 'failed', errorCode: 'output_invalid', aiRun: telemetry(model, 'failed', 'output_invalid', input.length) };
  }

  const applied = await supabase.rpc('service_complete_client_ai_state_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_summary: result.summary,
    p_brief: result.brief,
    p_next_action: result.next_action,
    p_provider: model.provider,
    p_model: model.model,
  });
  return {
    outcome: applied?.status ?? 'completed',
    aiRun: telemetry(model, appliedOutcome(applied?.status), applied?.error_code ?? null, input.length),
  };
}

async function processReferenceImageJob(env, job, supabase, runTask, deps) {
  if (!visionEnabled(env)) return { outcome: 'ignored' };

  const mimeType = job?.input?.mime_type;
  const storagePath = job?.input?.storage_path;
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType) || typeof storagePath !== 'string' || !storagePath) {
    return { outcome: 'failed', errorCode: 'image_unsupported' };
  }
  if (Number(job?.input?.byte_size) > MAX_IMAGE_BYTES) {
    return { outcome: 'failed', errorCode: 'image_unsupported' };
  }

  const telemetry = (routed, outcome, errorCode = null) => buildAiRunRecord({
    task: VISION_TASK, jobKind: 'reference_image', jobId: job.job_id,
    promptVersion: REFERENCE_IMAGE_PROMPT_VERSION, schemaVersion: REFERENCE_IMAGE_SCHEMA_VERSION,
    routed, outcome, errorCode, imageCount: routed ? 1 : 0,
  });

  const image = await loadPrivateImage(env, storagePath, { ...deps, supabase });
  if (image.error) {
    return { outcome: 'failed', errorCode: image.error, aiRun: telemetry(null, 'failed', image.error) };
  }

  const model = await runTask(
    env,
    VISION_TASK,
    {
      system: REFERENCE_IMAGE_SYSTEM,
      input: 'Describe this client reference image using the required JSON contract.',
      images: [{ mimeType, dataBase64: image.dataBase64 }],
    },
    {
      validateJson: (json) => (validateReferenceImageAnalysis(normalizeReferenceImageAnalysis(json)) !== null
        ? true : diagnoseReferenceImageAnalysis(normalizeReferenceImageAnalysis(json)) ?? 'contract'),
    },
  );
  if (!model?.ok) {
    return { outcome: 'failed', errorCode: 'ai_unavailable', aiRun: telemetry(model, 'failed', model?.errorCode ?? 'ai_unavailable') };
  }

  const analysis = validateReferenceImageAnalysis(normalizeReferenceImageAnalysis(model.json));
  if (!analysis) {
    return { outcome: 'failed', errorCode: 'output_invalid', aiRun: telemetry(model, 'failed', 'output_invalid') };
  }

  const applied = await supabase.rpc('service_complete_reference_image_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_analysis: analysis,
    p_provider: model.provider,
    p_model: model.model,
  });
  return {
    outcome: applied?.status ?? 'completed',
    aiRun: telemetry(model, appliedOutcome(applied?.status), applied?.error_code ?? null),
  };
}

export async function processCrmAgentJob(env, job, deps = {}) {
  const { supabase = createSupabaseClient(env), runTask = runModelTask } = deps;

  // Identifiers come exclusively from the authenticated database claim. There
  // is no path by which a model, a client message or a webhook can name a job.
  if (!enabled(env) || !UUID.test(job?.job_id ?? '') || !UUID.test(job?.lease_token ?? '')) {
    return { outcome: 'ignored' };
  }

  const release = async (code) => {
    try {
      await supabase.rpc('service_fail_crm_agent_job', {
        p_job_id: job.job_id, p_lease_token: job.lease_token, p_error_code: code,
      });
    } catch { /* the lease expires and the job is recovered on a later tick */ }
    return { outcome: 'failed', errorCode: code };
  };

  try {
    const result = job.job_type === 'analyze_reference_image'
      ? await processReferenceImageJob(env, job, supabase, runTask, deps)
      : job.job_type === 'refresh_client_ai_state'
        ? await processClientStateJob(env, job, supabase, runTask)
        : { outcome: 'ignored' };

    // Telemetry goes last, after the job's own state change, and never
    // changes the outcome the caller sees.
    const { aiRun = null, ...outcome } = result;
    const settled = outcome.outcome === 'failed' ? await release(outcome.errorCode) : outcome;
    for (const run of Array.isArray(aiRun) ? aiRun : [aiRun]) await recordAiRun(supabase, run);
    return settled;
  } catch {
    // A provider or database exception can carry private message text in its
    // message. It is collapsed to a bounded code and the object is never logged.
    return release('processing_failed');
  }
}

export async function drainCrmAgent(env, { limit = 2, ...deps } = {}) {
  if (!enabled(env)) return { processed: 0 };
  try {
    const supabase = deps.supabase ?? createSupabaseClient(env, deps.fetchImpl ?? fetch);
    const jobs = await supabase.rpc('service_claim_crm_agent_jobs', {
      p_limit: Math.min(3, Math.max(1, Math.trunc(limit) || 1)),
    });
    if (!Array.isArray(jobs)) return { processed: 0 };

    const outcomes = [];
    for (const job of jobs.slice(0, 3)) {
      outcomes.push(await processCrmAgentJob(env, job, { ...deps, supabase }));
    }
    return { processed: outcomes.length, outcomes };
  } catch {
    return { processed: 0, errorCode: 'crm_agent_queue_unavailable' };
  }
}

/**
 * Records one deterministic-attention shadow comparison, at most hourly (the
 * database throttles). Aggregate counts only; never throws.
 */
export async function recordAttentionShadow(env, deps = {}) {
  if (!enabled(env)) return 'disabled';
  try {
    const supabase = deps.supabase ?? createSupabaseClient(env, deps.fetchImpl ?? fetch);
    const result = await supabase.rpc('service_record_attention_shadow', {});
    return ['recorded', 'throttled'].includes(result?.status) ? result.status : 'rejected';
  } catch {
    return 'failed';
  }
}

/**
 * Phase 6a: enqueue ordinary refreshes for a few stale briefs. The database
 * owns the budget (a few per hour) and the dedupe; this only asks. Counts
 * only, fail-open, never affects the drain result.
 */
export async function convergeClientAiBriefs(env, deps = {}) {
  if (!enabled(env)) return 'disabled';
  try {
    const supabase = deps.supabase ?? createSupabaseClient(env, deps.fetchImpl ?? fetch);
    // Refreshing old briefs competes with new enquiries for the same daily
    // Workers AI allocation, so it is opt-in: CRM_BRIEF_CONVERGE_PER_HOUR.
    const perHour = Number.parseInt(env?.CRM_BRIEF_CONVERGE_PER_HOUR ?? '0', 10);
    if (!Number.isInteger(perHour) || perHour <= 0) return 'off';
    const result = await supabase.rpc('service_converge_client_ai_briefs', { p_limit: Math.min(perHour, 10) });
    return ['ok', 'busy', 'disabled', 'budget_spent'].includes(result?.status) ? result.status : 'rejected';
  } catch {
    return 'failed';
  }
}

export const __testing = Object.freeze({
  MAX_CONTEXT_CHARS, MAX_IMAGE_BYTES, SIGNED_URL_SECONDS, STATE_TASK, VISION_TASK,
});
