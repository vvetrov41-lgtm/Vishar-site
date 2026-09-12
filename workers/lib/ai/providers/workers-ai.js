// Cloudflare-hosted fallback tier.
//
// Short, high-volume text work stays on the incumbent Llama model. Vision uses
// Gemma 4 as the independent Cloudflare-hosted fallback behind Qwen, so a Qwen
// capacity/model failure does not strand reference-image analysis when no
// external OpenAI key is configured.

import { ENQUIRY_AI_TRANSPORT_SCHEMA } from '../enquiry-schema.js';
import { bindingFor, callBindingModel, resolveModel } from './workers-ai-binding.js';

export const id = 'workers_ai';
export const modalities = Object.freeze(new Set(['text', 'vision']));

const DEFAULT_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const DEFAULT_VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const binding = bindingFor(env);
  if (!binding) return null;
  const model = modality === 'vision'
    ? resolveModel(env, 'AI_MODEL_WORKERS_AI_VISION', DEFAULT_VISION_MODEL)
    : resolveModel(env, 'AI_MODEL_WORKERS_AI_TEXT', DEFAULT_TEXT_MODEL);
  return { binding, model };
}

export async function invoke({ config, request, signal }) {
  const transportRequest = request.responseSchema
    ? { ...request, responseSchema: ENQUIRY_AI_TRANSPORT_SCHEMA }
    : request;
  const structured = request.responseFormat === 'json';
  return callBindingModel({
    binding: config.binding,
    model: config.model,
    request: transportRequest,
    signal,
    jsonMode: structured,
    reasoningEffort: structured ? 'low' : null,
    useMaxCompletionTokens: structured,
  });
}

export const __testing = Object.freeze({ DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL });
