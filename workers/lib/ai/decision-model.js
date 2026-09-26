// Decision-model transport (OpenRouter Decisions API, TypeSafe Jev candidate).
//
// Not wired into any production path. The spec's privacy gate
// (specs/crm-ai-architecture/decision-layer.md) must be passed before real
// client text is sent to this processor, and the first integration is shadow
// only: decisions go to telemetry and change nothing the operator sees.
//
// Hot-path rules: one attempt, short timeout, no retry, fail-closed. Any
// transport problem returns a bounded code and the caller keeps the existing
// path. The request body and the answer are never logged.

import { DECISION_CONTRACT_VERSION, buildQuestions, decide } from './decision-contract.js';

export const DECISION_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_KEY_LENGTH = 20;
const MODEL_RE = /^[a-z0-9-]+\/[a-z0-9._-]{1,60}$/;
const SERVED_RE = /^[A-Za-z0-9._/-]{1,80}$/;

export function decisionModelConfig(env) {
  const apiKey = typeof env?.DECISION_MODEL_API_KEY === 'string' ? env.DECISION_MODEL_API_KEY.trim() : '';
  if (apiKey.length < MIN_KEY_LENGTH) return null;
  const configured = typeof env?.DECISION_MODEL === 'string' ? env.DECISION_MODEL.trim() : '';
  return { apiKey, model: MODEL_RE.test(configured) ? configured : DEFAULT_DECISION_MODEL };
}

/**
 * One typed decision call: { state, questions } in, raw answers out. Shared by
 * every decision contract (CRM next step, intake preflight) so transport
 * rules live in one place. Returns
 * { ok: true, answers, model, provider, durationMs, costUsd, inputTokens }
 * or { ok: false, code, durationMs }. Never logs the body or the answer.
 */
export async function requestTypedDecision(config, { state, questions }, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  if (!config) return { ok: false, code: 'not_configured', durationMs: 0 };
  if (!state || typeof state !== 'object' || !questions || typeof questions !== 'object') {
    return { ok: false, code: 'request_invalid', durationMs: 0 };
  }
  const startedAt = now();
  let response;
  try {
    response = await fetchImpl(DECISION_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, code, durationMs: now() - startedAt };
  }
  const durationMs = now() - startedAt;
  // A redirect is never followed: the key must not reach another origin.
  if (response.status >= 300 && response.status < 400) return { ok: false, code: 'redirect_refused', durationMs };
  if (!response.ok) {
    const code = response.status === 429 ? 'rate_limited'
      : response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 402 ? 'payment_required'
          : response.status >= 500 ? 'provider_error' : 'http_error';
    return { ok: false, code, durationMs };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, code: 'malformed', durationMs };
  }
  if (!data?.answers || typeof data.answers !== 'object') return { ok: false, code: 'answer_invalid', durationMs };
  const cost = Number(data?.usage?.cost);
  const tokens = Number(data?.usage?.input_tokens);
  return {
    ok: true,
    answers: data.answers,
    model: typeof data?.model === 'string' && SERVED_RE.test(data.model) ? data.model : config.model,
    provider: typeof data?.provider === 'string' && SERVED_RE.test(data.provider) ? data.provider : null,
    durationMs,
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    inputTokens: Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null,
  };
}

/**
 * One decision for one minimal state. Returns either
 * { ok: true, decision, model, provider, durationMs, costUsd, inputTokens, contract }
 * or { ok: false, code, durationMs }. `decision` is the fail-closed typed
 * result of `decide`, which may abstain on any question.
 */
export async function requestDecision(config, state, options = {}) {
  if (!config) return { ok: false, code: 'not_configured', durationMs: 0 };
  if (!Array.isArray(state?.allowed_actions) || !state.allowed_actions.length) {
    return { ok: false, code: 'no_allowed_actions', durationMs: 0 };
  }
  const result = await requestTypedDecision(config, { state, questions: buildQuestions(state.allowed_actions) }, options);
  if (!result.ok) return result;
  const decision = decide(result.answers, state.allowed_actions);
  if (decision.invalid) return { ok: false, code: 'answer_invalid', durationMs: result.durationMs };
  const { answers: _answers, ...meta } = result;
  return { ...meta, decision, contract: DECISION_CONTRACT_VERSION };
}

export const __testing = Object.freeze({ MIN_KEY_LENGTH, DEFAULT_TIMEOUT_MS });
