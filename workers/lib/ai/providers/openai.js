// OpenAI tier — the only external provider left, and entirely optional.
//
// The DeepSeek and Qwen tiers now run on the Cloudflare `AI` binding, so no
// chain depends on this adapter: an unconfigured provider is skipped during
// selection, never attempted. OPENAI_API_KEY buys a second opinion outside
// Cloudflare for reasoning and vision; without it those chains still resolve.

import { callChatCompletions } from './chat-completions.js';

export const id = 'openai';
export const modalities = Object.freeze(new Set(['text', 'vision']));

const DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TEXT_MODEL = 'gpt-4o-mini';
const DEFAULT_VISION_MODEL = 'gpt-4o-mini';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const MIN_KEY_LENGTH = 20;

function modelFor(env, modality) {
  const key = modality === 'vision' ? 'AI_MODEL_OPENAI_VISION' : 'AI_MODEL_OPENAI_TEXT';
  const fallback = modality === 'vision' ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL;
  const configured = typeof env?.[key] === 'string' ? env[key].trim() : '';
  return MODEL_RE.test(configured) ? configured : fallback;
}

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const apiKey = typeof env?.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (apiKey.length < MIN_KEY_LENGTH) return null;
  return { apiKey, model: modelFor(env, modality), url: DEFAULT_URL };
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

export const __testing = Object.freeze({ DEFAULT_URL, DEFAULT_TEXT_MODEL, MIN_KEY_LENGTH });
