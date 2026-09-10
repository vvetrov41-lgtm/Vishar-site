// Llama tier — the incumbent Cloudflare-hosted general text model.
//
// This is what the public site has always used, and it stays the cheap,
// high-volume tier: short assistant replies do not need a frontier model. It is
// also the safety net, because it shares the `AI` binding with the DeepSeek and
// Qwen tiers but is not gated behind a paid plan.
//
// The model is `-fast`: Cloudflare retired `@cf/meta/llama-3.1-8b-instruct` on
// 2026-05-30, and the deprecation notice names the `-fast` variants as the ones
// that stay active.

import { ENQUIRY_AI_TRANSPORT_SCHEMA } from '../enquiry-schema.js';
import { bindingFor, callBindingModel, resolveModel } from './workers-ai-binding.js';

export const id = 'workers_ai';
export const modalities = Object.freeze(new Set(['text']));

const DEFAULT_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const binding = bindingFor(env);
  if (!binding) return null;
  return { binding, model: resolveModel(env, 'AI_MODEL_WORKERS_AI_TEXT', DEFAULT_TEXT_MODEL) };
}

export async function invoke({ config, request, signal }) {
  const transportRequest = request.responseSchema
    ? { ...request, responseSchema: ENQUIRY_AI_TRANSPORT_SCHEMA }
    : request;
  return callBindingModel({
    binding: config.binding,
    model: config.model,
    request: transportRequest,
    signal,
    jsonMode: request.responseFormat === 'json',
  });
}

export const __testing = Object.freeze({ DEFAULT_TEXT_MODEL });
