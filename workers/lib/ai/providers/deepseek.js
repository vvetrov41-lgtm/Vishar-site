// DeepSeek adapter — the low-cost text tier.
//
// Selected for bulk text work (drafting, summarising, extraction, classification)
// where the cheaper model is good enough and a fallback exists. It is never the
// only provider in a chain, and it never serves image work: `modalities` is the
// enforcement point, not a comment.

import { callChatCompletions } from './chat-completions.js';

export const id = 'deepseek';
export const modalities = Object.freeze(new Set(['text']));

const DEFAULT_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_TEXT_MODEL = 'deepseek-chat';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const MIN_KEY_LENGTH = 20;

function modelFor(env) {
  const configured = typeof env?.AI_MODEL_DEEPSEEK_TEXT === 'string' ? env.AI_MODEL_DEEPSEEK_TEXT.trim() : '';
  return MODEL_RE.test(configured) ? configured : DEFAULT_TEXT_MODEL;
}

/** Credentials come from the Worker environment only, never from a request. */
export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const apiKey = typeof env?.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (apiKey.length < MIN_KEY_LENGTH) return null;
  return { apiKey, model: modelFor(env), url: DEFAULT_URL };
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
