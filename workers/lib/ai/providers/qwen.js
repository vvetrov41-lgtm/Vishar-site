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

import { ENQUIRY_AI_TRANSPORT_SCHEMA } from '../enquiry-schema.js';
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
  return {
    binding,
    model,
    // Server-side shaping for structured calls. Both default to the behaviour
    // this adapter has always had; neither changes what the model is asked.
    structuredThinking: env?.AI_QWEN_STRUCTURED_THINKING === 'off' ? 'off' : 'default',
    enquirySchemaMode: ['full', 'transport', 'object'].includes(env?.AI_QWEN_ENQUIRY_SCHEMA)
      ? env.AI_QWEN_ENQUIRY_SCHEMA : 'full',
  };
}

/** The request a structured Qwen call actually sends, after config and experiment shaping. */
export function shapeStructuredRequest(config, request) {
  const schemaMode = request.schemaMode && request.schemaMode !== 'default'
    ? request.schemaMode : config.enquirySchemaMode ?? 'full';
  const thinking = request.thinking && request.thinking !== 'default'
    ? request.thinking : config.structuredThinking ?? 'default';
  let shaped = request;
  if (request.responseSchema) {
    if (schemaMode === 'transport') shaped = { ...request, responseSchema: ENQUIRY_AI_TRANSPORT_SCHEMA };
    if (schemaMode === 'object') shaped = { ...request, responseSchema: null };
  }
  return { request: shaped, thinking };
}

export async function invoke({ config, request, signal }) {
  // Every structured Qwen task is an extraction task, including reference-image
  // analysis. Previously only tasks carrying a transport JSON schema got these
  // bounds, so vision extraction could spend its whole lease reasoning and then
  // return prose that failed JSON validation. Keep reasoning low and request
  // JSON mode for all structured calls, whether or not a JSON Schema is present.
  const boundedExtraction = request.responseFormat === 'json';
  if (!boundedExtraction) {
    return callBindingModel({ binding: config.binding, model: config.model, request, signal });
  }
  const shaped = shapeStructuredRequest(config, request);
  return callBindingModel({
    binding: config.binding,
    model: config.model,
    request: shaped.request,
    signal,
    jsonMode: true,
    // With thinking off there is no reasoning budget to bound.
    reasoningEffort: shaped.thinking === 'off' ? null : 'low',
    disableThinking: shaped.thinking === 'off',
    useMaxCompletionTokens: true,
  });
}

export const __testing = Object.freeze({ DEFAULT_VISION_MODEL, DEFAULT_TEXT_MODEL });
