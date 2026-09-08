// Qwen adapter — the multimodal tier.
//
// Reference-image and document understanding route here first. Alibaba's
// DashScope exposes an OpenAI-compatible endpoint, so the wire mechanics are
// shared, but the model identifiers, region-selectable base URL and the
// vision/text model split belong to this adapter.
//
// Image generation is deliberately out of scope. This is understanding only.

import { callChatCompletions } from './chat-completions.js';

export const id = 'qwen';
export const modalities = Object.freeze(new Set(['vision', 'text']));

const DEFAULT_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'qwen-vl-plus';
const DEFAULT_TEXT_MODEL = 'qwen-plus';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const URL_RE = /^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\/[A-Za-z0-9/_-]{1,200}$/;
const MIN_KEY_LENGTH = 20;

function modelFor(env, modality) {
  const key = modality === 'vision' ? 'AI_MODEL_QWEN_VISION' : 'AI_MODEL_QWEN_TEXT';
  const fallback = modality === 'vision' ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL;
  const configured = typeof env?.[key] === 'string' ? env[key].trim() : '';
  return MODEL_RE.test(configured) ? configured : fallback;
}

/** The base URL is configurable across DashScope regions, but only within DashScope. */
function urlFor(env) {
  const configured = typeof env?.AI_QWEN_BASE_URL === 'string' ? env.AI_QWEN_BASE_URL.trim() : '';
  return URL_RE.test(configured) ? configured : DEFAULT_URL;
}

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const apiKey = typeof env?.QWEN_API_KEY === 'string' ? env.QWEN_API_KEY.trim() : '';
  if (apiKey.length < MIN_KEY_LENGTH) return null;
  return { apiKey, model: modelFor(env, modality), url: urlFor(env) };
}

export async function invoke({ config, request, fetchImpl, signal }) {
  return callChatCompletions({
    url: config.url,
    apiKey: config.apiKey,
    model: config.model,
    request,
    fetchImpl,
    signal,
  });
}

export const __testing = Object.freeze({
  DEFAULT_URL, DEFAULT_VISION_MODEL, DEFAULT_TEXT_MODEL, MIN_KEY_LENGTH, URL_RE,
});
