// Per-run AI telemetry for CRM jobs.
//
// Builds one bounded record from a router result and hands it to the service
// RPC `service_record_ai_run`. What the record may carry is fixed here and
// re-checked by the database: task and job reference, bounded codes, counts
// and durations. It never carries a prompt, a client message, a model answer,
// an image, a credential, a raw provider error or any reasoning text.
//
// Telemetry is fail-open. Nothing in this file throws to its caller, and a
// failed write never changes the outcome of the AI job it describes.

const TASK_RE = /^[a-z][a-z0-9_]{2,63}$/;
const CODE_RE = /^[a-z][a-z0-9_]{2,63}$/;
const VALIDATION_RE = /^[a-z][a-z0-9_.]{2,79}$/;
const VERSION_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MODEL_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,60}$/;
const FINISH_RE = /^[a-z][a-z0-9_]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const JOB_KINDS = Object.freeze(['enquiry_intake', 'client_state', 'reference_image', 'enquiry_translation']);
export const RUN_OUTCOMES = Object.freeze(['succeeded', 'failed', 'stale', 'not_applied']);
const PROVIDERS = new Set(['qwen', 'workers_ai', 'openai', 'deepseek']);
const MAX_ATTEMPTS = 4;

const bounded = (value, re) => (typeof value === 'string' && re.test(value) ? value : null);
const count = (value, max = 9_999_999) => (Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null);

function attemptRecord(attempt) {
  const provider = PROVIDERS.has(attempt?.provider) ? attempt.provider : null;
  if (!provider) return null;
  return {
    provider,
    model: bounded(attempt.model, MODEL_TOKEN_RE),
    outcome: attempt.outcome === 'succeeded' ? 'succeeded' : 'failed',
    error_code: bounded(attempt.errorCode, CODE_RE),
    finish_reason: bounded(attempt.finishReason, FINISH_RE),
    duration_ms: count(attempt.durationMs, 900_000) ?? 0,
    output_chars: count(attempt.outputChars),
    prompt_tokens: count(attempt.promptTokens),
    completion_tokens: count(attempt.completionTokens),
    reasoning_tokens: count(attempt.reasoningTokens),
    validation_failure: bounded(attempt.validationFailure, VALIDATION_RE),
  };
}

/**
 * Builds the record. `routed` is the router result (or null when the job was
 * refused before any provider). Returns null rather than throwing when the
 * input cannot produce a valid record.
 */
export function buildAiRunRecord({
  task, jobKind, jobId, promptVersion, schemaVersion, routed = null,
  outcome, errorCode = null, validationFailure = null, inputChars = null, imageCount = 0,
  durationMs = null,
}) {
  try {
    if (!TASK_RE.test(task ?? '') || !JOB_KINDS.includes(jobKind) || !RUN_OUTCOMES.includes(outcome)) return null;
    if (!VERSION_RE.test(promptVersion ?? '') || !VERSION_RE.test(schemaVersion ?? '')) return null;

    const attempts = (Array.isArray(routed?.attempts) ? routed.attempts : [])
      .slice(0, MAX_ATTEMPTS)
      .map(attemptRecord)
      .filter(Boolean);
    const finalProvider = routed?.ok && PROVIDERS.has(routed.provider) ? routed.provider : null;
    const fallbackUsed = Boolean(routed?.fallbackUsed) || attempts.length > 1;
    const lastFailure = [...attempts].reverse().find((attempt) => attempt.validation_failure)?.validation_failure ?? null;

    return {
      task,
      job_kind: jobKind,
      job_id: UUID_RE.test(jobId ?? '') ? jobId : null,
      prompt_version: promptVersion,
      schema_version: schemaVersion,
      route_source: ['default', 'env'].includes(routed?.routeSource) ? routed.routeSource : 'unknown',
      attempts,
      fallback_used: fallbackUsed,
      final_provider: finalProvider,
      quality_tier: finalProvider ? (fallbackUsed ? 'fallback' : 'primary') : 'none',
      outcome,
      error_code: bounded(errorCode, CODE_RE),
      validation_failure: bounded(validationFailure, VALIDATION_RE) ?? (outcome === 'failed' ? lastFailure : null),
      duration_ms: count(durationMs ?? routed?.durationMs, 900_000) ?? 0,
      input_chars: count(inputChars, 1_000_000),
      image_count: count(imageCount, 4) ?? 0,
    };
  } catch {
    return null;
  }
}

/** Never throws, never logs the record. Returns a bounded status. */
export async function recordAiRun(supabase, record) {
  if (!record || typeof supabase?.rpc !== 'function') return 'skipped';
  try {
    const result = await supabase.rpc('service_record_ai_run', { p_run: record });
    return result?.status === 'recorded' ? 'recorded' : 'rejected';
  } catch {
    return 'failed';
  }
}

export const __testing = Object.freeze({ attemptRecord, MAX_ATTEMPTS });
