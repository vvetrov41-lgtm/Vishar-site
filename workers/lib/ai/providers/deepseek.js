// DeepSeek tier — Cloudflare-hosted.
//
// Runs DeepSeek V4 Flash through the account's existing `AI` binding, so the
// CRM needs no DeepSeek account, no egress to the vendor's own endpoint and no
// vendor API key. It stays a distinct provider tier rather than "another
// Workers AI model": the router selects it by name, its model id is configured
// separately, and pointing it back at a vendor endpoint would be a change to
// this file alone.
//
// Cost note, because it inverts the usual assumption: on Workers AI this model
// is $0.44/M in and $1.32/M out, several times the Llama 8B tier. It earns that
// on reasoning, extraction and long-context work (1.3M token window), not on
// short public assistant replies. The task chains in ../tasks.js reflect that.
//
// Paid access: Cloudflare gates this model behind the Workers Paid plan or
// prepaid AI Gateway credits. On an account without either, the binding throws
// and the router falls through to the next tier — which is why it is never
// alone in a chain.

import { bindingFor, callBindingModel, resolveModel } from './workers-ai-binding.js';

export const id = 'deepseek';
export const modalities = Object.freeze(new Set(['text']));

const DEFAULT_TEXT_MODEL = '@cf/deepseek-ai/deepseek-v4-flash-0731';

export function configure(env, modality) {
  if (!modalities.has(modality)) return null;
  const binding = bindingFor(env);
  if (!binding) return null;
  return { binding, model: resolveModel(env, 'AI_MODEL_DEEPSEEK_TEXT', DEFAULT_TEXT_MODEL) };
}

export async function invoke({ config, request, signal }) {
  return callBindingModel({ binding: config.binding, model: config.model, request, signal });
}

export const __testing = Object.freeze({ DEFAULT_TEXT_MODEL });
