// Production entrypoint wrapper for the public tattooai Worker.
//
// Platform-owned public surfaces are dispatched before the legacy router.
// `/book/{artist-slug}` is the canonical human-facing booking route behind the
// root-domain edge. `/forms/{uuid}` remains the legacy hosted compatibility path.
// Enquiry AI queue draining is not scheduled here. Production invokes the
// bounded internal drain endpoint through the existing shared CRM scheduler's
// Cloudflare Service Binding. The synthetic internal hostname is the capability
// boundary and never receives browser CORS.

import tattooai from './tattooai.js';
import { drainEnquiryAi } from './lib/enquiry-ai.js';
import { convergeClientAiBriefs, drainCrmAgent, recordAttentionShadow } from './lib/crm-agent.js';
import { getCorsHeaders, isRegistryBookingRequest } from './lib/http.js';
import { handleHostedBookingRequest, isHostedBookingPath } from './routes/hosted-booking.js';
import { handlePublicBookingRequest, isPublicBookingPath } from './routes/public-booking.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
} from './routes/appointment-client-action.js';
import {
  handleAiRouterProbeRequest,
  isAiRouterProbePath,
} from './routes/ai-router-probe.js';

const SAFE_CODE = /^[a-z][a-z0-9_]{2,63}$/;

// Public per-IP rate limits (audit M-8). Every browser-reachable request is
// counted: POST (enquiries, AI tools, client actions) against the write
// limiter, everything else against the generous read limiter. CORS preflights
// are never counted. Subrequests from Cloudflare Workers all share one egress
// address, so the first-party booking edges that proxy to this Worker would
// otherwise throttle every visitor together; they are not counted here.
// A missing or failing limiter never blocks a request.
const WORKER_EGRESS_PREFIX = '2a06:98c0:3600:';

export function rateLimitClass(request) {
  const method = String(request?.method || '').toUpperCase();
  if (method === 'OPTIONS') return null;
  return method === 'POST' ? 'write' : 'read';
}

async function enforcePublicRateLimit(request, env) {
  const kind = rateLimitClass(request);
  if (!kind) return null;
  const limiter = kind === 'write' ? env?.PUBLIC_WRITE_RATE_LIMIT : env?.PUBLIC_READ_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip || ip.startsWith(WORKER_EGRESS_PREFIX)) return null;
  let success = true;
  try {
    ({ success } = await limiter.limit({ key: `${kind}:${ip}` }));
  } catch {
    return null;
  }
  if (success) return null;
  const origin = request.headers.get('Origin') || '';
  return Response.json({ ok: false, code: 'rate_limited' }, {
    status: 429,
    headers: {
      ...getCorsHeaders(origin, env, request),
      'cache-control': 'no-store',
      'retry-after': '60',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function enforceSemanticPreflightRateLimit(request, env) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.searchParams.get('preflight') !== '1') return null;

  const ip = request.headers.get('CF-Connecting-IP') || '';
  // First-party booking Workers already enforce their own client-aware limit.
  // Counting their shared egress here would collapse all visitors into one key.
  if (ip.startsWith(WORKER_EGRESS_PREFIX)) return null;

  const origin = request.headers.get('Origin') || '';
  const headers = {
    ...getCorsHeaders(origin, env, request),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const limiter = env?.INTAKE_PREFLIGHT_RATE_LIMIT;
  if (!ip || !limiter || typeof limiter.limit !== 'function') {
    return Response.json({ ok: false, code: 'preflight_unavailable' }, { status: 503, headers });
  }
  try {
    const { success } = await limiter.limit({ key: `preflight:${ip}` });
    if (success) return null;
  } catch {
    return Response.json({ ok: false, code: 'preflight_unavailable' }, { status: 503, headers });
  }
  return Response.json({ ok: false, code: 'rate_limited' }, {
    status: 429,
    headers: { ...headers, 'retry-after': '60' },
  });
}
const AI_DRAIN_PATH = '/internal/enquiry-ai/drain';
const CRM_AGENT_DRAIN_PATH = '/internal/crm-agent/drain';
const AI_DRAIN_HOST = 'tattooai.internal';

function isInternalPath(request, pathname) {
  try {
    const url = new URL(request?.url ?? '');
    return url.protocol === 'https:'
      && url.hostname === AI_DRAIN_HOST
      && url.pathname === pathname
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function isInternalAiDrainRequest(request) {
  return isInternalPath(request, AI_DRAIN_PATH);
}

function isInternalCrmAgentDrainRequest(request) {
  return isInternalPath(request, CRM_AGENT_DRAIN_PATH);
}

async function handleInternalAiDrain(request, env) {
  if (env?.VISHAR_ENVIRONMENT !== 'production') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });

  const result = await drainEnquiryAi(env, { limit: 3 });
  const processed = Number.isInteger(result?.processed)
    ? Math.min(3, Math.max(0, result.processed))
    : 0;
  const payload = result?.errorCode
    ? { ok: false, processed, errorCode: SAFE_CODE.test(result.errorCode) ? result.errorCode : 'enquiry_ai_drain_failed' }
    : { ok: true, processed };
  return Response.json(payload, {
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

// Same shape and same capability boundary as the enquiry AI drain above: the
// synthetic internal hostname is unreachable from the public Worker URL, so
// this route never receives browser CORS.
async function handleInternalCrmAgentDrain(request, env) {
  if (env?.VISHAR_ENVIRONMENT !== 'production') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });

  const result = await drainCrmAgent(env, { limit: 2 });
  // Phase 2 shadow evidence: the database throttles this to one aggregate
  // record per hour. Counts only, fail-open, never affects the drain result.
  await recordAttentionShadow(env);
  // Phase 6a: stale briefs converge a few per hour; the next drains pick
  // the queued refreshes up like any other job.
  await convergeClientAiBriefs(env);
  const processed = Number.isInteger(result?.processed)
    ? Math.min(3, Math.max(0, result.processed))
    : 0;
  const payload = result?.errorCode
    ? { ok: false, processed, errorCode: SAFE_CODE.test(result.errorCode) ? result.errorCode : 'crm_agent_drain_failed' }
    : { ok: true, processed };
  return Response.json(payload, {
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (isInternalAiDrainRequest(request)) {
      return handleInternalAiDrain(request, env);
    }

    if (isInternalCrmAgentDrainRequest(request)) {
      return handleInternalCrmAgentDrain(request, env);
    }

    // Direct browser preflights receive a stricter paid-provider limiter.
    // Worker-to-Worker booking paths are already limited at their client edge.
    const preflightLimited = await enforceSemanticPreflightRateLimit(request, env);
    if (preflightLimited) return preflightLimited;

    // Operator-only model-routing readback. Answers 404 unless explicitly
    // enabled and token-authenticated, and never emits CORS headers.
    const limited = await enforcePublicRateLimit(request, env);
    if (limited) return limited;

    if (isAiRouterProbePath(request)) {
      return handleAiRouterProbeRequest(request, env, { fetchImpl: fetch });
    }

    if (isAppointmentClientActionPath(request)) {
      return handleAppointmentClientActionRequest(request, env, {});
    }

    if (isPublicBookingPath(request)) {
      return handlePublicBookingRequest(request, env, { schedule: (promise) => ctx.waitUntil(promise) });
    }

    if (isHostedBookingPath(request)) {
      return handleHostedBookingRequest(request, env, { schedule: (promise) => ctx.waitUntil(promise) });
    }

    if (request.method === 'OPTIONS' && isRegistryBookingRequest(request)) {
      const origin = request.headers.get('Origin') || '';
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin, env, request),
      });
    }

    return tattooai.fetch(request, env, ctx);
  },
};

export const __testing = Object.freeze({
  AI_DRAIN_HOST,
  AI_DRAIN_PATH,
  CRM_AGENT_DRAIN_PATH,
  handleInternalAiDrain,
  handleInternalCrmAgentDrain,
  isInternalAiDrainRequest,
  isInternalCrmAgentDrainRequest,
  enforcePublicRateLimit,
});
