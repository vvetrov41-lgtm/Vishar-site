// Capability router.
//
// One entry point for every model call in the system. Callers name a task; the
// router picks the provider, enforces the cost ceiling, normalises the answer
// and emits sanitized telemetry. Provider-specific URLs, auth, request bodies,
// response shapes, model identifiers and error strings stop at the adapter
// boundary and never reach a caller.
//
// Failure policy, in order of importance:
//
//   * a bad request never reaches a provider;
//   * one attempt per provider, at most two providers per request;
//   * fallback only for a failure the next provider could plausibly survive;
//   * a structured task that returns unparseable output is a failure, not a
//     result, so schema-shaped callers can trust what they get;
//   * exhausting the chain returns a bounded error object; the router does not
//     throw into the request path.

import { ProviderError, toProviderErrorCode } from './errors.js';
import { ENQUIRY_AI_RESPONSE_SCHEMA } from './enquiry-schema.js';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ATTEMPTS_PER_PROVIDER,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_INPUT_CHARS,
  MAX_PROVIDERS_PER_REQUEST,
  MAX_SYSTEM_CHARS,
  TASK_NAMES,
  resolveTask,
} from './tasks.js';
import * as deepseek from './providers/deepseek.js';
import * as openai from './providers/openai.js';
import * as qwen from './providers/qwen.js';
import * as workersAi from './providers/workers-ai.js';

export const PROVIDERS = Object.freeze({
  [deepseek.id]: deepseek,
  [qwen.id]: qwen,
  [openai.id]: openai,
  [workersAi.id]: workersAi,
});

export const PROVIDER_IDS = Object.freeze(new Set(Object.keys(PROVIDERS)));

/** Failures the next provider in the chain might survive. */
const FALLBACK_CODES = new Set([
  'provider_timeout',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_http_error',
  'provider_malformed_response',
  'provider_empty_response',
  'output_invalid',
]);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MIME_TYPES = new Set(ALLOWED_IMAGE_MIME_TYPES);

/** Model ids carry `@`, `/` and `.`; telemetry takes a bounded token instead. */
export function modelToken(model) {
  if (typeof model !== 'string' || !model) return 'unknown';
  const token = model.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+/, '').slice(0, 60);
  return token || 'unknown';
}

function base64ByteLength(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

/**
 * Bounds the request before any provider is contacted. Oversized prompts and
 * oversized or unsupported images are rejected here rather than being paid for.
 */
export function normalizeRequest(plan, input) {
  const system = typeof input?.system === 'string' ? input.system.trim() : '';
  const text = typeof input?.input === 'string' ? input.input.trim() : '';
  if (!system || system.length > MAX_SYSTEM_CHARS) return { error: 'request_invalid' };
  if (!text || text.length > MAX_INPUT_CHARS) return { error: 'request_invalid' };

  const rawImages = Array.isArray(input?.images) ? input.images : [];
  if (plan.modality !== 'vision' && rawImages.length) return { error: 'request_invalid' };
  if (plan.modality === 'vision' && (rawImages.length < 1 || rawImages.length > MAX_IMAGES)) {
    return { error: 'request_invalid' };
  }

  const images = [];
  for (const image of rawImages) {
    const mimeType = typeof image?.mimeType === 'string' ? image.mimeType : '';
    const dataBase64 = typeof image?.dataBase64 === 'string' ? image.dataBase64 : '';
    if (!IMAGE_MIME_TYPES.has(mimeType)) return { error: 'request_invalid' };
    if (!dataBase64 || !BASE64_RE.test(dataBase64)) return { error: 'request_invalid' };
    if (base64ByteLength(dataBase64) > MAX_IMAGE_BYTES) return { error: 'request_invalid' };
    images.push({ mimeType, dataBase64 });
  }

  return {
    request: Object.freeze({
      system,
      input: text,
      images: Object.freeze(images),
      maxOutputTokens: plan.maxOutputTokens,
      temperature: plan.temperature,
      responseFormat: plan.structured ? 'json' : 'text',
      responseSchema: plan.task === 'enquiry_intake' ? ENQUIRY_AI_RESPONSE_SCHEMA : null,
    }),
  };
}

/** Tolerates a fenced ```json block, which several models emit despite instructions. */
export function parseStructuredOutput(text, requiredKeys = []) {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return null;
  }
  return parsed;
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function attemptProvider({ provider, config, plan, request, fetchImpl, now }) {
  const startedAt = now();
  const { signal, clear } = withTimeout(plan.timeoutMs);
  try {
    const raced = await Promise.race([
      provider.invoke({ config, request, fetchImpl, signal }),
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderError('provider_timeout')), { once: true });
      }),
    ]);
    return { ok: true, result: raced, durationMs: Math.max(0, Math.round(now() - startedAt)) };
  } catch (error) {
    return {
      ok: false,
      errorCode: toProviderErrorCode(error),
      durationMs: Math.max(0, Math.round(now() - startedAt)),
    };
  } finally {
    clear();
  }
}

/**
 * Runs one task. Returns a result object in every case, including total failure,
 * so a caller can degrade without a try/catch around the request path.
 */
export async function runModelTask(env, taskName, input = {}, deps = {}) {
  const {
    fetchImpl = fetch,
    logger = null,
    reporter = null,
    now = () => Date.now(),
    requiredKeys = [],
    validateJson = null,
  } = deps;

  const startedAt = now();
  const attempts = [];
  const plan = resolveTask(env, taskName, PROVIDER_IDS);

  const fail = async (errorCode, task = typeof taskName === 'string' ? taskName.slice(0, 64) : 'unknown') => {
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    logger?.error?.('ai.router.failed', {
      task, errorCode, durationMs, providerAttempts: attempts.length, fallbackUsed: attempts.length > 1,
    });
    await reporter?.capture?.('ai.router.failed', { operation: task, errorCode, durationMs });
    return Object.freeze({ ok: false, task, errorCode, attempts: Object.freeze(attempts), durationMs });
  };

  if (!plan) return fail('task_unknown');

  const normalized = normalizeRequest(plan, input);
  if (normalized.error) return fail(normalized.error, plan.task);

  const candidates = plan.chain
    .map((id) => {
      const provider = PROVIDERS[id];
      const config = provider ? provider.configure(env, plan.modality) : null;
      return config ? { provider, config } : null;
    })
    .filter(Boolean)
    .slice(0, MAX_PROVIDERS_PER_REQUEST);

  if (!candidates.length) return fail('no_provider_configured', plan.task);

  for (const candidate of candidates) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_PROVIDER; attempt += 1) {
      const outcome = await attemptProvider({
        provider: candidate.provider,
        config: candidate.config,
        plan,
        request: normalized.request,
        fetchImpl,
        now,
      });

      const record = {
        provider: candidate.provider.id,
        model: modelToken(candidate.config.model),
        durationMs: outcome.durationMs,
        outcome: outcome.ok ? 'succeeded' : 'failed',
        errorCode: outcome.errorCode ?? null,
      };

      if (outcome.ok && plan.structured) {
        const json = parseStructuredOutput(outcome.result.text, requiredKeys);
        let valid = Boolean(json);
        if (valid && typeof validateJson === 'function') {
          try {
            valid = Boolean(validateJson(json));
          } catch {
            valid = false;
          }
        }
        if (!valid) {
          record.outcome = 'failed';
          record.errorCode = 'output_invalid';
          attempts.push(record);
          logger?.warn?.('ai.router.attempt', {
            task: plan.task, provider: record.provider, model: record.model,
            outcome: record.outcome, errorCode: record.errorCode, durationMs: record.durationMs,
          });
          continue;
        }
        outcome.result.json = json;
      }

      attempts.push(record);
      logger?.[outcome.ok ? 'info' : 'warn']?.('ai.router.attempt', {
        task: plan.task, provider: record.provider, model: record.model,
        outcome: record.outcome, errorCode: record.errorCode, durationMs: record.durationMs,
      });

      if (record.outcome === 'succeeded') {
        const durationMs = Math.max(0, Math.round(now() - startedAt));
        const fallbackUsed = attempts.length > 1;
        logger?.info?.('ai.router.completed', {
          task: plan.task, capability: plan.capability, provider: record.provider, model: record.model,
          fallbackUsed, providerAttempts: attempts.length, durationMs,
          outputChars: outcome.result.text.length, imageCount: normalized.request.images.length,
        });
        await reporter?.capture?.('ai.router.completed', {
          operation: plan.task, provider: record.provider, model: record.model,
          fallbackUsed: fallbackUsed ? 'yes' : 'no', outcome: 'succeeded', durationMs,
        });
        return Object.freeze({
          ok: true,
          task: plan.task,
          capability: plan.capability,
          provider: record.provider,
          model: candidate.config.model,
          modelToken: record.model,
          text: outcome.result.text,
          json: outcome.result.json ?? null,
          finishReason: outcome.result.finishReason ?? 'unknown',
          fallbackUsed,
          attempts: Object.freeze(attempts),
          durationMs,
        });
      }

      if (!FALLBACK_CODES.has(record.errorCode)) {
        return fail(record.errorCode, plan.task);
      }
    }
  }

  return fail('all_providers_failed', plan.task);
}

/**
 * Configuration readback. Reports which providers are usable and how each task
 * currently routes. Booleans only: a key's presence is operational state, its
 * value is a secret and is never read into the result.
 */
export function describeRouting(env) {
  const providers = Object.values(PROVIDERS).map((provider) => ({
    provider: provider.id,
    modalities: [...provider.modalities].sort(),
    configured: ['text', 'vision'].some((modality) => provider.configure(env, modality) !== null),
  }));

  const tasks = TASK_NAMES.map((taskName) => {
    const plan = resolveTask(env, taskName, PROVIDER_IDS);
    const usable = plan.chain.filter((id) => PROVIDERS[id]?.configure(env, plan.modality) !== null);
    return {
      task: plan.task,
      capability: plan.capability,
      modality: plan.modality,
      chain: [...plan.chain],
      routeSource: plan.routeSource,
      selected: usable[0] ?? null,
      fallback: usable[1] ?? null,
      available: usable.length > 0,
    };
  });

  return {
    maxProvidersPerRequest: MAX_PROVIDERS_PER_REQUEST,
    attemptsPerProvider: ATTEMPTS_PER_PROVIDER,
    providers,
    tasks,
  };
}

export const __testing = Object.freeze({ FALLBACK_CODES, base64ByteLength });
