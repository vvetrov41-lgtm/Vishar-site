// Intake preflight: provider selection, kill switch and fail-open execution.
//
// INTAKE_PREFLIGHT_ENABLED   "true" turns the semantic step on (default off).
// INTAKE_PREFLIGHT_PROVIDER  "jev" is the only adapter today; anything else,
//                            or a missing key, means no semantic provider.
// INTAKE_PREFLIGHT_TIMEOUT_MS bounded 300..2000, default 1200 (Jev p95 in
//                            synthetic runs is well under this).
//
// Every failure (disabled, not configured, timeout, 429, provider error,
// malformed answer) returns status "skipped": the form submits normally.

import { decisionModelConfig, requestTypedDecision } from '../ai/decision-model.js';
import {
  PREFLIGHT_VERSION, buildPreflightQuestions, buildPreflightState, clarificationMessages, decidePreflight,
} from './contract.js';

const DEFAULT_TIMEOUT_MS = 1200;
const PROVIDERS = new Set(['jev']);

export function preflightConfig(env) {
  if (env?.INTAKE_PREFLIGHT_ENABLED !== 'true') return { enabled: false, reason: 'disabled' };
  const provider = typeof env?.INTAKE_PREFLIGHT_PROVIDER === 'string' ? env.INTAKE_PREFLIGHT_PROVIDER.trim() : '';
  if (!PROVIDERS.has(provider)) return { enabled: false, reason: 'no_provider' };
  const decision = decisionModelConfig(env);
  if (!decision) return { enabled: false, reason: 'not_configured' };
  const raw = Number.parseInt(env?.INTAKE_PREFLIGHT_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(raw, 300), 2000) : DEFAULT_TIMEOUT_MS;
  return { enabled: true, provider, decision, timeoutMs };
}

/**
 * Runs the semantic preflight for already-validated enquiry fields. Never
 * throws. The result carries only statuses, categories and static templates.
 */
export async function runIntakePreflight(env, fields, { fetchImpl = fetch, now = Date.now } = {}) {
  const base = { version: PREFLIGHT_VERSION, status: 'skipped', categories: [], messages: [] };
  const config = preflightConfig(env);
  if (!config.enabled) return { ...base, outcome: config.reason, provider: null, latencyMs: 0 };

  const state = buildPreflightState(fields);
  let result;
  try {
    result = await requestTypedDecision(
      config.decision,
      { state, questions: buildPreflightQuestions(state) },
      { fetchImpl, timeoutMs: config.timeoutMs, now },
    );
  } catch {
    result = { ok: false, code: 'unexpected', durationMs: 0 };
  }
  if (!result.ok) {
    return { ...base, outcome: result.code, provider: config.provider, latencyMs: result.durationMs ?? 0 };
  }
  const decision = decidePreflight(result.answers, state);
  return {
    ...base,
    status: decision.status,
    categories: decision.categories,
    messages: decision.status === 'clarify' ? clarificationMessages(decision.categories) : [],
    outcome: decision.status === 'skipped' ? (decision.reason ?? 'answer_invalid') : 'ok',
    provider: config.provider,
    latencyMs: result.durationMs,
    costUsd: result.costUsd ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBMIT_CHOICES = new Set(['unchanged', 'corrected', 'send_anyway']);

/** The reference count the browser reports for a preflight (files are not sent). */
export function readPreflightReferenceCount(form) {
  const raw = Number.parseInt(String(form?.get?.('referenceCount') ?? ''), 10);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 3) : 0;
}

/** The browser's note on the final submit: which preflight it followed and what the client did. */
export function readPreflightFollowUp(form) {
  const id = String(form?.get?.('preflightId') ?? '').trim();
  const choice = String(form?.get?.('preflightChoice') ?? '').trim();
  if (!UUID_RE.test(id) || !SUBMIT_CHOICES.has(choice)) return null;
  return { id, choice };
}

/** Metadata-only telemetry row; fire-and-forget, never blocks the answer. */
export function recordPreflight(supabase, { id, formPath, result }, schedule) {
  if (!supabase || typeof schedule !== 'function') return;
  const event = {
    id,
    version: result.version,
    form_path: formPath,
    status: result.status,
    categories: result.categories,
    provider: result.provider ?? null,
    outcome: /^[a-z0-9_]{1,40}$/.test(result.outcome ?? '') ? result.outcome : 'unexpected',
    latency_ms: Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs) : null,
  };
  try {
    schedule(supabase.rpc('service_record_intake_preflight', { p_event: event }).catch(() => null));
  } catch { /* telemetry is optional */ }
}

export function markPreflightSubmitted(supabase, followUp, enquiryId, schedule) {
  if (!supabase || !followUp || typeof schedule !== 'function') return;
  try {
    schedule(supabase.rpc('service_mark_intake_preflight_submitted', {
      p_event_id: followUp.id, p_choice: followUp.choice, p_enquiry_id: enquiryId ?? null,
    }).catch(() => null));
  } catch { /* telemetry is optional */ }
}
