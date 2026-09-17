import assert from 'node:assert/strict';
import {
  CalendarConnectorError,
  encryptTokenRecord,
} from '../workers/lib/google-calendar.js';
import {
  GOOGLE_CONTACTS_SCOPE,
  buildGoogleContact,
  createGoogleContactsProvider,
  validateGoogleContactsRoute,
  validateGoogleContactsTokenScope,
} from '../workers/lib/google-contacts.js';
import { drainGoogleContactsOutbox } from '../workers/lib/google-contacts-drain.js';
import { __testing as oauth } from '../workers/calendar-oauth.js';

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const encryptionKey = base64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
const artistId = 'a1111111-1111-4111-8111-111111111111';
const clientId = 'b1111111-1111-4111-8111-111111111111';

function job(overrides = {}) {
  return {
    outbox_id: 'c1111111-1111-4111-8111-111111111111',
    artist_id: artistId,
    client_id: clientId,
    attempt_count: 0,
    max_attempts: 8,
    client_display_name: 'Safe Client',
    phone_normalized: '+447700900123',
    email_normalized: 'client@example.test',
    job_valid: true,
    ...overrides,
  };
}

function route(outboxId = job().outbox_id, overrides = {}) {
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind: 'google_contact_create',
    integration_type: 'calendar',
    provider: 'google',
    integration_key: 'google_calendar_vladimir',
    external_account_label: 'vvetrov41@gmail.com',
    configuration: {
      calendar_id: 'primary',
      oauth_scope: 'calendar.events',
      connection_mode: 'worker_oauth',
      artist_slug: 'vladimir',
      google_contacts_sync: true,
      presentation: {
        event_visibility: 'public',
        event_display_name: 'Vladimir',
        event_color_id: '9',
      },
      ...(overrides.configuration || {}),
    },
    ...overrides,
  };
}

await test('Google OAuth explicitly requests Contacts and rejects a token without it', () => {
  assert.ok(oauth.OAUTH_SCOPE.split(/\s+/).includes(GOOGLE_CONTACTS_SCOPE));
  assert.equal(oauth.GOOGLE_CONTACTS_SCOPE, GOOGLE_CONTACTS_SCOPE);
  assert.throws(
    () => oauth.requireGoogleContactsScope('openid email https://www.googleapis.com/auth/calendar.events'),
    (error) => error.code === 'google_contacts_scope_missing' && error.status === 409,
  );
  assert.doesNotThrow(() => oauth.requireGoogleContactsScope(
    `openid email https://www.googleapis.com/auth/calendar.events ${GOOGLE_CONTACTS_SCOPE}`,
  ));
});

await test('contact payload is minimal and contains only approved CRM fields', () => {
  const projected = buildGoogleContact(job());
  assert.equal(projected.phone, '+447700900123');
  assert.deepEqual(projected.body, {
    names: [{ unstructuredName: 'Safe Client' }],
    phoneNumbers: [{ value: '+447700900123', type: 'mobile' }],
    emailAddresses: [{ value: 'client@example.test' }],
  });
  const serialized = JSON.stringify(projected.body);
  for (const forbidden of ['enquiry', 'project', 'message', 'tattoo', 'payment', 'notes']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
});

await test('route and token validation fail closed until Contacts capability and scope exist', () => {
  assert.equal(validateGoogleContactsRoute(route(), job()).alias, 'vladimir');
  assert.throws(
    () => validateGoogleContactsRoute(
      route(job().outbox_id, { configuration: { google_contacts_sync: false } }),
      job(),
    ),
    (error) => error.code === 'google_contacts_not_enabled',
  );
  assert.throws(
    () => validateGoogleContactsTokenScope({
      scope: 'https://www.googleapis.com/auth/calendar.events',
    }),
    (error) => error.code === 'google_contacts_scope_missing',
  );
  assert.equal(
    validateGoogleContactsTokenScope({
      scope: `https://www.googleapis.com/auth/calendar.events ${GOOGLE_CONTACTS_SCOPE}`,
    }).scope.includes(GOOGLE_CONTACTS_SCOPE),
    true,
  );
});

await test('People search warms first and exact E.164 match suppresses create', async () => {
  const calls = [];
  const provider = createGoogleContactsProvider({
    accessToken: 'access-token',
    sleepImpl: async () => {},
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      calls.push({ pathname: parsed.pathname, query: parsed.searchParams.get('query'), method: init.method || 'GET' });
      if (parsed.pathname.endsWith('/people:searchContacts') && parsed.searchParams.get('query') === '') {
        return Response.json({ results: [] });
      }
      if (parsed.pathname.endsWith('/people:searchContacts')) {
        return Response.json({
          results: [{
            person: {
              phoneNumbers: [{ value: '07700 900123', canonicalForm: '+447700900123' }],
            },
          }],
        });
      }
      throw new Error('create must not be called');
    },
  });

  assert.equal(await provider.hasExactPhone('+447700900123'), true);
  assert.deepEqual(calls.map((call) => [call.pathname, call.query]), [
    ['/v1/people:searchContacts', ''],
    ['/v1/people:searchContacts', '+447700900123'],
  ]);
});

await test('People create sends the minimal body and ambiguous POST outcome is retryable-as-unknown', async () => {
  let captured = null;
  const provider = createGoogleContactsProvider({
    accessToken: 'access-token',
    sleepImpl: async () => {},
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/people:createContact')) {
        captured = JSON.parse(init.body);
        return Response.json({ resourceName: 'people/c1' });
      }
      return Response.json({ results: [] });
    },
  });
  await provider.createContact(job());
  assert.deepEqual(captured, buildGoogleContact(job()).body);

  const ambiguous = createGoogleContactsProvider({
    accessToken: 'access-token',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (String(url).includes('people:createContact')) {
        return Response.json({ error: 'upstream' }, { status: 503 });
      }
      return Response.json({ results: [] });
    },
  });
  await assert.rejects(
    ambiguous.createContact(job()),
    (error) => error instanceof CalendarConnectorError
      && error.code === 'google_contacts_create_result_unknown',
  );
});

await test('drain creates once and treats the same phone in the same artist batch as existing', async () => {
  const tokenEnvelope = await encryptTokenRecord({
    refreshToken: 'refresh-vladimir',
    scope: `https://www.googleapis.com/auth/calendar.events ${GOOGLE_CONTACTS_SCOPE}`,
    accountEmail: 'vvetrov41@gmail.com',
  }, encryptionKey);

  const second = job({
    outbox_id: 'c2222222-2222-4222-8222-222222222222',
    client_id: 'b2222222-2222-4222-8222-222222222222',
    client_display_name: 'Same Phone Client',
  });
  const rpcCalls = [];
  const peopleCalls = [];
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    GOOGLE_OAUTH_CLIENT_ID: 'google-client',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
    CALENDAR_TOKEN_ENCRYPTION_KEY: encryptionKey,
    CALENDAR_OAUTH_TOKENS: {
      get: async (key) => key === `artist:${artistId}` ? tokenEnvelope : null,
    },
  };

  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_google_contact_outbox') return Response.json([job(), second]);
      if (name === 'resolve_outbox_route') return Response.json([route(args.p_outbox_id)]);
      if (name === 'record_google_contact_outbox_result') return Response.json({ status: 'succeeded' });
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'access-token' });
    }
    if (value.includes('people:searchContacts')) {
      const parsed = new URL(value);
      peopleCalls.push({ kind: 'search', query: parsed.searchParams.get('query') });
      return Response.json({ results: [] });
    }
    if (value.includes('people:createContact')) {
      peopleCalls.push({ kind: 'create', body: JSON.parse(init.body) });
      return Response.json({ resourceName: 'people/generated' });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  const result = await drainGoogleContactsOutbox(env, {
    fetchImpl,
    sleepImpl: async () => {},
    workerId: 'google-contacts-test',
  });

  assert.equal(result.claimed, 2);
  assert.equal(result.created, 1);
  assert.equal(result.existing, 1);
  assert.equal(peopleCalls.filter((call) => call.kind === 'create').length, 1);
  assert.equal(peopleCalls.filter((call) => call.kind === 'search').length, 2);
  const acks = rpcCalls.filter((call) => call.name === 'record_google_contact_outbox_result');
  assert.equal(acks.length, 2);
  assert.equal(acks[0].args.p_result_code, 'created');
  assert.equal(acks[1].args.p_result_code, 'existing');
});

await test('invalid claimed state is acknowledged without provider routing or Google traffic', async () => {
  const calls = [];
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  };
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (!value.includes('/rest/v1/rpc/')) throw new Error('provider must not be called');
    const name = value.split('/').pop();
    calls.push(name);
    if (name === 'claim_google_contact_outbox') {
      return Response.json([job({ job_valid: false })]);
    }
    if (name === 'record_google_contact_outbox_result') {
      const args = JSON.parse(init.body || '{}');
      assert.equal(args.p_succeeded, true);
      assert.equal(args.p_result_code, 'skipped_invalid');
      return Response.json({ status: 'succeeded' });
    }
    throw new Error(`unexpected RPC ${name}`);
  };
  const result = await drainGoogleContactsOutbox(env, {
    fetchImpl,
    sleepImpl: async () => {},
    workerId: 'google-contacts-test',
  });
  assert.equal(result.skippedInvalid, 1);
  assert.deepEqual(calls, ['claim_google_contact_outbox', 'record_google_contact_outbox_result']);
});

if (failures) {
  console.error(`\n${failures} Google Contacts test(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`Google Contacts Worker tests passed: ${passes} cases.`);
