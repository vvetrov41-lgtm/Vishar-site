import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';
import { providerRequestFor } from '../workers/lib/gpt-provider-proxy.js';

const ARTIST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const auth = { authorization: 'Bearer header.payload.signature' };

function envWith(gmailHandler) {
  return {
    GPT_ACTIONS_ENABLED: 'true',
    SUPABASE_URL: 'https://exampleproject.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
    GMAIL_SERVICE: { fetch: gmailHandler },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Gmail inbox: authorize first, then the Gmail Worker for the database's Artist.
{
  const calls = [];
  let gmailRequest = null;
  const env = envWith(async (request) => { gmailRequest = request; return jsonResponse(200, { artist_id: ARTIST, clients: [], untrusted_content: true }); });
  const response = await handleGptActionsRequest(
    new Request('https://gpt-communications.vishartattoo.com/v1/gmail/inbox?message_limit=10', { headers: auth }),
    env,
    async (url, init) => { calls.push({ url, payload: JSON.parse(init.body) }); return jsonResponse(200, { action: 'gmail_inbox', artist_id: ARTIST }); },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { artist_id: ARTIST, clients: [], untrusted_content: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_authorize_provider_action');
  assert.deepEqual(calls[0].payload, { p_action: 'gmail_inbox' }, 'the provider limit never enters the authorization RPC');
  assert.equal(new URL(gmailRequest.url).toString(), `https://gmail.vishartattoo.com/v1/operator/artists/${ARTIST}/gmail/inbox?message_limit=10`);
  assert.equal(gmailRequest.headers.get('authorization'), 'Bearer header.payload.signature', 'the provider re-verifies the same user bearer');
}

// The model cannot pick the Artist: a smuggled artist_id is refused before any call.
{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request(`https://gpt-communications.vishartattoo.com/v1/gmail/inbox?artist_id=${OTHER}`, { headers: auth }),
    envWith(async () => { called = true; return jsonResponse(200, {}); }),
    async () => { called = true; return jsonResponse(200, {}); },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'artist_id' });
  assert.equal(called, false);
}

// A refused authorization never reaches the provider.
{
  let providerCalled = false;
  const response = await handleGptActionsRequest(
    new Request(`https://gpt-communications.vishartattoo.com/v1/clients/${CLIENT}/gmail/history`, { headers: auth }),
    envWith(async () => { providerCalled = true; return jsonResponse(200, {}); }),
    async () => jsonResponse(403, { code: '42501', message: 'client is outside the active GPT Artist scope' }),
  );
  assert.equal(response.status, 403);
  assert.equal(providerCalled, false, 'the Gmail Worker is not called when the GPT boundary refuses');
}

// Client history uses the client id the database confirmed.
{
  let gmailRequest = null;
  const response = await handleGptActionsRequest(
    new Request(`https://gpt-communications.vishartattoo.com/v1/clients/${CLIENT}/gmail/history?thread_limit=2`, { headers: auth }),
    envWith(async (request) => { gmailRequest = request; return jsonResponse(200, { threads: [] }); }),
    async (url, init) => {
      assert.deepEqual(JSON.parse(init.body), { p_client_id: CLIENT });
      return jsonResponse(200, { action: 'gmail_client_history', artist_id: ARTIST, client_id: CLIENT });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(new URL(gmailRequest.url).pathname, `/v1/operator/clients/${CLIENT}/gmail/history`);
  assert.equal(new URL(gmailRequest.url).searchParams.get('thread_limit'), '2');
  assert.equal(new URL(gmailRequest.url).searchParams.get('artist_id'), ARTIST,
    'the database-chosen Artist qualifies a client shared by several Artists');
}

// Instagram start: POST with the database Artist in the body; the link comes back.
{
  const seen = [];
  const response = await handleGptActionsRequest(
    new Request('https://gpt-integrations.vishartattoo.com/v1/integrations/instagram/start', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}',
    }),
    envWith(async () => jsonResponse(500, {})),
    async (input, init) => {
      if (typeof input === 'string') {
        seen.push({ rpc: input, payload: JSON.parse(init.body) });
        return jsonResponse(200, { action: 'instagram_manage', artist_id: ARTIST });
      }
      seen.push({ provider: input.url, method: input.method, body: await input.text(), auth: input.headers.get('authorization') });
      return jsonResponse(200, { authorize_url: 'https://www.instagram.com/oauth/authorize?x=1' });
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authorize_url.startsWith('https://www.instagram.com/'), true);
  assert.deepEqual(seen[0], { rpc: 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_authorize_provider_action', payload: { p_action: 'instagram_manage' } });
  assert.equal(seen[1].provider, 'https://instagram.vishartattoo.com/v1/connections/start');
  assert.equal(seen[1].method, 'POST');
  assert.deepEqual(JSON.parse(seen[1].body), { artist_id: ARTIST });
  assert.equal(seen[1].auth, 'Bearer header.payload.signature');
}

// Instagram status carries the Artist as the connector's query parameter.
{
  const request = providerRequestFor(
    { provider: { service: 'instagram', method: 'GET', path: '/v1/connections/status', artistIn: 'query' }, providerParams: {} },
    { artist_id: ARTIST }, 'token.value.x',
  );
  assert.equal(request.url, `https://instagram.vishartattoo.com/v1/connections/status?artist_id=${ARTIST}`);
  assert.equal(request.method, 'GET');
}

// A malformed authorization answer never becomes a provider call.
for (const bad of [{}, { artist_id: 'not-a-uuid' }, { artist_id: ARTIST, client_id: 'x' }]) {
  assert.throws(() => providerRequestFor(
    { provider: { service: 'gmail', method: 'GET', path: '/v1/operator/clients/{client_id}/gmail/history' }, providerParams: {} },
    bad, 't',
  ), /provider_scope_invalid/);
}

// Provider failures map to stable, detail-free errors.
{
  const response = await handleGptActionsRequest(
    new Request('https://gpt-integrations.vishartattoo.com/v1/integrations/instagram', { headers: auth }),
    envWith(async () => jsonResponse(500, {})),
    async (input) => (typeof input === 'string'
      ? jsonResponse(200, { action: 'instagram_view', artist_id: ARTIST })
      : jsonResponse(503, { error: 'authorization_backend_unavailable', detail: 'internal' })),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'authorization_backend_unavailable' });
}

console.log('GPT provider proxy tests passed: database authorization first, database-chosen Artist and client, same user bearer forwarded, no model-selected Artist, detail-free provider errors.');
