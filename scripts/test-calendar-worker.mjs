import assert from 'node:assert/strict';
import {
  CalendarConnectorError,
  buildGoogleEvent,
  createGoogleCalendarProvider,
  decryptTokenRecord,
  encryptTokenRecord,
  loadArtistRefreshToken,
  refreshGoogleAccessToken,
  stableGoogleEventId,
  validateCalendarRoute,
} from '../workers/lib/google-calendar.js';
import { drainCalendarOutbox } from '../workers/lib/calendar-drain.js';

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
const otherEncryptionKey = base64Url(Uint8Array.from({ length: 32 }, (_, index) => 31 - index));
const vladimirId = 'a1111111-1111-4111-8111-111111111111';
const kristinaId = 'a2222222-2222-4222-8222-222222222222';
const sessionId = 'b1111111-1111-4111-8111-111111111111';

const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  CALENDAR_TOKEN_ENCRYPTION_KEY: encryptionKey,
  VLADIMIR_ARTIST_ID: vladimirId,
  VLADIMIR_GOOGLE_EMAIL: 'vvetrov41@gmail.com',
  KRISTINA_ARTIST_ID: kristinaId,
  KRISTINA_GOOGLE_EMAIL: 'tinaakaten@gmail.com',
  CRM_RETURN_URL: 'https://vishar-crm-staging.pages.dev/appointments',
};

function routeFor(artistId = vladimirId, outboxId = 'outbox-1', kind = 'calendar_create') {
  const isVladimir = artistId === vladimirId;
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind,
    integration_type: 'calendar',
    provider: 'google',
    integration_key: isVladimir ? 'google_calendar_vladimir' : 'google_calendar_kristina',
    external_account_label: isVladimir ? 'vvetrov41@gmail.com' : 'tinaakaten@gmail.com',
    configuration: {
      calendar_id: 'primary',
      oauth_scope: 'calendar.events',
      connection_mode: 'worker_oauth',
    },
  };
}

function job(overrides = {}) {
  return {
    outbox_id: 'outbox-1',
    artist_id: vladimirId,
    kind: 'calendar_create',
    session_id: sessionId,
    calendar_version: 2,
    current_calendar_version: 2,
    attempt_count: 0,
    max_attempts: 8,
    appointment_type: 'tattoo_session',
    appointment_status: 'confirmed',
    start_at: '2026-08-10T09:00:00.000Z',
    end_at: '2026-08-10T16:00:00.000Z',
    calendar_event_id: null,
    client_display_name: 'Synthetic Client',
    job_valid: true,
    obsolete: false,
    ...overrides,
  };
}

await test('AES-GCM token envelopes round-trip and reject the wrong key', async () => {
  const envelope = await encryptTokenRecord({
    refreshToken: 'refresh-vladimir',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'vvetrov41@gmail.com',
  }, encryptionKey);
  const record = await decryptTokenRecord(envelope, encryptionKey);
  assert.equal(record.refreshToken, 'refresh-vladimir');
  await assert.rejects(
    decryptTokenRecord(envelope, otherEncryptionKey),
    (error) => error instanceof CalendarConnectorError && error.code === 'calendar_token_invalid',
  );
});

await test('stable Google event ids are deterministic and appointment-specific', async () => {
  const first = await stableGoogleEventId(vladimirId, sessionId);
  const replay = await stableGoogleEventId(vladimirId, sessionId);
  const different = await stableGoogleEventId(kristinaId, sessionId);
  assert.equal(first, replay);
  assert.notEqual(first, different);
  assert.match(first, /^[0-9a-v]{5,1024}$/);
});

await test('event projection contains bounded client context and no private notes', async () => {
  const event = buildGoogleEvent(job(), {
    eventId: 'vishar0123456789abcdef',
    includeId: true,
    crmReturnUrl: env.CRM_RETURN_URL,
  });
  assert.equal(event.id, 'vishar0123456789abcdef');
  assert.match(event.summary, /Tattoo session · Synthetic Client/);
  assert.equal(event.start.timeZone, 'Europe/London');
  assert.equal(event.end.timeZone, 'Europe/London');
  assert.match(event.description, /Appointment ID:/);
  assert.ok(!JSON.stringify(event).includes('notes'));
});

await test('artist route validation is exact and has no cross-artist fallback', async () => {
  assert.equal(validateCalendarRoute(routeFor(), job(), env).calendarId, 'primary');
  const wrong = routeFor(kristinaId);
  wrong.outbox_id = 'outbox-1';
  await assert.rejects(
    async () => validateCalendarRoute(wrong, job(), env),
    (error) => error.code === 'provider_route_invalid',
  );
});

await test('token custody selects a separate encrypted envelope per artist', async () => {
  const envelopes = new Map();
  envelopes.set(`artist:${vladimirId}`, await encryptTokenRecord({
    refreshToken: 'refresh-vladimir',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'vvetrov41@gmail.com',
  }, encryptionKey));
  envelopes.set(`artist:${kristinaId}`, await encryptTokenRecord({
    refreshToken: 'refresh-kristina',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'tinaakaten@gmail.com',
  }, encryptionKey));
  const tokenEnv = {
    ...env,
    CALENDAR_OAUTH_TOKENS: { get: async (key) => envelopes.get(key) || null },
  };
  assert.equal(
    await loadArtistRefreshToken(tokenEnv, job(), routeFor()),
    'refresh-vladimir',
  );
  assert.equal(
    await loadArtistRefreshToken(
      tokenEnv,
      job({ artist_id: kristinaId }),
      routeFor(kristinaId),
    ),
    'refresh-kristina',
  );
});

await test('refresh-token exchange stays server-side and maps invalid_grant safely', async () => {
  const successFetch = async (_url, init) => {
    assert.equal(init.method, 'POST');
    assert.match(String(init.body), /grant_type=refresh_token/);
    return Response.json({ access_token: 'access-token', expires_in: 3600 });
  };
  assert.equal(await refreshGoogleAccessToken(env, 'refresh', successFetch), 'access-token');

  const expiredFetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(
    refreshGoogleAccessToken(env, 'refresh', expiredFetch),
    (error) => error.code === 'calendar_oauth_expired',
  );
});

await test('create retries reuse one deterministic event id instead of duplicating', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (calls.length === 1) return Response.json({}, { status: 409 });
    return Response.json({ id: calls[0].body.id });
  };
  const provider = createGoogleCalendarProvider({ accessToken: 'access', fetchImpl });
  const result = await provider.createEvent(job());
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(result.providerEventId, calls[0].body.id);
  assert.match(calls[1].url, new RegExp(`${calls[0].body.id}\\?sendUpdates=none$`));
});

await test('missing update target is recreated with the deterministic id', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    if (calls.length === 1) return Response.json({}, { status: 404 });
    return Response.json({ id: 'vishar-recreated' });
  };
  const provider = createGoogleCalendarProvider({ accessToken: 'access', fetchImpl });
  const result = await provider.updateEvent(job({
    kind: 'calendar_update',
    calendar_event_id: 'missing-event',
  }));
  assert.deepEqual(calls, ['PATCH', 'POST']);
  assert.equal(result.providerEventId, 'vishar-recreated');
});

await test('delete is idempotent when Google reports an already missing event', async () => {
  const provider = createGoogleCalendarProvider({
    accessToken: 'access',
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.deepEqual(
    await provider.cancelEvent(job({
      kind: 'calendar_cancel',
      calendar_event_id: 'already-deleted',
      appointment_status: 'cancelled',
    })),
    { cancelled: true },
  );
});

await test('drain skips stale versions and creates only the current artist event', async () => {
  const tokenEnvelope = await encryptTokenRecord({
    refreshToken: 'refresh-vladimir',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'vvetrov41@gmail.com',
  }, encryptionKey);
  const rpcCalls = [];
  const googleCalls = [];
  const drainEnv = {
    ...env,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    CALENDAR_OAUTH_TOKENS: {
      get: async (key) => key === `artist:${vladimirId}` ? tokenEnvelope : null,
    },
  };

  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_calendar_outbox') {
        return Response.json([
          job({ outbox_id: 'stale-job', calendar_version: 1, current_calendar_version: 2, obsolete: true }),
          job({ outbox_id: 'current-job' }),
        ]);
      }
      if (name === 'resolve_outbox_route') {
        return Response.json([routeFor(vladimirId, args.p_outbox_id)]);
      }
      if (name === 'record_calendar_outbox_result') {
        return Response.json({ status: 'succeeded' });
      }
      throw new Error(`unexpected RPC ${name}`);
    }
    if (value === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'access-token' });
    }
    if (value.startsWith('https://www.googleapis.com/calendar/v3/')) {
      googleCalls.push({ url: value, init });
      const body = JSON.parse(init.body);
      return Response.json({ id: body.id });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  const result = await drainCalendarOutbox(drainEnv, {
    fetchImpl,
    workerId: 'calendar-worker-test',
  });
  assert.equal(result.claimed, 2);
  assert.equal(result.obsolete, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(googleCalls.length, 1);
  const acknowledgements = rpcCalls.filter((call) => call.name === 'record_calendar_outbox_result');
  assert.equal(acknowledgements.length, 2);
  assert.equal(acknowledgements[0].args.p_outbox_id, 'stale-job');
  assert.equal(acknowledgements[1].args.p_outbox_id, 'current-job');
  assert.equal(acknowledgements[1].args.p_succeeded, true);
  assert.ok(acknowledgements[1].args.p_event_id);
});

if (failures) {
  console.error(`\n${failures} calendar Worker test(s) failed, ${passes} passed.`);
  process.exit(1);
}

console.log(`Calendar Worker tests passed: ${passes} cases covering encrypted token custody, exact artist routing, deterministic idempotency, refresh, create/update/cancel and stale-job draining.`);
