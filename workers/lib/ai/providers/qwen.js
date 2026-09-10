// Qwen tier — Cloudflare-hosted, multimodal.
//
// Runs Qwen 3.8 27B through the account's existing `AI` binding: no Alibaba
// account, no egress to the vendor's own endpoint, no vendor API key and no
// region base URL. Reference-image and document understanding route here first.
//
// The model is image-text-to-text with a 262K context window, so it also serves
// text when a chain asks for it, but understanding is the point. Nothing here
// generates images.
//
// Unlike the DeepSeek tier, Cloudflare does not gate this model behind Workers
// Paid, so it is reachable on the account's current plan.

import { bindingFor, callBindingModel, resolveModel } from './workers-ai-binding.js';

export const id = 'qwen';
export const modalities = Object.freeze(new Set(['vision', 'text']));

const DEFAULT_VISION_MODEL = '@cf/qwen/qwen3.8-27b';
const DEFAULT_TEXT_MODEL = '@cf/qwen/qwen3.8-27b';

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const binding = bindingFor(env);
  if (!binding) return null;
  const model = modality === 'vision'
    ? resolveModel(env, 'AI_MODEL_QWEN_VISION', DEFAULT_VISION_MODEL)
    : resolveModel(env, 'AI_MODEL_QWEN_TEXT', DEFAULT_TEXT_MODEL);
  return { binding, model };
}

export async function invoke({ config, request, signal }) {
  const boundedExtraction = request.responseSchema && request.responseFormat === 'json';
  return callBindingModel({
    binding: config.binding,
    model: config.model,
    request,
    signal,
    // Qwen is a reasoning model. CRM extraction needs deterministic structure,
    // not a long hidden deliberation that can consume the whole Worker lease.
    reasoningEffort: boundedExtraction ? 'low' : null,
    useMaxCompletionTokens: boundedExtraction,
  });
}

export const __testing = Object.freeze({ DEFAULT_VISION_MODEL, DEFAULT_TEXT_MODEL });
