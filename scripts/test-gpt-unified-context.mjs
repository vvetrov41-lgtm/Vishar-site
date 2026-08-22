// Bounded Artist-context surface for the unified GPT.
//
// /v1/context is the only GPT route that accepts an artist_id. These tests pin
// that exception down: it takes an Artist id and nothing else, it always
// resolves to one named RPC, and it can never carry an OAuth client, an
// integration key, a capability, a provider or a raw statement to the database.

import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const headers = { authorization: 'Bearer header.payload.signature' };
const jsonHeaders = { ...headers, 'content-type': 'application/json' };
const ARTIST = 'a1111111-1111-4111-8111-111111111111';

function upstream(body, status = 200) {
  return async (url, init) => {
    upstream.captured = {
      url: String(url),
      payload: JSON.parse(init.body),
      authorization: init.headers.authorization,
      apikey: init.headers.apikey,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// Reading the context asks for the caller's own memberships. No selector.
{
  const payload = {
    integration_key: 'vishar-unified-gpt',
    binding_mode: 'profile',
    active_artist_id: null,
    requires_selection: true,
    artists: [{ id: ARTIST, slug: 'vladimir', display_name: 'Vladimir' }],
  };
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', { headers }),
    env,
    upstream(payload),
  );
  assert.equal(response.status, 200);
  assert.equal(upstream.captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_artist_context');
  assert.deepEqual(upstream.captured.payload, { p_artist_id: null });
  assert.deepEqual(await response.json(), payload);
}

// The caller's own OAuth token is proxied; the Worker only adds the
// publishable key, never a service-role credential.
{
  await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', { headers }),
    env,
    upstream({ binding_mode: 'profile' }),
  );
  assert.equal(upstream.captured.authorization, 'Bearer header.payload.signature');
  assert.equal(upstream.captured.apikey, env.SUPABASE_PUBLISHABLE_KEY);
}

// Selecting an Artist passes exactly the selector through to the one RPC that
// re-checks membership in the database.
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ artist_id: ARTIST }),
    }),
    env,
    upstream({ binding_mode: 'profile', active_artist_id: ARTIST, requires_selection: false }),
  );
  assert.equal(response.status, 200);
  assert.equal(upstream.captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_artist_context');
  assert.deepEqual(upstream.captured.payload, { p_artist_id: ARTIST });
}

// A trailing slash is the same route, not an unrouted path.
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context/', { headers }),
    env,
    upstream({ binding_mode: 'profile' }),
  );
  assert.equal(response.status, 200);
}

// Nothing but an Artist id may reach the database, and a malformed request
// costs no upstream round trip.
const rejected = [
  ['GET', 'https://gpt.example/v1/context?artist_id=' + ARTIST, null],
  ['GET', 'https://gpt.example/v1/context?oauth_client_id=abc', null],
  ['GET', 'https://gpt.example/v1/context?integration_key=vishar-unified-gpt', null],
  ['GET', 'https://gpt.example/v1/context?capability=finance', null],
  ['GET', 'https://gpt.example/v1/context?limit=5', null],
  ['POST', 'https://gpt.example/v1/context', {}],
  ['POST', 'https://gpt.example/v1/context', { artist_id: null }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: 'not-a-uuid' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, capability: 'finance' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, oauth_client_id: 'abc' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, integration_key: 'k' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, provider: 'openai' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, profile_id: ARTIST }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, sql: 'select 1' }],
  ['POST', 'https://gpt.example/v1/context', { artist_id: ARTIST, rpc: 'gpt_list_clients' }],
  ['POST', 'https://gpt.example/v1/context', { sql: 'select 1' }],
];
for (const [method, url, body] of rejected) {
  let called = false;
  const request = body == null
    ? new Request(url, { method, headers })
    : new Request(url, { method, headers: jsonHeaders, body: JSON.stringify(body) });
  const response = await handleGptActionsRequest(request, env, async () => {
    called = true;
    throw new Error('upstream must not be called');
  });
  assert.equal(called, false, `${method} ${url} ${JSON.stringify(body)} reached upstream`);
  assert.equal(response.status, 400, `${method} ${url} ${JSON.stringify(body)} was not refused`);
}

// The route needs the caller's OAuth token, and stays invisible while the GPT
// surface is disabled.
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context'),
    env,
    async () => { throw new Error('upstream must not be called'); },
  );
  assert.equal(response.status, 401);
}
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', { headers }),
    { ...env, GPT_ACTIONS_ENABLED: 'false' },
    async () => { throw new Error('upstream must not be called'); },
  );
  assert.equal(response.status, 404);
}

// A database refusal stays a refusal: no fallback Artist, no leaked detail.
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ artist_id: ARTIST }),
    }),
    env,
    upstream({ code: '42501', message: 'artist membership required' }, 403),
  );
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error, '42501');
  assert.equal(payload.message.includes('membership'), false);
}

// Methods the contract does not define are not silently routed elsewhere.
for (const method of ['PUT', 'PATCH', 'DELETE']) {
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/context', { method, headers: jsonHeaders, body: '{}' }),
    env,
    async () => { throw new Error('upstream must not be called'); },
  );
  assert.equal(response.status, 404);
}

console.log('GPT unified context tests passed: one named RPC, artist_id as selector only, fail-closed.');
