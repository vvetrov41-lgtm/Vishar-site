import assert from 'node:assert/strict';
import {
  CalendarConnectorError,
  buildGoogleEvent,
  createGoogleCalendarProvider,
  stableGoogleEventId,
} from '../workers/lib/google-calendar.js';

const artistId = 'a1111111-1111-4111-8111-111111111111';
const sessionId = 'b1111111-1111-4111-8111-111111111111';

function job(overrides = {}) {
  return {
    outbox_id: 'outbox-recovery-1',
    artist_id: artistId,
    kind: 'calendar_update',
    session_id: sessionId,
    calendar_version: 6,
    current_calendar_version: 6,
    appointment_type: 'tattoo_session',
    appointment_status: 'confirmed',
    start_at: '2026-08-14T09:30:00.000Z',
    end_at: '2026-08-14T16:25:00.000Z',
    calendar_event_id: 'vishar-existing-event',
    client_display_name: 'Synthetic Recovery Client',
    job_valid: true,
    obsolete: false,
    ...overrides,
  };
}

const projected = buildGoogleEvent(job());
assert.equal(projected.status, 'confirmed');
assert.equal(projected.transparency, 'opaque');

{
  let requestBody;
  const provider = createGoogleCalendarProvider({
    accessToken: 'access-token',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        id: 'vishar-existing-event',
        status: 'cancelled',
      });
    },
  });

  await assert.rejects(
    provider.updateEvent(job()),
    (error) => error instanceof CalendarConnectorError
      && error.code === 'calendar_provider_rejected',
  );
  assert.equal(requestBody.status, 'confirmed');
}

{
  let requestBody;
  const provider = createGoogleCalendarProvider({
    accessToken: 'access-token',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        id: 'vishar-existing-event',
        status: 'confirmed',
      });
    },
  });

  const result = await provider.updateEvent(job());
  assert.equal(requestBody.status, 'confirmed');
  assert.deepEqual(result, { providerEventId: 'vishar-existing-event' });
}

{
  const deterministicId = await stableGoogleEventId(artistId, sessionId);
  const calls = [];
  const provider = createGoogleCalendarProvider({
    accessToken: 'access-token',
    fetchImpl: async (_url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, body });
      if (calls.length === 1) {
        return Response.json({}, { status: 409 });
      }
      return Response.json({ id: deterministicId, status: 'confirmed' });
    },
  });

  const result = await provider.createEvent(job({
    kind: 'calendar_create',
    calendar_event_id: null,
  }));
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'PATCH']);
  assert.equal(calls[0].body.status, 'confirmed');
  assert.equal(calls[1].body.status, 'confirmed');
  assert.equal(result.providerEventId, deterministicId);
}

console.log('Calendar cancelled-event recovery regressions passed.');
