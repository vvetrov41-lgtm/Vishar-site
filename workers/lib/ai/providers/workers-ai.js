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

// Models on this tier that think before answering by default. With thinking on,
// the reasoning spends the whole output budget and the answer arrives empty
// (live eval 2026-09-25: Gemma 4 and GLM 4.7 flash returned
// provider_empty_response on every intake and client-state call). The
// fallback tier needs a direct answer, so thinking is switched off for them.
const THINKING_MODEL_RE = /^@cf\/(google\/gemma-4|zai-org\/glm-|qwen\/qwen3)/;

export async function invoke({ config, request, signal }) {
  const thinkingModel = THINKING_MODEL_RE.test(config.model);
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
    reasoningEffort: structured && !thinkingModel ? 'low' : null,
    disableThinking: thinkingModel,
    useMaxCompletionTokens: structured,
  });
}

export const __testing = Object.freeze({ DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, THINKING_MODEL_RE });
