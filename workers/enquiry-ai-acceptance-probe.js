const TOKEN = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const PROBE_PATH = '/drain';
const AI_DRAIN_URL = 'https://tattooai.internal/internal/enquiry-ai/drain';

function json(status, value) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function unavailable(code) {
  return json(502, { ok: false, processed: 0, errorCode: code });
}

function authorized(request, env) {
  const token = typeof env?.PROBE_TOKEN === 'string' ? env.PROBE_TOKEN.trim() : '';
  return TOKEN.test(token)
    && request.headers.get('authorization') === `Bearer ${token}`;
}

function normalizeSummary(value) {
  if (!value || typeof value !== 'object'
      || typeof value.ok !== 'boolean'
      || !Number.isInteger(value.processed)
      || value.processed < 0
      || value.processed > 3) return null;
  if (value.ok === false && !SAFE_CODE.test(value.errorCode || '')) return null;
  return value.ok
    ? { ok: true, processed: value.processed }
    : { ok: false, processed: value.processed, errorCode: value.errorCode };
}

export default {
  async fetch(request, env) {
    let url;
    try { url = new URL(request.url); } catch { return json(404, { error: 'not_found' }); }
    if (request.method !== 'POST' || url.pathname !== PROBE_PATH || url.search || url.hash
        || !authorized(request, env)) {
      return json(404, { error: 'not_found' });
    }
    if (!env?.TATTOOAI_SERVICE || typeof env.TATTOOAI_SERVICE.fetch !== 'function') {
      return unavailable('tattooai_service_binding_unavailable');
    }
    try {
      const response = await env.TATTOOAI_SERVICE.fetch(AI_DRAIN_URL, { method: 'POST' });
      if (!response?.ok) return unavailable('tattooai_service_unavailable');
      const summary = normalizeSummary(await response.json());
      return summary ? json(summary.ok ? 200 : 502, summary) : unavailable('enquiry_ai_drain_summary_invalid');
    } catch {
      return unavailable('enquiry_ai_drain_probe_failed');
    }
  },
};

export const __testing = Object.freeze({
  AI_DRAIN_URL,
  PROBE_PATH,
  normalizeSummary,
});
