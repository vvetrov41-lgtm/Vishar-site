import assert from 'node:assert/strict';
import { handleGmailOperatorRequest, __testing as operator } from '../workers/gmail-operator-api.js';
import { __testing as supabaseContract } from '../workers/lib/gmail-supabase.js';

let passes = 0;
async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

const enquiryId = '96320000-0000-4000-8000-000000000001';
const artistId = 'a1111111-1111-4111-8111-111111111111';
const clientId = '96310000-0000-4000-8000-000000000001';
const path = `/v1/operator/enquiries/${enquiryId}/gmail/history`;
const productionEnv = {
  VISHAR_ENVIRONMENT: 'production',
  SUPABASE_URL: 'https://vfjexhfdbrjmuxfdvbdx.supabase.co',
  SUPABASE_SECRET_KEY: ['sb', 'secret', 'synthetic', 'test', 'value'].join('_'),
  SUPABASE_PUBLISHABLE_KEY: ['sb', 'publishable', 'synthetic', 'test', 'value'].join('_'),
  GMAIL_READ_ENABLED: 'true',
  GMAIL_RATE_LIMIT: { async limit() { return { success: true }; } },
};

await test('operator routes are limited to the dedicated CRM prefix', () => {
  assert.equal(operator.operatorPath(path), true);
  assert.equal(operator.operatorPath(`/v1/enquiries/${enquiryId}/gmail/history`), false);
  assert.equal(operator.GMAIL_PUBLIC_HOST, 'gmail.vishartattoo.com');
  assert.equal(operator.CRM_ORIGIN, 'https://crm.vishartattoo.com');
});

await test('operator authorization reuses the canonical communications capability', () => {
  assert.equal(operator.REQUIRED_OPERATOR_CAPABILITY, 'manage_communications');
  assert.equal(supabaseContract.USER_RPCS.has('list_capabilities'), true);
  assert.equal(supabaseContract.BACKEND_RPCS.has('service_authorize_gmail_operator'), false);
});

await test('CRM-safe messages omit provider identifiers and raw Gmail metadata', () => {
  const safe = operator.publicMessage({
    provider_message_id: 'provider-secret-id',
    _rfc822_message_id: '<provider@example.test>',
    from: 'client@example.test',
    to: 'studio@example.test',
    subject: 'Tattoo enquiry',
    timestamp: '2026-08-31T10:00:00.000Z',
    body: 'Hello',
    direction: 'inbound',
  });
  assert.deepEqual(safe, {
    from: 'client@example.test',
    to: 'studio@example.test',
    subject: 'Tattoo enquiry',
    timestamp: '2026-08-31T10:00:00.000Z',
    body: 'Hello',
    direction: 'inbound',
    untrusted_content: true,
  });
  assert.equal('provider_message_id' in safe, false);
  assert.equal('_rfc822_message_id' in safe, false);
});

await test('non-CRM browser origin is rejected before auth or provider access', async () => {
  let calls = 0;
  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    headers: { origin: 'https://attacker.example' },
  }), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(calls, 0);
});

await test('CRM preflight allows only GET and authorization header', async () => {
  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    method: 'OPTIONS',
    headers: { origin: 'https://crm.vishartattoo.com' },
  }), productionEnv);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://crm.vishartattoo.com');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-headers'), 'authorization, content-type');
});

await test('live Gmail read remains fail-closed when production read flag is disabled', async () => {
  let calls = 0;
  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    headers: { origin: 'https://crm.vishartattoo.com' },
  }), { ...productionEnv, GMAIL_READ_ENABLED: 'false' }, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});

await test('operator history requires a Supabase session bearer', async () => {
  let calls = 0;
  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    headers: { origin: 'https://crm.vishartattoo.com' },
  }), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://crm.vishartattoo.com');
  assert.deepEqual(await response.json(), { error: 'authentication_required' });
  assert.equal(calls, 0);
});

await test('RLS-visible enquiry still cannot reach Gmail without manage_communications', async () => {
  const calls = [];
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/rest/v1/enquiries') {
      assert.equal(url.searchParams.get('id'), `eq.${enquiryId}`);
      assert.equal(url.searchParams.get('select'), 'id,artist_id,client_id');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
      assert.equal(new Headers(init.headers).get('apikey'), productionEnv.SUPABASE_PUBLISHABLE_KEY);
      return Response.json([{ id: enquiryId, artist_id: artistId, client_id: clientId }]);
    }
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      assert.deepEqual(JSON.parse(String(init.body)), { p_artist_id: artistId });
      return Response.json([]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    headers: {
      origin: 'https://crm.vishartattoo.com',
      authorization: `Bearer ${token}`,
    },
  }), productionEnv, fetchImpl);

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'artist_scope_denied' });
  assert.equal(calls.length, 2);
  assert.equal(calls.some(({ url }) => url.pathname.includes('service_resolve_gmail_target')), false);
});

// ---------------------------------------------------------------------------
// The client-scoped read.
//
// Gmail finds a client's mail by searching the artist's mailbox for the
// CLIENT'S ADDRESS. It has no concept of an enquiry. So reading a client's
// correspondence by asking the enquiry route once per enquiry returns the same
// Gmail threads every time - and that route records thread context keyed by
// (artist, enquiry, provider thread), so each pass would bind one real
// conversation to a different enquiry, and a later reply could leave through
// the wrong binding.
//
// The client route exists so that read happens once and records nothing.
// ---------------------------------------------------------------------------

const clientPath = `/v1/operator/clients/${clientId}/gmail/history`;

await test('client-scoped read derives the artist from the caller\'s own enquiries, never the request', async () => {
  const calls = [];
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/rest/v1/enquiries') {
      // The browser sent a client id and nothing else. The artist comes back
      // out of the database, under the caller's own row level security.
      assert.equal(url.searchParams.get('client_id'), `eq.${clientId}`);
      assert.equal(url.searchParams.get('select'), 'artist_id');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
      return Response.json([{ artist_id: artistId }, { artist_id: artistId }]);
    }
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      return Response.json([]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${clientPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), productionEnv, fetchImpl);

  // Visible enquiries, but no manage_communications: refused before Gmail.
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'artist_scope_denied' });
  assert.equal(calls.includes('/rest/v1/rpc/service_resolve_gmail_client_target'), false);
});

await test('a client shared by two manageable artists is refused rather than guessed', async () => {
  const token = 'synthetic.crm.session.token.1234567890';
  const otherArtist = 'a2222222-2222-4222-8222-222222222222';
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/enquiries') {
      return Response.json([{ artist_id: artistId }, { artist_id: otherArtist }]);
    }
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      return Response.json([
        { artist_id: artistId, capability: 'manage_communications' },
        { artist_id: otherArtist, capability: 'manage_communications' },
      ]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${clientPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), productionEnv, fetchImpl);

  // Choosing one would silently decide whose mailbox to open.
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'artist_scope_denied' });
});

await test('client-scoped read never writes a Gmail thread context', async () => {
  const calls = [];
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/rest/v1/enquiries') {
      // One client, THREE enquiries - the exact shape that made per-enquiry
      // reads dangerous.
      return Response.json([{ artist_id: artistId }, { artist_id: artistId }, { artist_id: artistId }]);
    }
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      return Response.json([{ artist_id: artistId, capability: 'manage_communications' }]);
    }
    if (url.pathname === '/rest/v1/rpc/service_resolve_gmail_client_target') {
      assert.deepEqual(JSON.parse(String(init.body)), { p_artist_id: artistId, p_client_id: clientId });
      return Response.json([{
        artist_id: artistId,
        client_id: clientId,
        client_email: 'client@example.test',
        integration_key: 'google_gmail_vladimir',
        mailbox_email: 'studio@example.test',
        configuration: {},
      }]);
    }
    if (url.pathname === '/rest/v1/rpc/service_upsert_gmail_thread_context') {
      throw new Error('client-scoped read must not bind a thread context');
    }
    // Google is unreachable in this harness; the read fails after resolution,
    // which is enough - the assertions above are about what was NOT called.
    throw new Error('gmail_refresh_token_missing');
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${clientPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), productionEnv, fetchImpl);

  assert.equal(calls.includes('/rest/v1/rpc/service_upsert_gmail_thread_context'), false);
  // Exactly one target resolution for the whole client, not one per enquiry.
  assert.equal(
    calls.filter((p) => p === '/rest/v1/rpc/service_resolve_gmail_client_target').length,
    1,
  );
  assert.equal(calls.includes('/rest/v1/rpc/service_resolve_gmail_target'), false);
  assert.equal(response.status >= 400, true);
});

await test('the client target RPC is backend-only and on the Worker allow-list', () => {
  assert.equal(supabaseContract.BACKEND_RPCS.has('service_resolve_gmail_client_target'), true);
  assert.equal(supabaseContract.USER_RPCS.has('service_resolve_gmail_client_target'), false);
});

await test('client-scoped read rejects a malformed client id before any downstream call', async () => {
  let calls = 0;
  const response = await handleGmailOperatorRequest(new Request(
    'https://gmail.vishartattoo.com/v1/operator/clients/not-a-uuid/gmail/history',
    { headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${'a'.repeat(32)}` } },
  ), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});

await test('client-scoped read is GET only and needs a session', async () => {
  let calls = 0;
  const post = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${clientPath}`, {
    method: 'POST',
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${'a'.repeat(32)}` },
  }), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(post.status, 405);

  const anonymous = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${clientPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com' },
  }), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(anonymous.status, 401);
  assert.equal(calls, 0);
});

await test('operator API exposes no direct Gmail send method', async () => {
  let calls = 0;
  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://crm.vishartattoo.com',
      authorization: `Bearer ${'a'.repeat(32)}`,
    },
  }), productionEnv, async () => { calls += 1; throw new Error('must not fetch'); });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
  assert.equal(calls, 0);
});

await test('operator API ignores unrelated Gmail and GPT routes', async () => {
  assert.equal(await handleGmailOperatorRequest(new Request('https://gmail.vishartattoo.com/oauth/google/start/vladimir'), productionEnv), null);
  assert.equal(await handleGmailOperatorRequest(new Request(`https://gpt-communications.vishartattoo.com/v1/enquiries/${enquiryId}/gmail/history`), productionEnv), null);
});

console.log(`gmail operator api: ${passes} tests passed`);
