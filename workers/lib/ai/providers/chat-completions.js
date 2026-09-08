// Shared transport for chat-completions-style HTTP providers.
//
// DeepSeek, Qwen (DashScope compatible mode) and OpenAI all speak the same wire
// protocol, so the request/response mechanics live here once. Everything that
// actually differs between them — base URL, auth header, model identifiers,
// which modalities they may serve — stays in the adapter that owns it. Nothing
// in this file is imported by CRM business logic.

import { ProviderError, providerErrorCodeForStatus } from '../errors.js';

/** A provider response larger than this is treated as malformed rather than parsed. */
const MAX_RESPONSE_BYTES = 256 * 1024;

function contentPartsFor(request) {
  if (!request.images.length) return request.input;
  return [
    { type: 'text', text: request.input },
    ...request.images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
    })),
  ];
}

export function buildChatCompletionsBody(model, request) {
  const body = {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: contentPartsFor(request) },
    ],
    max_tokens: request.maxOutputTokens,
    stream: false,
  };
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (request.responseFormat === 'json') body.response_format = { type: 'json_object' };
  return body;
}

function normalize(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;

  // Qwen VL returns the assistant turn as content parts rather than a string.
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : '';

  if (typeof text !== 'string') throw new ProviderError('provider_malformed_response');
  const trimmed = text.trim();
  if (!trimmed) throw new ProviderError('provider_empty_response');

  return {
    text: trimmed,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : 'unknown',
  };
}

/**
 * One attempt. The caller owns the timeout and the abort signal; this function
 * never retries, so a chain can never quietly multiply a provider bill.
 */
export async function callChatCompletions({ url, apiKey, model, request, fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionsBody(model, request)),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new ProviderError('provider_timeout');
    }
    throw new ProviderError('provider_unavailable');
  }

  if (!response?.ok) {
    throw new ProviderError(providerErrorCodeForStatus(Number(response?.status) || 0));
  }

  let raw;
  try {
    raw = await response.text();
  } catch {
    throw new ProviderError('provider_malformed_response');
  }
  if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_BYTES) {
    throw new ProviderError('provider_malformed_response');
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ProviderError('provider_malformed_response');
  }

  return { ...normalize(payload), model };
}

export const __testing = Object.freeze({ MAX_RESPONSE_BYTES, normalize });
