import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMAIN_OPERATIONS, routeForDomainOperation } from '../workers/lib/gpt-domain-operations.js';
import { routeForFullGptAction } from '../workers/lib/gpt-full-actions.js';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const auth = { authorization: 'Bearer header.payload.signature' };
const ID = '11111111-1111-4111-8111-111111111111';

function sample(param) {
  switch (param.type) {
    case 'uuid': return ID;
    case 'string': return param.example ?? 'Synthetic value'.slice(0, param.max);
    case 'clock': return '10:00';
    case 'date': return '2026-11-02';
    case 'date-time': return '2026-11-02T10:00:00Z';
    case 'integer': return Math.max(param.min ?? 0, Math.min(1, param.max ?? 1));
    case 'number': return Math.max(param.min ?? 0, Math.min(10, param.max ?? 10));
    case 'boolean': return true;
    case 'enum': return param.values[0];
    case 'clock-array': return ['10:00'];
    case 'uuid-array': return [ID];
    default: throw new Error(`no sample for ${param.type}`);
  }
}

function requestFor(entry, { bodyOverride, extraQuery } = {}) {
  let path = entry.path;
  const url = new URL('https://gpt.example');
  for (const param of entry.params) if (param.in === 'path') path = path.replace(`{${param.name}}`, ID);
  url.pathname = path;
  for (const param of entry.params) if (param.in === 'query' && param.required) url.searchParams.set(param.name, String(sample(param)));
  if (extraQuery) for (const [key, value] of Object.entries(extraQuery)) url.searchParams.set(key, value);
  const body = {};
  for (const param of entry.params) if (param.in === 'body') body[param.name] = sample(param);
  const init = { method: entry.method, headers: { ...auth, 'content-type': 'application/json' } };
  if (entry.method !== 'GET') init.body = JSON.stringify(bodyOverride ?? body);
  return { request: new Request(url, init), url, body: bodyOverride ?? body };
}

// ----------------------------------------------------------- registry shape
const ids = DOMAIN_OPERATIONS.map((entry) => entry.id);
assert.equal(new Set(ids).size, ids.length, 'operation ids are unique');
const routes = DOMAIN_OPERATIONS.map((entry) => `${entry.method} ${entry.path}`);
assert.equal(new Set(routes).size, routes.length, 'method + path pairs are unique');
const rpcs = DOMAIN_OPERATIONS.filter((entry) => !entry.provider).map((entry) => entry.rpc);
assert.equal(new Set(rpcs).size, rpcs.length, 'each database operation maps to exactly one RPC');
for (const entry of DOMAIN_OPERATIONS.filter((candidate) => candidate.provider)) {
  assert.match(entry.rpc, /^gpt_authorize_/, `${entry.id} is gated by an authorization RPC`);
  assert.ok(['gmail', 'instagram'].includes(entry.provider.service));
}
for (const entry of DOMAIN_OPERATIONS) {
  assert.match(entry.rpc, /^gpt_[a-z0-9_]+$/);
  assert.equal(entry.consequential, entry.method !== 'GET', `${entry.id} consequence follows its method`);
  for (const param of entry.params) {
    assert.ok(!['artist_id', 'workspace_id', 'oauth_client_id', 'integration_key'].includes(param.name),
      `${entry.id} must not accept ${param.name}`);
    assert.match(param.arg, param.forward ? /^[a-z][a-z0-9_]+$/ : /^p_[a-z0-9_]+$/);
  }
}

// ------------------------------------------- legacy routes are unchanged
const legacyRoutes = [];
for (const name of ['core', 'operations', 'communications', 'cloudflare']) {
  const text = readFileSync(new URL(`../docs/gpt-actions/openapi.production.${name}.yaml`, import.meta.url), 'utf8');
  let path = null;
  for (const line of text.split('\n')) {
    const pathMatch = /^  (\/\S+):\s*$/.exec(line);
    if (pathMatch) path = pathMatch[1];
    const methodMatch = /^    (get|post|put|patch|delete):\s*$/.exec(line);
    if (methodMatch) legacyRoutes.push(`${methodMatch[1].toUpperCase()} ${path}`);
  }
}
for (const route of routes) assert.ok(!legacyRoutes.includes(route), `${route} collides with an imported legacy route`);

for (const route of legacyRoutes) {
  const [method, path] = route.split(' ');
  const url = new URL(`https://gpt.example${path.replace(/\{[a-z_]+\}/g, ID)}`);
  assert.equal(routeForDomainOperation(new Request(url, { method }), url, {}), null,
    `${route} must stay with its existing handler`);
}

// ---------------------------------------------- every operation routes
for (const entry of DOMAIN_OPERATIONS) {
  const { request, url, body } = requestFor(entry);
  assert.equal(routeForFullGptAction(request, url, body), null, `${entry.id} is not shadowed by the full-actions router`);
  const route = routeForDomainOperation(request, url, body);
  assert.ok(route, `${entry.id} routes`);
  assert.equal(route.rpc, entry.rpc);
  assert.equal(route.responseKind, entry.provider ? 'provider' : 'json');
  for (const [key, value] of Object.entries(entry.fixedArgs)) assert.equal(route.payload[key], value);
  for (const param of entry.params) {
    if (param.forward) {
      assert.ok(!Object.prototype.hasOwnProperty.call(route.payload, param.arg), `${entry.id} keeps ${param.name} out of the authorization RPC`);
      continue;
    }
    if (param.in === 'path' || param.required || param.in === 'body') {
      assert.ok(Object.prototype.hasOwnProperty.call(route.payload, param.arg), `${entry.id} forwards ${param.name}`);
    }
  }
  assert.deepEqual(Object.keys(route.payload).sort(), [...new Set(Object.keys(route.payload))].sort());

  // Artist and routing selectors are refused wherever they are smuggled in.
  if (entry.method === 'GET') {
    assert.throws(() => routeForDomainOperation(requestFor(entry, { extraQuery: { artist_id: ID } }).request,
      requestFor(entry, { extraQuery: { artist_id: ID } }).url, {}), /forbidden_field:artist_id/);
    assert.throws(() => {
      const r = requestFor(entry, { extraQuery: { surprise: '1' } });
      routeForDomainOperation(r.request, r.url, {});
    }, /unexpected_field:surprise/);
  } else {
    for (const forbidden of ['artist_id', 'workspace_id', 'rpc', 'sql', 'integration_key']) {
      const smuggled = { ...body, [forbidden]: ID };
      const r = requestFor(entry, { bodyOverride: smuggled });
      assert.throws(() => routeForDomainOperation(r.request, r.url, smuggled), new RegExp(`forbidden_field:${forbidden}`));
    }
    const extra = { ...body, surprise: 1 };
    const r = requestFor(entry, { bodyOverride: extra });
    assert.throws(() => routeForDomainOperation(r.request, r.url, extra), /unexpected_field:surprise/);
    for (const param of entry.params.filter((candidate) => candidate.in === 'body' && candidate.required)) {
      const missing = { ...body };
      delete missing[param.name];
      const m = requestFor(entry, { bodyOverride: missing });
      assert.throws(() => routeForDomainOperation(m.request, m.url, missing), new RegExp(`required_field:${param.name}`));
    }
  }

  // Path ids must be UUIDs; anything else is not this route.
  if (entry.params.some((param) => param.in === 'path')) {
    const bad = new URL(`https://gpt.example${entry.path.replace(/\{[a-z_]+\}/g, 'not-a-uuid')}`);
    assert.equal(routeForDomainOperation(new Request(bad, { method: entry.method }), bad, body), null);
  }
}

// ------------------------------------------------ typed validation samples
{
  const entry = DOMAIN_OPERATIONS.find((candidate) => candidate.id === 'setSchedulingPreferences');
  const { body } = requestFor(entry);
  for (const [field, value] of [
    ['tattoo_earliest_start', '25:00'],
    ['tattoo_preferred_starts', ['10:00', 'noon']],
    ['max_concurrent_consultations', 1.5],
    ['consultation_during_tattoo', 'yes'],
  ]) {
    const invalid = { ...body, [field]: value };
    const r = requestFor(entry, { bodyOverride: invalid });
    assert.throws(() => routeForDomainOperation(r.request, r.url, invalid), new RegExp(`invalid_field:${field}`));
  }
}
{
  const entry = DOMAIN_OPERATIONS.find((candidate) => candidate.id === 'scheduleAppointmentWithPrice');
  const { body } = requestFor(entry);
  for (const [field, value] of [['status', 'completed'], ['price', -1], ['start_at', '2026-11-02'], ['request_id', 'abc']]) {
    const invalid = { ...body, [field]: value };
    const r = requestFor(entry, { bodyOverride: invalid });
    assert.throws(() => routeForDomainOperation(r.request, r.url, invalid), new RegExp(`invalid_field:${field}`));
  }
}

// --------------------------------- end to end through the combined handler
{
  const entry = DOMAIN_OPERATIONS.find((candidate) => candidate.id === 'listScheduleOverrides');
  const { request } = requestFor(entry);
  let captured = null;
  const response = await handleGptActionsRequest(request, env, async (url, init) => {
    captured = { url, payload: JSON.parse(init.body), headers: init.headers };
    return new Response(JSON.stringify([{ on_date: '2026-11-02' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ on_date: '2026-11-02' }], 'jsonb arrays pass through unchanged');
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_schedule_overrides');
  assert.deepEqual(captured.payload, { p_from: '2026-11-02', p_to: '2026-11-02' });
  assert.equal(captured.headers.authorization, 'Bearer header.payload.signature', 'the user token is forwarded, never a service key');
}
{
  const entry = DOMAIN_OPERATIONS.find((candidate) => candidate.id === 'archiveClient');
  const { request } = requestFor(entry, { bodyOverride: { artist_id: ID } });
  const response = await handleGptActionsRequest(request, env, async () => { throw new Error('must not call upstream'); });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'artist_id' });
}
{
  const entry = DOMAIN_OPERATIONS.find((candidate) => candidate.id === 'getTodayPulse');
  const response = await handleGptActionsRequest(requestFor(entry).request, env, async () => new Response(
    JSON.stringify({ code: '42501', message: 'internal policy detail' }), { status: 403, headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, '42501');
  assert.doesNotMatch(body.message, /internal policy detail/, 'database policy detail is not echoed to the model');
}

console.log(`GPT domain operations passed: ${DOMAIN_OPERATIONS.length} registry operations route to named RPCs with exact typed parameters and no Artist selector.`);
