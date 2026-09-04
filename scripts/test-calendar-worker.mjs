import assert from 'node:assert/strict';
import {
  CalendarConnectorError,
  buildGoogleEvent,
  createGoogleCalendarProvider,
  decryptTokenRecord,
  encryptTokenRecord,
  loadArtistRefreshToken,
  loadArtistTokenRecord,
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
const wisteriaLabelId = '0df5fe2d-13a3-42ae-8e07-8dc2c62c97a1';

// The Worker no longer carries per-artist bindings: every artist-specific value
// arrives on the backend-only outbox route, so onboarding an artist adds a
// database row rather than a Worker variable.
const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  CALENDAR_TOKEN_ENCRYPTION_KEY: encryptionKey,
  CRM_APPOINTMENTS_URL: 'https://vishar-crm-staging.pages.dev/#/appointments',
};

const samId = 'd629dab2-4d89-4f0c-bb96-34eb6f44eedc';

const ARTIST_ROUTES = {
  [vladimirId]: {
    slug: 'vladimir',
    account: 'vvetrov41@gmail.com',
    presentation: {
      event_visibility: 'public',
      event_display_name: 'Vladimir',
      event_color_id: '9',
      event_label_name: null,
      event_label_color: null,
    },
  },
  [kristinaId]: {
    slug: 'kristina',
    account: 'tinaakaten@gmail.com',
    presentation: {
      event_visibility: 'public',
      event_display_name: 'Kristina',
      event_color_id: null,
      event_label_name: 'Wisteria',
      event_label_color: '#b39ddb',
    },
  },
  [samId]: {
    slug: 'sam',
    account: 'sam@example.test',
    presentation: {
      event_visibility: 'public',
      event_display_name: 'Sam',
      event_color_id: null,
      event_label_name: null,
      event_label_color: null,
    },
  },
};

function routeFor(artistId = vladimirId, outboxId = 'outbox-1', kind = 'calendar_create', overrides = {}) {
  const artist = ARTIST_ROUTES[artistId];
  return {
    outbox_id: outboxId,
    artist_id: artistId,
    kind,
    integration_type: 'calendar',
    provider: 'google',
    integration_key: `google_calendar_${artist.slug}`,
    external_account_label: artist.account,
    configuration: {
      calendar_id: 'primary',
      oauth_scope: 'calendar.events',
      connection_mode: 'worker_oauth',
      artist_slug: artist.slug,
      presentation: { ...artist.presentation, ...(overrides.presentation || {}) },
      ...(overrides.configuration || {}),
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

await test('event projection contains trusted artist name, public visibility, Blueberry and a hash-safe CRM link', async () => {
  const event = buildGoogleEvent(job(), {
    eventId: 'vishar0123456789abcdef',
    includeId: true,
    crmReturnUrl: env.CRM_APPOINTMENTS_URL,
    visibility: 'public',
    artistDisplayName: 'Vladimir',
    colorId: '9',
  });
  assert.equal(event.id, 'vishar0123456789abcdef');
  assert.equal(event.summary, 'Vladimir · Tattoo session · Synthetic Client');
  assert.equal(event.start.timeZone, 'Europe/London');
  assert.equal(event.end.timeZone, 'Europe/London');
  assert.equal(event.visibility, 'public');
  assert.equal(event.colorId, '9');
  assert.equal(event.eventLabelId, undefined);
  assert.match(event.description, /Appointment ID:/);
  assert.match(event.description, /\?appointment=.*#\/appointments/);
  assert.ok(!JSON.stringify(event).includes('notes'));
});

await test('artist route validation is exact and keeps each artist its own styling', async () => {
  const vladimir = validateCalendarRoute(routeFor(), job());
  assert.equal(vladimir.calendarId, 'primary');
  assert.equal(vladimir.eventVisibility, 'public');
  assert.equal(vladimir.eventDisplayName, 'Vladimir');
  assert.equal(vladimir.eventColorId, '9');

  const kristina = validateCalendarRoute(
    routeFor(kristinaId),
    job({ artist_id: kristinaId }),
  );
  assert.equal(kristina.calendarId, 'primary');
  assert.equal(kristina.eventVisibility, 'public');
  assert.equal(kristina.eventDisplayName, 'Kristina');
  assert.equal(kristina.eventColorId, null);
  assert.equal(kristina.artist.eventLabelName, 'Wisteria');
  assert.equal(kristina.artist.eventLabelColor, '#b39ddb');

  const wrong = routeFor(kristinaId);
  wrong.outbox_id = 'outbox-1';
  await assert.rejects(
    async () => validateCalendarRoute(wrong, job()),
    (error) => error.code === 'provider_route_invalid',
  );
});

await test('an artist the Worker has never heard of projects with no code change', async () => {
  const sam = validateCalendarRoute(
    routeFor(samId, 'outbox-sam'),
    job({ artist_id: samId, outbox_id: 'outbox-sam' }),
  );
  assert.equal(sam.artist.alias, 'sam');
  assert.equal(sam.artist.artistId, samId);
  assert.equal(sam.artist.integrationKey, 'google_calendar_sam');
  assert.equal(sam.artist.expectedEmail, 'sam@example.test');
  assert.equal(sam.eventDisplayName, 'Sam');
  assert.equal(sam.eventVisibility, 'public');
  assert.equal(sam.eventColorId, null);
});

await test('a route whose selector or slug names another artist is refused', async () => {
  const swappedKey = routeFor(samId, 'outbox-sam');
  swappedKey.integration_key = 'google_calendar_vladimir';
  await assert.rejects(
    async () => validateCalendarRoute(swappedKey, job({ artist_id: samId, outbox_id: 'outbox-sam' })),
    (error) => error.code === 'artist_route_unconfigured',
  );

  const swappedSlug = routeFor(samId, 'outbox-sam', 'calendar_create', {
    configuration: { artist_slug: 'vladimir' },
  });
  await assert.rejects(
    async () => validateCalendarRoute(swappedSlug, job({ artist_id: samId, outbox_id: 'outbox-sam' })),
    (error) => error.code === 'artist_route_unconfigured',
  );

  const noAccount = routeFor(samId, 'outbox-sam');
  noAccount.external_account_label = null;
  await assert.rejects(
    async () => validateCalendarRoute(noAccount, job({ artist_id: samId, outbox_id: 'outbox-sam' })),
    (error) => error.code === 'artist_route_unconfigured',
  );

  const notCalendarKey = routeFor(samId, 'outbox-sam');
  notCalendarKey.integration_key = 'gmail_sam';
  await assert.rejects(
    async () => validateCalendarRoute(notCalendarKey, job({ artist_id: samId, outbox_id: 'outbox-sam' })),
    (error) => error.code === 'artist_route_unconfigured',
  );
});

await test('invalid server-owned visibility, colour and label target fail closed before Google', async () => {
  await assert.rejects(
    async () => validateCalendarRoute(
      routeFor(vladimirId, 'outbox-1', 'calendar_create', {
        presentation: { event_visibility: 'world-readable' },
      }),
      job(),
    ),
    (error) => error.code === 'calendar_visibility_invalid',
  );
  await assert.rejects(
    async () => validateCalendarRoute(
      routeFor(vladimirId, 'outbox-1', 'calendar_create', {
        presentation: { event_color_id: '18' },
      }),
      job(),
    ),
    (error) => error.code === 'calendar_event_color_invalid',
  );
  await assert.rejects(
    async () => validateCalendarRoute(
      routeFor(kristinaId, 'outbox-1', 'calendar_create', {
        presentation: { event_label_color: null },
      }),
      job({ artist_id: kristinaId }),
    ),
    (error) => error.code === 'calendar_event_label_target_invalid',
  );
});

await test('token custody selects a separate encrypted envelope per artist and preserves optional label ids', async () => {
  const envelopes = new Map();
  envelopes.set(`artist:${vladimirId}`, await encryptTokenRecord({
    refreshToken: 'refresh-vladimir',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'vvetrov41@gmail.com',
  }, encryptionKey));
  envelopes.set(`artist:${kristinaId}`, await encryptTokenRecord({
    refreshToken: 'refresh-kristina',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendars.readonly',
    accountEmail: 'tinaakaten@gmail.com',
    eventLabelId: wisteriaLabelId,
  }, encryptionKey));
  const tokenEnv = {
    ...env,
    CALENDAR_OAUTH_TOKENS: { get: async (key) => envelopes.get(key) || null },
  };
  assert.equal(
    await loadArtistRefreshToken(tokenEnv, job(), routeFor()),
    'refresh-vladimir',
  );
  const kristinaRecord = await loadArtistTokenRecord(
    tokenEnv,
    job({ artist_id: kristinaId }),
    routeFor(kristinaId),
  );
  assert.equal(kristinaRecord.refreshToken, 'refresh-kristina');
  assert.equal(kristinaRecord.eventLabelId, wisteriaLabelId);

  envelopes.set(`artist:${kristinaId}`, await encryptTokenRecord({
    refreshToken: 'refresh-kristina-old',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    accountEmail: 'tinaakaten@gmail.com',
  }, encryptionKey));
  const oldRecord = await loadArtistTokenRecord(
    tokenEnv,
    job({ artist_id: kristinaId }),
    routeFor(kristinaId),
  );
  assert.equal(oldRecord.refreshToken, 'refresh-kristina-old');
  assert.equal(oldRecord.eventLabelId, null);
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

await test('Google 403 rate-limit reasons remain transient', async () => {
  const provider = createGoogleCalendarProvider({
    accessToken: 'access',
    fetchImpl: async () => Response.json({
      error: {
        errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        code: 403,
      },
    }, { status: 403 }),
  });
  await assert.rejects(
    provider.createEvent(job()),
    (error) => error.code === 'calendar_provider_unavailable',
  );
});

await test('Google 403 permission failures remain permanent', async () => {
  const provider = createGoogleCalendarProvider({
    accessToken: 'access',
    fetchImpl: async () => Response.json({
      error: {
        errors: [{ domain: 'calendar', reason: 'forbiddenForNonOrganizer' }],
        code: 403,
      },
    }, { status: 403 }),
  });
  await assert.rejects(
    provider.createEvent(job()),
    (error) => error.code === 'calendar_provider_rejected',
  );
});

await test('create retries reuse one deterministic event id and preserve Blueberry styling', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (calls.length === 1) return Response.json({}, { status: 409 });
    return Response.json({ id: calls[0].body.id });
  };
  const provider = createGoogleCalendarProvider({
    accessToken: 'access',
    eventVisibility: 'public',
    artistDisplayName: 'Vladimir',
    eventColorId: '9',
    fetchImpl,
  });
  const result = await provider.createEvent(job());
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[0].body.visibility, 'public');
  assert.equal(calls[1].body.visibility, 'public');
  assert.equal(calls[0].body.colorId, '9');
  assert.equal(calls[1].body.colorId, '9');
  assert.equal(calls[0].body.summary, 'Vladimir · Tattoo session · Synthetic Client');
  assert.equal(result.providerEventId, calls[0].body.id);
  assert.match(calls[1].url, new RegExp(`${calls[0].body.id}\\?sendUpdates=none$`));
});

await test('Wisteria uses eventLabelId with eventLabelVersion=1 instead of legacy Grape', async () => {
  const calls = [];
  const provider = createGoogleCalendarProvider({
    accessToken: 'access',
    eventVisibility: 'public',
    artistDisplayName: 'Kristina',
    eventLabelId: wisteriaLabelId,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ id: 'wisteria-event' });
    },
  });
  await provider.createEvent(job({ artist_id: kristinaId }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.eventLabelId, wisteriaLabelId);
  assert.equal(calls[0].body.colorId, undefined);
  assert.equal(calls[0].body.summary, 'Kristina · Tattoo session · Synthetic Client');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('eventLabelVersion'), '1');
  assert.equal(url.searchParams.get('sendUpdates'), 'none');
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

await test('drain skips stale versions and creates only the current styled artist event', async () => {
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
  const projected = JSON.parse(googleCalls[0].init.body);
  assert.equal(projected.visibility, 'public');
  assert.equal(projected.colorId, '9');
  assert.equal(projected.summary, 'Vladimir · Tattoo session · Synthetic Client');
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

console.log(`Calendar Worker tests passed: ${passes} cases covering encrypted token custody, exact artist routing, public artist identity, Blueberry/Wisteria styling, deterministic idempotency, provider error classification, refresh, create/update/cancel and stale-job draining.`);
