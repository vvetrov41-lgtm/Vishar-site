import assert from 'node:assert/strict';
import { __testing } from '../workers/lib/calendar-drain.js';

assert.equal(__testing.safeLimit(undefined), 10, 'default scheduled drain limit must remain bounded');
assert.equal(__testing.safeLimit(10), 10, 'configured default limit must pass through');
assert.equal(__testing.safeLimit(0), 1, 'drain limit must not fall below one');
assert.equal(__testing.safeLimit(100), 20, 'drain limit must not exceed the hard maximum');
assert.equal(__testing.safeLimit('invalid'), 10, 'invalid limits must fall back to the bounded default');

console.log('Calendar scheduler tests passed: cron drains remain bounded to 1-20 jobs with a default of 10.');

// Audit M-7: a failing appointment queue must not stop availability or contacts.
{
  const { default: calendarWorker } = await import('../workers/calendar-oauth.js');
  const requested = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  console.log = () => {};
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value.split('/rpc/')[1] ?? value);
    if (value.endsWith('/rpc/claim_calendar_outbox')) return Response.json({ message: 'down' }, { status: 503 });
    return Response.json([]);
  };
  let scheduled;
  try {
    calendarWorker.scheduled({}, {
      CALENDAR_DRAIN_ENABLED: 'true',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test-only',
    }, { waitUntil(promise) { scheduled = promise; } });
    await assert.rejects(scheduled, (error) => error?.code === 'database_unavailable');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
  assert.ok(requested.includes('claim_calendar_availability_outbox'), 'availability still drains');
  assert.ok(requested.includes('claim_google_contact_outbox'), 'contacts still drain');
  assert.ok(errors.some((line) => line.includes('"queue":"appointments"')));
  console.log('Calendar scheduler isolation passed: one failing queue no longer stops the others.');
}
