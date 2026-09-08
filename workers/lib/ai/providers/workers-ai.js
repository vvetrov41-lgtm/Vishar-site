// Workers AI adapter — the incumbent path.
//
// This is what the public site has always used: the `AI` binding declared in
// wrangler.toml running Llama 3.1 8B. It needs no API key, bills through the
// existing Cloudflare account and stays reachable when every external provider
// is unconfigured or down. That is why it is the last link in the two live
// public chains: with no new secrets in place the site behaves exactly as before.
//
// The binding has no AbortSignal, so the router's timeout is applied by racing
// the call rather than cancelling it.

import { ProviderError } from '../errors.js';

export const id = 'workers_ai';
export const modalities = Object.freeze(new Set(['text']));

const DEFAULT_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MODEL_RE = /^@[a-z0-9]+\/[A-Za-z0-9._/-]{2,80}$/;

function modelFor(env) {
  const configured = typeof env?.AI_MODEL_WORKERS_AI_TEXT === 'string' ? env.AI_MODEL_WORKERS_AI_TEXT.trim() : '';
  return MODEL_RE.test(configured) ? configured : DEFAULT_TEXT_MODEL;
}

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  if (typeof env?.AI?.run !== 'function') return null;
  return { binding: env.AI, model: modelFor(env) };
}

export async function invoke({ config, request, signal }) {
  if (signal?.aborted) throw new ProviderError('provider_timeout');

  let payload;
  try {
    payload = await config.binding.run(config.model, {
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.input },
      ],
      max_tokens: request.maxOutputTokens,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new ProviderError('provider_timeout');
    }
    throw new ProviderError('provider_unavailable');
  }

  const text = typeof payload?.response === 'string' ? payload.response : '';
  if (!text) {
    throw new ProviderError(payload && typeof payload === 'object' ? 'provider_empty_response' : 'provider_malformed_response');
  }

  return { text: text.trim(), model: config.model, finishReason: 'stop' };
}

export const __testing = Object.freeze({ DEFAULT_TEXT_MODEL, MODEL_RE });
