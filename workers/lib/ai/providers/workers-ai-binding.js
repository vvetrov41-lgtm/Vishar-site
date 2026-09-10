// Shared transport for Cloudflare-hosted models on the `AI` binding.
//
// Three logical provider tiers now execute here — the incumbent Llama tier,
// DeepSeek and Qwen — because Cloudflare hosts all three. The binding is the
// transport; it is deliberately not the abstraction. Each tier keeps its own
// adapter with its own model identifiers, modalities and configuration keys, so
// the router still selects a *provider*, and moving one tier back to a vendor
// API later touches only that adapter.
//
// No API key exists on this path. `env.AI` is a binding, billed through the
// Cloudflare account, so a tier is "configured" exactly when the binding is
// present.
//
// The binding takes no AbortSignal, so the router's timeout is applied by
// racing the call rather than cancelling it.

import { ProviderError } from '../errors.js';

/** Model ids are `@cf/<publisher>/<model>`, or a bare vendor path for routed third parties. */
export const CF_MODEL_RE = /^@[a-z0-9-]+\/[A-Za-z0-9._/-]{2,80}$/;

export function resolveModel(env, key, fallback) {
  const configured = typeof env?.[key] === 'string' ? env[key].trim() : '';
  return CF_MODEL_RE.test(configured) ? configured : fallback;
}

/** A tier backed by the binding is available exactly when the binding is. */
export function bindingFor(env) {
  return typeof env?.AI?.run === 'function' ? env.AI : null;
}

function userContent(request) {
  if (!request.images.length) return request.input;
  // Documented multimodal shape for the Cloudflare-hosted vision models: one
  // text part plus an image part carrying an inline data URI.
  return [
    { type: 'text', text: request.input },
    ...request.images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
    })),
  ];
}

/**
 * Cloudflare-hosted models do not all answer in one shape. Llama returns
 * `{response}`; the newer chat/reasoning models can answer OpenAI-style, and a
 * vision model may split the turn into content parts. Normalising all of them
 * here is what keeps the shape out of the router and out of CRM code.
 */
export function normalizeBindingResponse(payload) {
  if (payload === null || payload === undefined) {
    throw new ProviderError('provider_malformed_response');
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) throw new ProviderError('provider_empty_response');
    return { text: trimmed, finishReason: 'stop' };
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError('provider_malformed_response');
  }

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const candidate = typeof payload.response === 'string'
    ? payload.response
    : choice?.message?.content ?? payload.response ?? payload.result;

  const text = typeof candidate === 'string'
    ? candidate
    : Array.isArray(candidate)
      ? candidate.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : candidate && typeof candidate === 'object'
        ? JSON.stringify(candidate)
        : '';

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    // A well-formed envelope with nothing in it is an empty answer, not a
    // protocol failure; the router treats the two differently.
    const known = 'response' in payload || 'choices' in payload || 'result' in payload;
    throw new ProviderError(known ? 'provider_empty_response' : 'provider_malformed_response');
  }

  const finishReason = typeof choice?.finish_reason === 'string'
    ? choice.finish_reason.slice(0, 40)
    : 'stop';

  return { text: trimmed, finishReason };
}

/**
 * One attempt against the binding. Never retries: a chain must not be able to
 * multiply Workers AI neuron spend behind the router's back.
 */
export async function callBindingModel({
  binding, model, request, signal, jsonMode = false,
  reasoningEffort = null, useMaxCompletionTokens = false,
}) {
  if (signal?.aborted) throw new ProviderError('provider_timeout');

  const input = {
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: userContent(request) },
    ],
  };
  if (useMaxCompletionTokens) input.max_completion_tokens = request.maxOutputTokens;
  else input.max_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') input.temperature = request.temperature;
  if (['low', 'medium', 'high'].includes(reasoningEffort)) input.reasoning_effort = reasoningEffort;
  if (jsonMode && request.responseFormat === 'json') {
    input.response_format = request.responseSchema && typeof request.responseSchema === 'object'
      ? { type: 'json_schema', json_schema: request.responseSchema }
      : { type: 'json_object' };
  }

  let payload;
  try {
    payload = await binding.run(model, input);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new ProviderError('provider_timeout');
    }
    // The binding surfaces capacity, billing-tier and unknown-model problems as
    // exceptions. The message may name the account or the model, so it is
    // collapsed to a bounded code and never propagated.
    throw new ProviderError('provider_unavailable');
  }

  return { ...normalizeBindingResponse(payload), model };
}

export const __testing = Object.freeze({ userContent, CF_MODEL_RE });
