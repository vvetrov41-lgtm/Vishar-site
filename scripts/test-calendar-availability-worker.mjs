import assert from 'node:assert/strict';
import {
  buildGoogleAvailabilityEvent,
  createGoogleAvailabilityProvider,
  stableGoogleAvailabilityEventId,
} from '../workers/lib/google-calendar-availability.js';
import { drainCalendarAvailabilityOutbox } from '../workers/lib/calendar-availability-drain.js';
import {
  CalendarConnectorError,
  encryptTokenRecord,
  stableGoogleEventId,
  validateCalendarRoute,
} from '../workers/lib/google-calendar.js';

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
const vladimirId = 'a1111111-1111-4111-8111-111111111111';
const kristinaId = 'a2222222-2222-4222-8222-222222222222';
const blockId = 'f1111111-1111-4111-8111-111111111111';

const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  CALENDAR_TOKEN_ENCRYPTION_KEY: encryptionKey,
  VLADIMIR_ARTIST_ID: vladimirId,
  VLADIMIR_GOOGLE_EMAIL: 'vladimir@example.test',
  KRISTINA_ARTIST_ID: kristinaId,
  KRISTINA_GOOGLE_EMAIL: 'kristina@example.test',
};

function routeFor(
  artistId = vladimirId,
  outboxId = 'availability-outbox-1',
  kind = 'calendar_availability_create',
) {
  const isVladimir = artistId === vladimirId;
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind,
    integration_type: 'calendar',
    provider: 'google',
    integration_key: isVladimir ? 'google_calendar_vladimir' : 'google_calendar_kristina',
    external_account_label: isVladimir ? 'vladimir@example.test' : 'kristina@example.test',
    configuration: {
      calendar_id: 'primary',
      oauth_scope: 'calendar.events',
      connection_mode: 'worker_oauth',
    },
  };
}

function job(overrides = {}) {
  return {
    outbox_id: 'availability-outbox-1',
    artist_id: vladimirId,
    kind: 'calendar_availability_create',
    availability_block_id: blockId,
    calendar_version: 2,
    current_calendar_version: 2,
    attempt_count: 0,
    max_attempts: 8,
    block_kind: 'holiday',
    start_at: '2026-10-23T23:00:00.000Z',
    end_at: '2026-10-28T00:00:00.000Z',
    is_all_day: true,
    artist_timezone: 'Europe/London',
    calendar_event_id: null,
    cancelled: false,
    job_valid: true,
    obsolete: false,
    note: 'must never reach Google',
    ...overrides,
  };
}

await test('availability event ids are deterministic, artist-scoped and namespaced away from appointments', async () => {
  const first = await stableGoogleAvailabilityEventId(vladimirId, blockId);
  const replay = await stableGoogleAvailabilityEventId(vladimirId, blockId);
  const otherArtist = await stableGoogleAvailabilityEventId(kristinaId, blockId);
  const appointment = await stableGoogleEventId(vladimirId, blockId);
  assert.equal(first, replay);
  assert.notEqual(first, otherArtist);
  assert.notEqual(first, appointment);
  assert.match(first, /^[0-9a-v]{5,1024}$/);
});

await test('all-day Time Off stays on artist-local calendar dates across the London DST change', async () => {
  const event = buildGoogleAvailabilityEvent(job());
  assert.deepEqual(event.start, { date: '2026-10-24' });
  assert.deepEqual(event.end, { date: '2026-10-28' });
  assert.equal(event.status, 'confirmed');
  assert.equal(event.transparency, 'opaque');
  assert.equal(event.visibility, 'private');
  assert.equal(event.summary, 'Time off · Holiday');
  assert.ok(!JSON.stringify(event).includes('must never reach Google'));
  assert.ok(!JSON.stringify(event).toLowerCase().includes('note'));
});

await test('partial-day Time Off uses exact instants with the artist timezone', async () => {
  const event = buildGoogleAvailabilityEvent(job({
    block_kind: 'personal',
    start_at: '2026-08-20T08:30:00.000Z',
    end_at: '2026-08-20T12:45:00.000Z',
    is_all_day: false,
  }));
  assert.deepEqual(event.start, {
    dateTime: '2026-08-20T08:30:00.000Z',
    timeZone: 'Europe/London',
  });
  assert.deepEqual(event.end, {
    dateTime: '2026-08-20T12:45:00.000Z',
    timeZone: 'Europe/London',
  });
  assert.equal(event.summary, 'Time off · Personal');
});

await test('new Time Off create retries reuse one deterministic event id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (calls.length === 1) return Response.json({}, { status: 409 });
    return Response.json({ id: calls[0].body.id, status: 'confirmed' });
  };
  const provider = createGoogleAvailabilityProvider({ accessToken: 'access', fetchImpl });
  const result = await provider.createEvent(job());
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(result.providerEventId, calls[0].body.id);
});

await test('Time Off update can recover a provider event even when the local event id was never acknowledged', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    if (calls.length === 1) return Response.json({}, { status: 404 });
    const body = JSON.parse(init.body);
    return Response.json({ id: body.id, status: 'confirmed' });
  };
  const provider = createGoogleAvailabilityProvider({ accessToken: 'access', fetchImpl });
  const result = await provider.updateEvent(job({ kind: 'calendar_availability_update' }));
  assert.deepEqual(calls, ['PATCH', 'POST']);
  assert.ok(result.providerEventId);
});

await test('Time Off cancel derives the stable event id and treats an already-missing event as success', async () => {
  let requestedUrl = '';
  const provider = createGoogleAvailabilityProvider({
    accessToken: 'access',
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.method, 'DELETE');
      return new Response(null, { status: 404 });
    },
  });
  const result = await provider.cancelEvent(job({
    kind: 'calendar_availability_cancel',
    cancelled: true,
  }));
  assert.equal(result.cancelled, true);
  assert.ok(requestedUrl.includes(result.providerEventId));
});

await test('successful HTTP responses that remain cancelled are rejected instead of acknowledged', async () => {
  const provider = createGoogleAvailabilityProvider({
    accessToken: 'access',
    fetchImpl: async () => Response.json({ id: 'cancelled-event', status: 'cancelled' }),
  });
  await assert.rejects(
    provider.createEvent(job()),
    (error) => error instanceof CalendarConnectorError && error.code === 'calendar_provider_rejected',
  );
});

await test('Kristina Time Off route remains exact with no Vladimir fallback', async () => {
  const kristinaJob = job({
    artist_id: kristinaId,
    kind: 'calendar_availability_create',
  });
  assert.equal(validateCalendarRoute(routeFor(kristinaId), kristinaJob, env).calendarId, 'primary');
  await assert.rejects(
    async () => validateCalendarRoute(routeFor(vladimirId), kristinaJob, env),
    (error) => error.code === 'provider_route_invalid',
  );
});

await test('availability drain retires stale versions and sends only the current Kristina block', async () => {
  const tokenEnvelope = await encryptTokenRecord({
    refreshToken: 'refresh-kristina',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'kristina@example.test',
  }, encryptionKey);
  const rpcCalls = [];
  const googleCalls = [];
  const drainEnv = {
    ...env,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    CALENDAR_OAUTH_TOKENS: {
      get: async (key) => key === `artist:${kristinaId}` ? tokenEnvelope : null,
    },
  };

  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/rpc/')) {
      const name = value.split('/').pop();
      const args = JSON.parse(init.body || '{}');
      rpcCalls.push({ name, args });
      if (name === 'claim_calendar_availability_outbox') {
        return Response.json([
          job({
            outbox_id: 'availability-stale',
            artist_id: kristinaId,
            calendar_version: 1,
            current_calendar_version: 2,
            obsolete: true,
          }),
          job({
            outbox_id: 'availability-current',
            artist_id: kristinaId,
          }),
        ]);
      }
      if (name === 'resolve_outbox_route') {
        return Response.json([routeFor(kristinaId, args.p_outbox_id)]);
      }
      if (name === 'record_calendar_availability_outbox_result') {
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
      return Response.json({ id: body.id, status: 'confirmed' });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  const result = await drainCalendarAvailabilityOutbox(drainEnv, {
    fetchImpl,
    workerId: 'calendar-availability-worker-test',
  });
  assert.equal(result.claimed, 2);
  assert.equal(result.obsolete, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(googleCalls.length, 1);

  const acknowledgements = rpcCalls.filter(
    (call) => call.name === 'record_calendar_availability_outbox_result',
  );
  assert.equal(acknowledgements.length, 2);
  assert.equal(acknowledgements[0].args.p_outbox_id, 'availability-stale');
  assert.equal(acknowledgements[1].args.p_outbox_id, 'availability-current');
  assert.equal(acknowledgements[1].args.p_succeeded, true);
  assert.ok(acknowledgements[1].args.p_event_id);
});

if (failures) {
  console.error(`\n${failures} Calendar Time Off Worker test(s) failed, ${passes} passed.`);
  process.exit(1);
}

console.log(`Calendar Time Off Worker tests passed: ${passes} cases covering DST-safe all-day projection, privacy, deterministic recovery, Kristina routing and stale-job draining.`);
