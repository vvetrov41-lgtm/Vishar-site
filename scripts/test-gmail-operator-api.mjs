import assert from 'node:assert/strict';
import { handleGmailOperatorRequest, __testing as operator } from '../workers/gmail-operator-api.js';
import { __testing as supabaseContract } from '../workers/lib/gmail-supabase.js';
import { __testing as gmailCrypto } from '../workers/lib/google-gmail.js';

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

// ---------------------------------------------------------------------------
// Known-client discovery.
//
// A client the studio already knows can email for the first time. Stored
// `email_messages` cannot show that - there is no row - so the mailbox is read
// directly, and the DATABASE decides which addresses belong to clients this
// artist knows. An address it cannot name never comes back, so an unknown
// sender is not something a later filter has to remember to remove.
// ---------------------------------------------------------------------------

const discoveryPath = `/v1/operator/artists/${artistId}/gmail/inbox`;
const secondClientId = '96310000-0000-4000-8000-000000000002';

// A real sealed refresh token in a fake KV, rather than stubbing past the token
// path: discovery must go through the same credential custody as every other
// Gmail read, and a test that skipped it would prove nothing about that.
const encryptionKey = gmailCrypto.b64urlEncode(new Uint8Array(32).fill(7));
const googleEnv = {
  GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-client-secret',
  GMAIL_TOKEN_ENCRYPTION_KEY: encryptionKey,
};

async function discoveryEnv() {
  const sealed = await gmailCrypto.sealToken({
    v: 1,
    artist_id: artistId,
    integration_key: 'google_gmail_vladimir',
    mailbox_email: 'studio@example.test',
    refresh_token: 'synthetic-refresh-token-value',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  }, encryptionKey);
  const store = new Map([[gmailCrypto.tokenKey(artistId), sealed]]);
  return {
    ...productionEnv,
    ...googleEnv,
    GMAIL_OAUTH_TOKENS: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
}

await test('discovery refuses an artist the operator may not manage communications for', async () => {
  const calls = [];
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      // Visible artist, but only a read capability.
      return Response.json([{ artist_id: artistId, capability: 'view_communications' }]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), await discoveryEnv(), fetchImpl);

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'artist_scope_denied' });
  // Nothing about the mailbox was touched.
  assert.equal(calls.includes('/rest/v1/rpc/service_resolve_gmail_mailbox'), false);
  assert.equal(calls.some((p) => p.startsWith('/gmail/')), false);
});

await test('discovery returns only addresses the database can name, and never a provider id', async () => {
  const calls = [];
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      return Response.json([{ artist_id: artistId, capability: 'manage_communications' }]);
    }
    if (url.pathname === '/rest/v1/rpc/service_resolve_gmail_mailbox') {
      assert.deepEqual(JSON.parse(String(init.body)), { p_artist_id: artistId });
      return Response.json([{
        artist_id: artistId,
        integration_key: 'google_gmail_vladimir',
        mailbox_email: 'studio@example.test',
        configuration: {},
      }]);
    }
    if (url.pathname === '/oauth2/v4/token' || url.pathname === '/token') {
      return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
    }
    if (url.pathname === '/gmail/v1/users/me/profile') {
      return Response.json({ emailAddress: 'studio@example.test' });
    }
    if (url.pathname === '/gmail/v1/users/me/messages') {
      return Response.json({ messages: [{ id: 'msg-known' }, { id: 'msg-stranger' }] });
    }
    if (url.pathname === '/gmail/v1/users/me/messages/msg-known') {
      // Metadata only was requested: no body is ever fetched.
      assert.equal(url.searchParams.get('format'), 'metadata');
      return Response.json({
        id: 'msg-known',
        internalDate: '1788000000000',
        payload: { headers: [
          { name: 'From', value: 'Known Client <client@example.test>' },
          { name: 'To', value: 'studio@example.test' },
          { name: 'Subject', value: 'About my sleeve' },
        ] },
      });
    }
    if (url.pathname === '/gmail/v1/users/me/messages/msg-stranger') {
      return Response.json({
        id: 'msg-stranger',
        internalDate: '1788000001000',
        payload: { headers: [
          { name: 'From', value: 'nobody@example.test' },
          { name: 'To', value: 'studio@example.test' },
          { name: 'Subject', value: 'Cheap backlinks' },
        ] },
      });
    }
    if (url.pathname === '/rest/v1/rpc/service_match_gmail_clients') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.p_artist_id, artistId);
      // Both addresses are offered; only one is claimed.
      assert.deepEqual([...body.p_emails].sort(), ['client@example.test', 'nobody@example.test']);
      return Response.json([
        { client_id: clientId, client_email: 'client@example.test', full_name: 'Known Client' },
      ]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), await discoveryEnv(), fetchImpl);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.artist_id, artistId);
  assert.equal(payload.clients.length, 1);
  assert.equal(payload.clients[0].client_id, clientId);
  assert.equal(payload.clients[0].client_name, 'Known Client');
  assert.equal(payload.clients[0].direction, 'inbound');

  // The stranger is absent, not merely unflagged.
  const serialised = JSON.stringify(payload);
  assert.equal(serialised.includes('nobody@example.test'), false);
  assert.equal(serialised.includes('Cheap backlinks'), false);
  // No provider identifier of any kind reaches the browser.
  assert.equal(serialised.includes('msg-known'), false);
  assert.equal(serialised.includes('msg-stranger'), false);
  assert.equal('provider_message_id' in payload.clients[0], false);
  assert.equal('thread_context_id' in payload.clients[0], false);

  // Discovery mutates nothing.
  assert.equal(calls.includes('/rest/v1/rpc/service_upsert_gmail_thread_context'), false);
  assert.equal(calls.includes('/rest/v1/rpc/service_resolve_gmail_target'), false);
});

await test('one client with several messages is one discovery row, newest first', async () => {
  const token = 'synthetic.crm.session.token.1234567890';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      return Response.json([{ artist_id: artistId, capability: 'manage_communications' }]);
    }
    if (url.pathname === '/rest/v1/rpc/service_resolve_gmail_mailbox') {
      return Response.json([{
        artist_id: artistId,
        integration_key: 'google_gmail_vladimir',
        mailbox_email: 'studio@example.test',
        configuration: {},
      }]);
    }
    if (url.pathname === '/oauth2/v4/token' || url.pathname === '/token') {
      return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
    }
    if (url.pathname === '/gmail/v1/users/me/profile') {
      return Response.json({ emailAddress: 'studio@example.test' });
    }
    if (url.pathname === '/gmail/v1/users/me/messages') {
      return Response.json({ messages: [{ id: 'msg-old' }, { id: 'msg-new' }] });
    }
    if (url.pathname === '/gmail/v1/users/me/messages/msg-old') {
      return Response.json({
        id: 'msg-old',
        internalDate: '1788000000000',
        payload: { headers: [
          { name: 'From', value: 'client@example.test' },
          { name: 'To', value: 'studio@example.test' },
          { name: 'Subject', value: 'First message' },
        ] },
      });
    }
    if (url.pathname === '/gmail/v1/users/me/messages/msg-new') {
      return Response.json({
        id: 'msg-new',
        internalDate: '1788009999000',
        payload: { headers: [
          { name: 'From', value: 'client@example.test' },
          { name: 'To', value: 'studio@example.test' },
          { name: 'Subject', value: 'Second message' },
        ] },
      });
    }
    if (url.pathname === '/rest/v1/rpc/service_match_gmail_clients') {
      // The database answers once per client, whatever the client's enquiry
      // count: the SQL is `distinct on (c.id)`.
      return Response.json([
        { client_id: clientId, client_email: 'client@example.test', full_name: 'Known Client' },
      ]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` },
  }), await discoveryEnv(), fetchImpl);

  const payload = await response.json();
  assert.equal(payload.clients.length, 1);
  assert.equal(payload.clients[0].subject, 'Second message');
});

await test('discovery cannot be pointed at another artist by editing the path', async () => {
  const token = 'synthetic.crm.session.token.1234567890';
  const otherArtist = 'a2222222-2222-4222-8222-222222222222';
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/rest/v1/rpc/list_capabilities') {
      assert.deepEqual(JSON.parse(String(init.body)), { p_artist_id: otherArtist });
      // The operator manages the OTHER artist, not this one.
      return Response.json([{ artist_id: artistId, capability: 'manage_communications' }]);
    }
    throw new Error(`unexpected downstream call: ${url.pathname}`);
  };

  const response = await handleGmailOperatorRequest(new Request(
    `https://gmail.vishartattoo.com/v1/operator/artists/${otherArtist}/gmail/inbox`,
    { headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${token}` } },
  ), await discoveryEnv(), fetchImpl);

  assert.equal(response.status, 403);
  assert.equal(calls.includes('/rest/v1/rpc/service_resolve_gmail_mailbox'), false);
});

await test('discovery RPCs are backend-only and on the Worker allow-list', () => {
  assert.equal(supabaseContract.BACKEND_RPCS.has('service_resolve_gmail_mailbox'), true);
  assert.equal(supabaseContract.BACKEND_RPCS.has('service_match_gmail_clients'), true);
  assert.equal(supabaseContract.USER_RPCS.has('service_match_gmail_clients'), false);
  assert.equal(supabaseContract.USER_RPCS.has('service_resolve_gmail_mailbox'), false);
});

await test('discovery is GET only, session-bound and fail-closed on the read flag', async () => {
  let calls = 0;
  const guard = async () => { calls += 1; throw new Error('must not fetch'); };
  const post = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    method: 'POST',
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${'a'.repeat(32)}` },
  }), await discoveryEnv(), guard);
  assert.equal(post.status, 405);

  const anonymous = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com' },
  }), await discoveryEnv(), guard);
  assert.equal(anonymous.status, 401);

  const disabled = await handleGmailOperatorRequest(new Request(`https://gmail.vishartattoo.com${discoveryPath}`, {
    headers: { origin: 'https://crm.vishartattoo.com', authorization: `Bearer ${'a'.repeat(32)}` },
  }), { ...(await discoveryEnv()), GMAIL_READ_ENABLED: 'false' }, guard);
  assert.equal(disabled.status, 404);

  assert.equal(calls, 0);
});

void secondClientId;

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
