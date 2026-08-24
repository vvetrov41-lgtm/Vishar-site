#!/usr/bin/env node

import assert from 'node:assert/strict';
import tattooaiEntry from '../workers/tattooai-entry.js';
import {
  handleAppointmentClientActionRequest,
  isAppointmentClientActionPath,
  readAppointmentClientActionToken,
} from '../workers/routes/appointment-client-action.js';
import {
  ALLOWED_RPCS,
  APPOINTMENT_CLIENT_ACTION_RPCS,
  READ_ONLY_RPCS,
} from '../workers/lib/supabase.js';

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const URL = `https://tattooai.example/appointments/respond/${TOKEN}`;
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-test-key',
};

let passes = 0;
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${error.stack || error.message}`);
  }
}

function backendFetch({
  resolveStatus = 200,
  applyStatus = 200,
  action = 'confirm_attendance',
  outcome = 'attendance_confirmed',
  artistName = 'Vladimir Vishar',
} = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ href, body, method: init.method });

    if (href.endsWith('/rest/v1/rpc/service_resolve_appointment_client_action')) {
      if (resolveStatus !== 200) return new Response('{}', { status: resolveStatus });
      return Response.json([{ action, artist_display_name: artistName }]);
    }
    if (href.endsWith('/rest/v1/rpc/service_apply_appointment_client_action')) {
      if (applyStatus !== 200) return new Response('{}', { status: applyStatus });
      return Response.json({ action, outcome, artist_display_name: artistName });
    }
    throw new Error(`unexpected backend call: ${href}`);
  };
  return { calls, fetchImpl };
}

await test('the whole client-action namespace is owned, but only one strict token shape resolves', () => {
  assert.equal(isAppointmentClientActionPath(new Request(URL)), true);
  assert.equal(isAppointmentClientActionPath(new Request('https://tattooai.example/appointments/respond/not-a-token')), true);
  assert.equal(isAppointmentClientActionPath(new Request('https://tattooai.example/appointments/other')), false);
  assert.equal(readAppointmentClientActionToken(new Request(URL)), TOKEN);
  assert.equal(readAppointmentClientActionToken(new Request(`${URL}/`)), TOKEN);
  for (const tail of ['abc', 'A'.repeat(64), `${TOKEN}x`, '../respond/' + TOKEN, '1']) {
    assert.equal(
      readAppointmentClientActionToken(new Request(`https://tattooai.example/appointments/respond/${tail}`)),
      null,
      tail,
    );
  }
});

await test('a malformed token returns the generic unavailable page without a backend call', async () => {
  const { calls, fetchImpl } = backendFetch();
  const response = await handleAppointmentClientActionRequest(
    new Request('https://tattooai.example/appointments/respond/not-a-token'),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(await response.text(), /not-a-token/);
});

await test('GET is scanner-safe: it resolves but never consumes the capability', async () => {
  const { calls, fetchImpl } = backendFetch();
  const response = await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].href, /service_resolve_appointment_client_action$/);
  assert.deepEqual(calls[0].body, { p_token: TOKEN });
  assert.equal(calls.some((call) => call.href.includes('service_apply_appointment_client_action')), false);
  assert.match(await response.text(), /Confirm attendance/);
});

await test('HEAD is also read-only and has no response body', async () => {
  const { calls, fetchImpl } = backendFetch();
  const response = await handleAppointmentClientActionRequest(
    new Request(URL, { method: 'HEAD' }), env, { fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].href, /service_resolve_appointment_client_action$/);
  assert.equal(await response.text(), '');
});

await test('each server-bound action has explicit copy and reschedule does not promise a moved slot', async () => {
  const cases = [
    ['confirm_attendance', 'attendance_confirmed', /Confirm attendance/],
    ['request_reschedule', 'reschedule_requested', /current appointment stays booked at its existing time/i],
    ['cancel', 'cancelled', /This action cannot be undone from this link/i],
  ];
  for (const [action, outcome, pattern] of cases) {
    const { fetchImpl } = backendFetch({ action, outcome });
    const response = await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl });
    assert.equal(response.status, 200);
    assert.match(await response.text(), pattern);
  }
});

await test('the rendered confirmation page leaks no capability or backend identifier', async () => {
  const { fetchImpl } = backendFetch();
  const html = await (await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl })).text();
  for (const forbidden of [
    TOKEN,
    'p_token',
    'session_id',
    'artist_id',
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  ]) {
    assert.equal(html.includes(forbidden), false, `rendered page must not contain ${forbidden}`);
  }
  assert.equal(/type=["']?hidden/i.test(html), false);
  assert.equal(/name=["']?(action|token|session)/i.test(html), false);
});

await test('hostile artist labels are escaped instead of rendered as markup', async () => {
  const { fetchImpl } = backendFetch({ artistName: '<script>alert(1)</script>' });
  const html = await (await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl })).text();
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

await test('invalid, expired and already-consumed backend capabilities share one 404 surface', async () => {
  for (const status of [400, 403, 404, 409]) {
    const { fetchImpl } = backendFetch({ resolveStatus: status });
    const response = await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl });
    assert.equal(response.status, 404, `resolver ${status}`);
    const html = await response.text();
    assert.equal(html.includes(TOKEN), false);
  }
});

await test('backend outage is retryable without exposing provider detail', async () => {
  for (const status of [429, 500, 503]) {
    const { fetchImpl } = backendFetch({ resolveStatus: status });
    const response = await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl });
    assert.equal(response.status, 503, `resolver ${status}`);
    assert.doesNotMatch(await response.text(), /supabase|database|429|500|503/i);
  }
});

await test('missing backend configuration fails closed as a generic 503 page', async () => {
  const response = await handleAppointmentClientActionRequest(new Request(URL), {}, {});
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /supabase|configuration|secret|key/i);
});

await test('public pages are no-store, no-referrer, unindexable and cannot be framed', async () => {
  const { fetchImpl } = backendFetch();
  const response = await handleAppointmentClientActionRequest(new Request(URL), env, { fetchImpl });
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('X-Robots-Tag') || '', /noindex/);
  assert.match(response.headers.get('Content-Security-Policy') || '', /form-action 'self'/);
  assert.match(response.headers.get('Content-Security-Policy') || '', /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

await test('POST sends only the path token and no browser-selected action', async () => {
  const { calls, fetchImpl } = backendFetch({
    action: 'request_reschedule',
    outcome: 'reschedule_requested',
  });
  const form = new FormData();
  form.append('action', 'cancel');
  form.append('session_id', '11111111-1111-4111-8111-111111111111');
  form.append('token', OTHER_TOKEN);

  const response = await handleAppointmentClientActionRequest(
    new Request(URL, { method: 'POST', body: form }),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].href, /service_apply_appointment_client_action$/);
  assert.deepEqual(calls[0].body, { p_token: TOKEN });
  const serialized = JSON.stringify(calls[0].body);
  assert.equal(serialized.includes(OTHER_TOKEN), false);
  assert.equal(serialized.includes('session_id'), false);
  assert.match(await response.text(), /current appointment remains booked until a new time is confirmed/i);
});

await test('a mismatched backend action/outcome pair fails closed', async () => {
  const { fetchImpl } = backendFetch({ action: 'cancel', outcome: 'attendance_confirmed' });
  const response = await handleAppointmentClientActionRequest(
    new Request(URL, { method: 'POST' }), env, { fetchImpl },
  );
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /confirmed|cancelled/i);
});

await test('a rejected or replayed POST becomes the same generic unavailable page', async () => {
  const { fetchImpl } = backendFetch({ applyStatus: 403 });
  const response = await handleAppointmentClientActionRequest(
    new Request(URL, { method: 'POST' }), env, { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes(TOKEN), false);
});

await test('unsupported methods are refused before the backend', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const { calls, fetchImpl } = backendFetch();
    const response = await handleAppointmentClientActionRequest(
      new Request(URL, { method }), env, { fetchImpl },
    );
    assert.equal(response.status, 405, method);
    assert.equal(calls.length, 0, method);
  }
});

await test('OPTIONS stays same-origin and performs no database call', async () => {
  const { calls, fetchImpl } = backendFetch();
  const response = await handleAppointmentClientActionRequest(
    new Request(URL, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 204);
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

await test('the production entrypoint owns malformed client-action URLs instead of delegating them', async () => {
  const response = await tattooaiEntry.fetch(
    new Request('https://tattooai.example/appointments/respond/not-a-token'),
    {},
    {},
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type') || '', /text\/html/);
});

await test('the Supabase surface remains narrow and separated from booking resolvers', () => {
  assert.deepEqual(
    [...APPOINTMENT_CLIENT_ACTION_RPCS].sort(),
    ['service_apply_appointment_client_action', 'service_resolve_appointment_client_action'],
  );
  assert.equal(READ_ONLY_RPCS.has('service_resolve_appointment_client_action'), false);
  assert.equal(ALLOWED_RPCS.has('service_resolve_appointment_client_action'), false);
  assert.equal(ALLOWED_RPCS.has('service_apply_appointment_client_action'), false);
  for (const forbidden of ['sql', 'query', 'select', 'insert', 'update', 'delete', 'from']) {
    assert.equal(ALLOWED_RPCS.has(forbidden), false);
    assert.equal(APPOINTMENT_CLIENT_ACTION_RPCS.has(forbidden), false);
    assert.equal(READ_ONLY_RPCS.has(forbidden), false);
  }
});

if (failures) {
  console.error(`\n${failures} appointment client-action test(s) failed; ${passes} passed.`);
  process.exit(1);
}
console.log(`appointment client actions: ${passes} passed`);