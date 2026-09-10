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
import { CLIENT_STATE_SYSTEM, validateClientStateAnalysis } from './ai/client-state-schema.js';
import { REFERENCE_IMAGE_SYSTEM, validateReferenceImageAnalysis } from './ai/reference-image-schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_TASK = 'crm_client_state';
const VISION_TASK = 'vision_reference_extraction';

/** Router caps at 12k input chars; stay under it after JSON envelope overhead. */
const MAX_CONTEXT_CHARS = 11_000;

/** Router caps a single image at 1.5 MB; the CRM already caps uploads at 4 MB. */
const MAX_IMAGE_BYTES = 1_500_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A signed read exists only for the duration of one fetch. */
const SIGNED_URL_SECONDS = 60;

export const enabled = (env) => env?.CRM_AGENT_ENABLED === 'true';
export const visionEnabled = (env) => env?.CRM_AGENT_VISION_ENABLED === 'true';

const clamp = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

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
export function projectClientStateInput(input) {
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

async function processClientStateJob(env, job, supabase, runTask) {
  const input = projectClientStateInput(job.input);
  if (!input) return { outcome: 'failed', errorCode: 'input_invalid' };

  const model = await runTask(
    env,
    STATE_TASK,
    { system: CLIENT_STATE_SYSTEM, input },
    { validateJson: (json) => validateClientStateAnalysis(json) !== null },
  );
  if (!model?.ok) return { outcome: 'failed', errorCode: 'ai_unavailable' };

  // Re-validated rather than trusting the router's check: the router proves the
  // answer parsed, this proves the object is exactly the contract.
  const result = validateClientStateAnalysis(model.json);
  if (!result) return { outcome: 'failed', errorCode: 'output_invalid' };

  const applied = await supabase.rpc('service_complete_client_ai_state_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_summary: result.summary,
    p_brief: result.brief,
    p_next_action: result.next_action,
    p_provider: model.provider,
    p_model: model.model,
  });
  return { outcome: applied?.status ?? 'completed' };
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

  const image = await loadPrivateImage(env, storagePath, { ...deps, supabase });
  if (image.error) return { outcome: 'failed', errorCode: image.error };

  const model = await runTask(
    env,
    VISION_TASK,
    {
      system: REFERENCE_IMAGE_SYSTEM,
      input: 'Describe this client reference image using the required JSON contract.',
      images: [{ mimeType, dataBase64: image.dataBase64 }],
    },
    { validateJson: (json) => validateReferenceImageAnalysis(json) !== null },
  );
  if (!model?.ok) return { outcome: 'failed', errorCode: 'ai_unavailable' };

  const analysis = validateReferenceImageAnalysis(model.json);
  if (!analysis) return { outcome: 'failed', errorCode: 'output_invalid' };

  const applied = await supabase.rpc('service_complete_reference_image_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_analysis: analysis,
    p_provider: model.provider,
    p_model: model.model,
  });
  return { outcome: applied?.status ?? 'completed' };
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

    if (result.outcome === 'failed') return release(result.errorCode);
    return result;
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

export const __testing = Object.freeze({
  MAX_CONTEXT_CHARS, MAX_IMAGE_BYTES, SIGNED_URL_SECONDS, STATE_TASK, VISION_TASK,
});
