// Browser-facing production entry point for the Instagram connector.
//
// The provider worker owns OAuth, webhook, token and database behavior. This
// wrapper adds only the narrow CORS boundary required by the private CRM's
// cross-origin operator requests. Meta webhook and OAuth callback routes are
// deliberately left untouched.

import instagramWorker from './instagram-production.js';

const CRM_ORIGIN = 'https://crm.vishartattoo.com';
const OPERATOR_METHODS = new Map([
  ['/v1/connections/status', 'GET'],
  ['/v1/connections/start', 'POST'],
  ['/v1/connections/disconnect', 'POST'],
]);
const ALLOWED_REQUEST_HEADERS = new Set(['authorization', 'content-type']);

function normalisePath(pathname) {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '');
}

function operatorMethod(url) {
  return OPERATOR_METHODS.get(normalisePath(url.pathname)) ?? null;
}

function appendVary(headers, value) {
  const current = headers.get('vary');
  const values = new Set((current ?? '').split(',').map((part) => part.trim()).filter(Boolean));
  values.add(value);
  headers.set('vary', [...values].join(', '));
}

function corsHeaders(method) {
  const headers = new Headers({
    'access-control-allow-origin': CRM_ORIGIN,
    'access-control-allow-methods': `${method}, OPTIONS`,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
  });
  headers.set('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  return headers;
}

function rejectBrowserOrigin() {
  return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function preflight(request, method) {
  if (request.headers.get('origin') !== CRM_ORIGIN) return rejectBrowserOrigin();
  if ((request.headers.get('access-control-request-method') ?? '').toUpperCase() !== method) {
    return rejectBrowserOrigin();
  }

  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((value) => !ALLOWED_REQUEST_HEADERS.has(value))) {
    return rejectBrowserOrigin();
  }

  return new Response(null, { status: 204, headers: corsHeaders(method) });
}

function withCrmCors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', CRM_ORIGIN);
  appendVary(headers, 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = operatorMethod(url);
    if (!method) return instagramWorker.fetch(request, env, ctx);

    if (request.method === 'OPTIONS') return preflight(request, method);

    const origin = request.headers.get('origin');
    if (origin && origin !== CRM_ORIGIN) return rejectBrowserOrigin();

    const response = await instagramWorker.fetch(request, env, ctx);
    return origin === CRM_ORIGIN ? withCrmCors(response) : response;
  },

  scheduled(controller, env, ctx) {
    return instagramWorker.scheduled(controller, env, ctx);
  },
};

export const __testing = Object.freeze({
  CRM_ORIGIN,
  OPERATOR_METHODS,
  normalisePath,
  operatorMethod,
  preflight,
  withCrmCors,
});
