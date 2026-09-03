import { createWorkerObservability, statusClass } from './lib/worker-observability.js';

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const OBSERVABILITY_PROBE_PATH = '/internal/observability/probe';
const MAX_INTERNAL_BODY_BYTES = 640 * 1024;
const MAX_WORKER_SOURCE_BYTES = 512 * 1024;
const MAX_PROVIDER_BYTES = 768 * 1024;
const MAX_TEXT_FIELD = 4096;
const MAX_LIST_ITEMS = 250;
const PROTECTED_WORKERS = new Set(['vishar-cloudflare-gateway', 'vishar-gpt-actions-production']);

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function configured(env) {
  return env?.VISHAR_ENVIRONMENT === 'production'
    && typeof env?.CLOUDFLARE_API_TOKEN === 'string'
    && env.CLOUDFLARE_API_TOKEN.trim().length >= 20;
}

async function readTextLimited(response, maxBytes = MAX_PROVIDER_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('provider_response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (utf8Bytes(text) > MAX_INTERNAL_BODY_BYTES) throw new Error('body_too_large');
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('invalid_json'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_json_object');
  return parsed;
}

function exactObject(body, allowed, required = []) {
  for (const forbidden of [
    'account_id', 'zone_id', 'api_token', 'access_token', 'authorization',
    'upstream', 'url_path', 'method', 'headers', 'sql', 'rpc', 'secret', 'secret_value',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, forbidden)) throw new Error(`forbidden_field:${forbidden}`);
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new Error(`unexpected_field:${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) throw new Error(`required_field:${key}`);
  }
}

function cleanString(value, field, max = MAX_TEXT_FIELD) {
  if (typeof value !== 'string') throw new Error(`invalid_field:${field}`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`invalid_field:${field}`);
  return result;
}

const WORKER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;
const CF_ID_RE = /^[0-9a-f]{32}$/i;
const DNS_NAME_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

function workerName(value) {
  const result = cleanString(value, 'script_name', 63);
  if (!WORKER_NAME_RE.test(result)) throw new Error('invalid_field:script_name');
  return result;
}

function cloudflareId(value, field) {
  const result = cleanString(value, field, 32);
  if (!CF_ID_RE.test(result)) throw new Error(`invalid_field:${field}`);
  return result;
}

function zoneName(value) {
  const result = cleanString(value, 'zone', 253).toLowerCase().replace(/\.$/, '');
  if (!DNS_NAME_RE.test(result) || result.startsWith('*.')) throw new Error('invalid_field:zone');
  return result;
}

class ProviderError extends Error {
  constructor(status, code, message) {
    super('provider_error');
    this.status = status;
    this.code = code;
    this.providerMessage = message;
  }
}

function safeProviderError(status, parsed) {
  const entry = Array.isArray(parsed?.errors) && parsed.errors[0] && typeof parsed.errors[0] === 'object'
    ? parsed.errors[0]
    : null;
  const code = typeof entry?.code === 'number' || typeof entry?.code === 'string'
    ? String(entry.code).slice(0, 40)
    : 'cloudflare_error';
  const message = typeof entry?.message === 'string'
    ? entry.message.slice(0, 300)
    : 'Cloudflare API request failed.';
  return new ProviderError(status, code, message);
}

async function cloudflareJson(env, fetchImpl, path, init = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error('invalid_provider_path');
  }
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${env.CLOUDFLARE_API_TOKEN.trim()}`);
  headers.set('accept', 'application/json');
  const response = await fetchImpl(`${CLOUDFLARE_API_ORIGIN}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) throw new ProviderError(502, 'redirect_refused', 'Cloudflare API redirect refused.');
  const text = await readTextLimited(response);
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { throw new ProviderError(502, 'invalid_cloudflare_response', 'Cloudflare API returned invalid JSON.'); }
  if (!response.ok || parsed?.success !== true) throw safeProviderError(response.status, parsed);
  return parsed;
}

let cachedAccount = null;

async function resolveAccount(env, fetchImpl) {
  if (cachedAccount) return cachedAccount;
  const parsed = await cloudflareJson(env, fetchImpl, '/accounts?per_page=50');
  const accounts = Array.isArray(parsed.result) ? parsed.result : [];
  if (accounts.length !== 1) throw new Error('cloudflare_account_scope_invalid');
  const account = accounts[0];
  if (!account || typeof account.id !== 'string' || !CF_ID_RE.test(account.id) || typeof account.name !== 'string') {
    throw new Error('cloudflare_account_scope_invalid');
  }
  cachedAccount = { id: account.id, name: account.name.slice(0, 200) };
  return cachedAccount;
}

async function resolveZone(env, fetchImpl, requestedZone) {
  const account = await resolveAccount(env, fetchImpl);
  const zone = zoneName(requestedZone);
  const qs = new URLSearchParams({ name: zone, 'account.id': account.id, match: 'all', per_page: '50' });
  const parsed = await cloudflareJson(env, fetchImpl, `/zones?${qs.toString()}`);
  const matches = (Array.isArray(parsed.result) ? parsed.result : []).filter((item) =>
    item && typeof item.id === 'string' && CF_ID_RE.test(item.id)
      && typeof item.name === 'string' && item.name.toLowerCase() === zone
      && item.account?.id === account.id);
  if (matches.length === 0) throw new Error('zone_not_found');
  if (matches.length !== 1) throw new Error('zone_ambiguous');
  return { id: matches[0].id, name: matches[0].name, status: matches[0].status || null };
}

function take(items, mapper) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_LIST_ITEMS).map(mapper).filter(Boolean);
}

function workerSummary(item) {
  if (!item || typeof item.id !== 'string') return null;
  return {
    name: item.id,
    created_on: item.created_on || null,
    modified_on: item.modified_on || null,
    compatibility_date: item.compatibility_date || null,
    usage_model: item.usage_model || null,
    last_deployed_from: item.last_deployed_from || null,
  };
}

async function listWorkers(env, fetchImpl) {
  const account = await resolveAccount(env, fetchImpl);
  const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/workers/scripts`);
  return take(parsed.result, workerSummary);
}

async function getWorker(env, fetchImpl, name) {
  const workers = await listWorkers(env, fetchImpl);
  const found = workers.find((item) => item.name === name);
  if (!found) throw new Error('worker_not_found');
  return found;
}

function pagesSummary(item) {
  if (!item || typeof item.name !== 'string') return null;
  return {
    name: item.name,
    subdomain: item.subdomain || null,
    production_branch: item.production_branch || null,
    created_on: item.created_on || null,
    latest_deployment_id: item.latest_deployment?.id || null,
    latest_deployment_environment: item.latest_deployment?.environment || null,
    canonical_deployment_id: item.canonical_deployment?.id || null,
  };
}

function dnsRecordPayload(body, zone) {
  const type = cleanString(body.type, 'type', 10).toUpperCase();
  if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'NS'].includes(type)) throw new Error('invalid_field:type');
  const name = cleanString(body.name, 'name', 255).toLowerCase().replace(/\.$/, '');
  if (!DNS_NAME_RE.test(name) || !(name === zone || name.endsWith(`.${zone}`))) throw new Error('invalid_field:name');
  const content = cleanString(body.content, 'content', 4096);
  const payload = { type, name, content };
  if (body.ttl != null) {
    if (!Number.isInteger(body.ttl) || !(body.ttl === 1 || (body.ttl >= 60 && body.ttl <= 86400))) throw new Error('invalid_field:ttl');
    payload.ttl = body.ttl;
  }
  if (body.proxied != null) {
    if (typeof body.proxied !== 'boolean') throw new Error('invalid_field:proxied');
    payload.proxied = body.proxied;
  }
  if (body.comment != null) payload.comment = cleanString(body.comment, 'comment', 500);
  if (body.priority != null) {
    if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 65535) throw new Error('invalid_field:priority');
    payload.priority = body.priority;
  }
  return payload;
}

function normalizeDnsRecord(item) {
  if (!item || typeof item.id !== 'string') return null;
  return {
    id: item.id,
    type: item.type || null,
    name: item.name || null,
    content: item.content || null,
    ttl: item.ttl ?? null,
    proxied: item.proxied ?? null,
    priority: item.priority ?? null,
    comment: item.comment || null,
    modified_on: item.modified_on || null,
  };
}

function normalizeRoute(item) {
  if (!item || typeof item.id !== 'string') return null;
  return { id: item.id, pattern: item.pattern || null, script: item.script || null };
}

function routePattern(value, zone) {
  const pattern = cleanString(value, 'pattern', 512);
  if (!pattern.toLowerCase().includes(zone)) throw new Error('invalid_field:pattern');
  return pattern;
}

function publicUrlInZone(value, zone) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_field:urls');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_field:urls'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_field:urls');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!(host === zone || host.endsWith(`.${zone}`))) throw new Error('invalid_field:urls');
  return url.toString();
}

async function dispatch(request, env, fetchImpl) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length) throw new Error(`unexpected_field:${[...url.searchParams.keys()][0]}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'GET' && path === '/internal/cloudflare/account') {
    const account = await resolveAccount(env, fetchImpl);
    return { account: { name: account.name } };
  }
  if (method === 'GET' && path === '/internal/cloudflare/zones') {
    const account = await resolveAccount(env, fetchImpl);
    const qs = new URLSearchParams({ 'account.id': account.id, per_page: '50' });
    const parsed = await cloudflareJson(env, fetchImpl, `/zones?${qs.toString()}`);
    return { zones: take(parsed.result, (item) => item && typeof item.name === 'string' ? {
      name: item.name, status: item.status || null, paused: item.paused ?? null, type: item.type || null,
    } : null) };
  }
  if (method === 'GET' && path === '/internal/cloudflare/workers') return { workers: await listWorkers(env, fetchImpl) };
  if (method === 'GET' && path === '/internal/cloudflare/pages') {
    const account = await resolveAccount(env, fetchImpl);
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/pages/projects?per_page=100`);
    return { projects: take(parsed.result, pagesSummary) };
  }
  if (method === 'GET' && path === '/internal/cloudflare/d1') {
    const account = await resolveAccount(env, fetchImpl);
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/d1/database?per_page=100`);
    return { databases: take(parsed.result, (item) => item && typeof item.uuid === 'string' ? {
      id: item.uuid, name: item.name || null, created_at: item.created_at || null, version: item.version || null,
    } : null) };
  }
  if (method === 'GET' && path === '/internal/cloudflare/kv') {
    const account = await resolveAccount(env, fetchImpl);
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
    return { namespaces: take(parsed.result, (item) => item && typeof item.id === 'string' ? { id: item.id, title: item.title || null } : null) };
  }
  if (method === 'GET' && path === '/internal/cloudflare/r2') {
    const account = await resolveAccount(env, fetchImpl);
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/r2/buckets`);
    return { buckets: take(parsed.result?.buckets, (item) => item && typeof item.name === 'string' ? {
      name: item.name, creation_date: item.creation_date || null, location: item.location || null, jurisdiction: item.jurisdiction || null,
    } : null) };
  }

  if (method !== 'POST') throw new Error('method_not_allowed');
  const body = await readJson(request);

  if (path === '/internal/cloudflare/worker') {
    exactObject(body, ['script_name'], ['script_name']);
    return { worker: await getWorker(env, fetchImpl, workerName(body.script_name)) };
  }
  if (path === '/internal/cloudflare/worker/deployments') {
    exactObject(body, ['script_name'], ['script_name']);
    const name = workerName(body.script_name);
    const account = await resolveAccount(env, fetchImpl);
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/workers/scripts/${encodeURIComponent(name)}/deployments`);
    return { deployments: take(parsed.result?.deployments, (item) => item && typeof item.id === 'string' ? {
      id: item.id, created_on: item.created_on || null, source: item.source || null,
      strategy: item.strategy || null,
      versions: take(item.versions, (version) => version && typeof version.version_id === 'string' ? {
        version_id: version.version_id, percentage: version.percentage ?? null,
      } : null),
      message: item.annotations?.['workers/message'] || null,
    } : null) };
  }
  if (path === '/internal/cloudflare/worker/deploy') {
    exactObject(body, ['script_name', 'code'], ['script_name', 'code']);
    const name = workerName(body.script_name);
    if (name === 'vishar-cloudflare-gateway') throw new Error('protected_worker');
    if (typeof body.code !== 'string' || !body.code.trim() || utf8Bytes(body.code) > MAX_WORKER_SOURCE_BYTES) throw new Error('invalid_field:code');
    const account = await resolveAccount(env, fetchImpl);
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'worker.js' })], { type: 'application/json' }));
    form.set('worker.js', new Blob([body.code], { type: 'application/javascript+module' }), 'worker.js');
    const parsed = await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/workers/scripts/${encodeURIComponent(name)}/content`, {
      method: 'PUT', body: form,
    });
    return { worker: workerSummary(parsed.result) || { name }, deployed: true };
  }
  if (path === '/internal/cloudflare/worker/delete') {
    exactObject(body, ['script_name', 'confirm'], ['script_name', 'confirm']);
    const name = workerName(body.script_name);
    if (PROTECTED_WORKERS.has(name)) throw new Error('protected_worker');
    if (body.confirm !== name) throw new Error('confirmation_mismatch');
    const account = await resolveAccount(env, fetchImpl);
    await cloudflareJson(env, fetchImpl, `/accounts/${account.id}/workers/scripts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return { deleted: true, script_name: name };
  }
  if (path === '/internal/cloudflare/dns/list') {
    exactObject(body, ['zone'], ['zone']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const parsed = await cloudflareJson(env, fetchImpl, `/zones/${zone.id}/dns_records?per_page=500`);
    return { zone: zone.name, records: take(parsed.result, normalizeDnsRecord) };
  }
  if (path === '/internal/cloudflare/dns/upsert') {
    exactObject(body, ['zone', 'record_id', 'type', 'name', 'content', 'ttl', 'proxied', 'priority', 'comment'], ['zone', 'type', 'name', 'content']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const payload = dnsRecordPayload(body, zone.name);
    const recordId = body.record_id == null ? null : cloudflareId(body.record_id, 'record_id');
    const parsed = await cloudflareJson(env, fetchImpl,
      recordId ? `/zones/${zone.id}/dns_records/${recordId}` : `/zones/${zone.id}/dns_records`, {
        method: recordId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    return { zone: zone.name, record: normalizeDnsRecord(parsed.result) };
  }
  if (path === '/internal/cloudflare/dns/delete') {
    exactObject(body, ['zone', 'record_id', 'confirm'], ['zone', 'record_id', 'confirm']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const recordId = cloudflareId(body.record_id, 'record_id');
    if (body.confirm !== recordId) throw new Error('confirmation_mismatch');
    await cloudflareJson(env, fetchImpl, `/zones/${zone.id}/dns_records/${recordId}`, { method: 'DELETE' });
    return { zone: zone.name, record_id: recordId, deleted: true };
  }
  if (path === '/internal/cloudflare/cache/purge') {
    exactObject(body, ['zone', 'urls', 'purge_everything'], ['zone']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const purgeEverything = body.purge_everything === true;
    const hasUrls = Array.isArray(body.urls) && body.urls.length > 0;
    if (purgeEverything === hasUrls) throw new Error('invalid_field:purge');
    let payload;
    if (purgeEverything) payload = { purge_everything: true };
    else {
      if (body.urls.length > 30) throw new Error('invalid_field:urls');
      payload = { files: body.urls.map((item) => publicUrlInZone(item, zone.name)) };
    }
    await cloudflareJson(env, fetchImpl, `/zones/${zone.id}/purge_cache`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { zone: zone.name, purged: true, purge_everything: purgeEverything, urls: purgeEverything ? [] : payload.files };
  }
  if (path === '/internal/cloudflare/routes/list') {
    exactObject(body, ['zone'], ['zone']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const parsed = await cloudflareJson(env, fetchImpl, `/zones/${zone.id}/workers/routes`);
    return { zone: zone.name, routes: take(parsed.result, normalizeRoute) };
  }
  if (path === '/internal/cloudflare/routes/upsert') {
    exactObject(body, ['zone', 'route_id', 'pattern', 'script_name'], ['zone', 'pattern', 'script_name']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const payload = { pattern: routePattern(body.pattern, zone.name), script: workerName(body.script_name) };
    const routeId = body.route_id == null ? null : cloudflareId(body.route_id, 'route_id');
    const parsed = await cloudflareJson(env, fetchImpl,
      routeId ? `/zones/${zone.id}/workers/routes/${routeId}` : `/zones/${zone.id}/workers/routes`, {
        method: routeId ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    return { zone: zone.name, route: normalizeRoute(parsed.result) };
  }
  if (path === '/internal/cloudflare/routes/delete') {
    exactObject(body, ['zone', 'route_id', 'confirm'], ['zone', 'route_id', 'confirm']);
    const zone = await resolveZone(env, fetchImpl, body.zone);
    const routeId = cloudflareId(body.route_id, 'route_id');
    if (body.confirm !== routeId) throw new Error('confirmation_mismatch');
    await cloudflareJson(env, fetchImpl, `/zones/${zone.id}/workers/routes/${routeId}`, { method: 'DELETE' });
    return { zone: zone.name, route_id: routeId, deleted: true };
  }

  throw new Error('not_found');
}

function mapError(error) {
  if (error instanceof ProviderError) {
    return json(502, { error: 'cloudflare_provider_error', code: error.code, message: error.providerMessage });
  }
  const reason = error instanceof Error ? error.message : 'gateway_error';
  if (reason === 'not_found') return json(404, { error: 'not_found' });
  if (reason === 'method_not_allowed') return json(405, { error: reason });
  if (reason === 'body_too_large') return json(413, { error: reason });
  if (reason === 'unsupported_media_type') return json(415, { error: reason });
  if (reason === 'cloudflare_account_scope_invalid') return json(503, { error: reason });
  if (reason === 'zone_not_found' || reason === 'worker_not_found') return json(404, { error: reason });
  if (reason === 'zone_ambiguous' || reason === 'confirmation_mismatch' || reason === 'protected_worker') return json(409, { error: reason });
  if (reason === 'provider_response_too_large') return json(502, { error: 'cloudflare_response_too_large' });
  const [kind, field] = reason.split(':', 2);
  if (['unexpected_field', 'forbidden_field', 'required_field', 'invalid_field'].includes(kind)) {
    return json(400, { error: kind, field });
  }
  if (reason === 'invalid_json' || reason === 'invalid_json_object') return json(400, { error: reason });
  return json(502, { error: 'cloudflare_gateway_error' });
}

// Bounded production observability for this private, service-bound Worker.
//
// Only two things are ever reported, and both are assembled from fixed tokens:
// a server-side failure class, and an explicit technical probe. No request URL,
// query string, body, header, provider payload or raw error is passed in.
async function reportOutcome(reporter, waitUntil, event, fields) {
  const capture = reporter.capture(event, { component: 'cloudflare-gateway', environment: 'production', ...fields });
  if (typeof waitUntil === 'function') waitUntil(capture.catch(() => {}));
  else await capture.catch(() => {});
}

export async function handleCloudflareGatewayRequest(request, env, fetchImpl = fetch, ctx = null) {
  const reporter = createWorkerObservability(env, { fetchImpl });
  const waitUntil = typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
  const startedAt = Date.now();

  if (isObservabilityProbe(request)) {
    // The probe exists so a rollout can prove the sanitized pipeline end to end
    // without waiting for a real incident. This Worker has no public route, so
    // the probe is reachable only through its internal service binding.
    const result = await reporter.capture('probe.observability.sanitized', {
      component: 'cloudflare-gateway',
      environment: 'production',
      stage: 'release_probe',
      operation: 'observability_probe',
      outcome: 'succeeded',
      statusClass: '2xx',
    });
    return json(200, { probe: 'observability', sent: result.sent === true, reason: result.reason || null });
  }

  if (!configured(env)) return json(503, { error: 'cloudflare_not_configured' });

  let response;
  try {
    response = json(200, await dispatch(request, env, fetchImpl));
  } catch (error) {
    response = mapError(error);
  }

  if (response.status >= 500) {
    await reportOutcome(reporter, waitUntil, 'worker.request.failed', {
      stage: 'gateway_dispatch',
      statusClass: statusClass(response.status),
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
    });
  }
  return response;
}

function isObservabilityProbe(request) {
  if (request.method.toUpperCase() !== 'POST') return false;
  return new URL(request.url).pathname.replace(/\/+$/, '') === OBSERVABILITY_PROBE_PATH;
}

export default {
  async fetch(request, env, ctx) {
    return handleCloudflareGatewayRequest(request, env, fetch, ctx);
  },
};

export const __testing = Object.freeze({
  configured, readJson, exactObject, workerName, zoneName, cloudflareId,
  dnsRecordPayload, publicUrlInZone, routePattern, cloudflareJson,
  resolveAccount, resolveZone, dispatch, mapError, isObservabilityProbe,
});
