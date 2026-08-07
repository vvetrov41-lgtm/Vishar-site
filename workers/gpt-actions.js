import { handleGptActionsRequest } from './lib/gpt-actions.js';

export function omitNullFields(value) {
  if (Array.isArray(value)) return value.map(omitNullFields);
  if (!value || typeof value !== 'object') return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== null) clean[key] = omitNullFields(child);
  }
  return clean;
}

export default {
  async fetch(request, env) {
    const response = await handleGptActionsRequest(request, env);
    const contentType = response.headers.get('content-type') || '';
    if (response.status < 200 || response.status >= 300 || !contentType.includes('application/json')) {
      return response;
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_gateway_response' }), {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return new Response(JSON.stringify(omitNullFields(parsed)), {
      status: response.status,
      headers: response.headers,
    });
  },
};
