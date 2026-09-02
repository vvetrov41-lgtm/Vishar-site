#!/usr/bin/env node

// The public booking form, as a browser meets it.
//
// The defect this covers: a generated form URL opened with GET reached a
// POST-only intake boundary and answered "Use POST request" instead of
// rendering. The branded host now owns the `/forms/` namespace and proxies it
// to the intake Worker that holds the credentials, so what is asserted here is
// the shape of that boundary: GET renders, POST submits, a bad id never leaves
// the host, and nothing the browser sends becomes routing authority.

import assert from 'node:assert/strict';
import {
  __testing,
  handleProductionBookingHostRequest,
  isHostedFormNamespace,
  isValidHostedFormPath,
  proxyHostedBookingForm,
} from '../workers/booking-host-production.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const FORM_PATH = `/forms/${SOURCE_ID}`;
const FORM_URL = `https://booking.vishartattoo.com${FORM_PATH}`;
const UPSTREAM = 'https://tattooai.vvetrov41.workers.dev';

assert.equal(__testing.FORMS_UPSTREAM_ORIGIN, UPSTREAM);
assert.equal(__testing.FORMS_NAMESPACE_PREFIX, '/forms/');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the namespace claims every /forms/ path and accepts only a v4 id', () => {
  assert.equal(isHostedFormNamespace(FORM_PATH), true);
  assert.equal(isHostedFormNamespace('/forms/not-a-uuid'), true);
  assert.equal(isHostedFormNamespace('/formsx/anything'), false);
  assert.equal(isValidHostedFormPath(FORM_PATH), true);
  assert.equal(isValidHostedFormPath(`${FORM_PATH}/`), true);
  for (const invalid of [
    '/forms/',
    '/forms/not-a-uuid',
    `${FORM_PATH}/extra`,
    '/forms/11111111-1111-1111-8111-111111111111',
    '/forms/11111111-1111-4111-c111-111111111111',
  ]) {
    assert.equal(isValidHostedFormPath(invalid), false, `${invalid} must not resolve`);
  }
});

const RENDERED = '<!doctype html><title>London enquiry | Vladimir Vishar</title><form id="booking"></form>';

function upstreamFetch({ getStatus = 200, postBody = { ok: true, reference: 'ENQ-2026-TEST' }, postStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST') {
      return Response.json(postBody, { status: postStatus });
    }
    if (getStatus !== 200) {
      return new Response('<!doctype html><title>Booking form unavailable</title>', {
        status: getStatus,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(RENDERED, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        'content-security-policy': "default-src 'none'; form-action 'self'",
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'set-cookie': 'must-not-cross=1',
      },
    });
  };
  return { calls, fetchImpl };
}

test('a GET on a generated form URL renders the public form', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const response = await handleProductionBookingHostRequest(new Request(FORM_URL), { fetchImpl });

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form/);
  assert.match(html, /Vladimir Vishar/);
  // The whole point of the fix: no POST-only boundary answer reaches a browser.
  assert.doesNotMatch(html, /Use POST request/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}${FORM_PATH}`);
  assert.equal(calls[0].init.method, 'GET');
});

test('the rendered page keeps its own security headers and drops upstream cookies', async () => {
  const { fetchImpl } = upstreamFetch();
  const response = await handleProductionBookingHostRequest(new Request(FORM_URL), { fetchImpl });

  assert.match(response.headers.get('content-security-policy') || '', /form-action 'self'/);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('a browser GET never submits anything', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  await handleProductionBookingHostRequest(new Request(FORM_URL), { fetchImpl });
  assert.equal(calls.every((call) => (call.init.method || 'GET') === 'GET'), true);
  assert.equal(calls.every((call) => call.init.body === undefined), true);
});

test('a malformed id is answered here and never reaches the intake Worker', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const response = await handleProductionBookingHostRequest(
    new Request('https://booking.vishartattoo.com/forms/not-a-uuid'),
    { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
  const html = await response.text();
  assert.match(html, /Booking form unavailable/);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

test('an unknown or disabled form is a safe not-found, not a server error', async () => {
  const { fetchImpl } = upstreamFetch({ getStatus: 404 });
  const response = await handleProductionBookingHostRequest(new Request(FORM_URL), { fetchImpl });
  assert.equal(response.status, 404);
  const html = await response.text();
  assert.match(html, /Booking form unavailable/);
  assert.equal(html.includes(SOURCE_ID), false, 'the id must not be echoed back');
});

test('an upstream outage is retryable and reveals nothing', async () => {
  const { fetchImpl } = upstreamFetch({ getStatus: 500 });
  const response = await handleProductionBookingHostRequest(new Request(FORM_URL), { fetchImpl });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /supabase|internal|stack/i);

  const unreachable = await proxyHostedBookingForm(new Request(FORM_URL), {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(unreachable.status, 503);
});

test('an upstream that is not serving the namespace never speaks to a client', async () => {
  // The exact regression: the intake Worker answering a GET with its POST-only
  // boundary. That must not reach a browser through the branded host.
  const response = await proxyHostedBookingForm(new Request(FORM_URL), {
    fetchImpl: async () => new Response('Use POST request', {
      status: 405,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
    }),
  });
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.doesNotMatch(html, /Use POST request/);
  assert.match(html, /Booking temporarily unavailable/);
});

test('an upstream redirect is refused rather than reflected', async () => {
  const response = await proxyHostedBookingForm(new Request(FORM_URL), {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('location'), null);
});

test('nothing the browser sends becomes routing authority', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  await handleProductionBookingHostRequest(
    new Request(`${FORM_URL}?utm_source=mail&artist_id=forged`, {
      headers: {
        Cookie: 'crm-session=private',
        Authorization: 'Bearer browser-token',
        Origin: 'https://attacker.example',
      },
    }),
    { fetchImpl },
  );
  assert.equal(calls[0].url, `${UPSTREAM}${FORM_PATH}`, 'only the path id crosses the boundary');
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Origin, undefined);
});

test('a multipart submission still reaches the durable intake', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const body = new FormData();
  body.append('name', 'Test Person');
  body.append('idempotencyKey', '22222222-2222-4222-8222-222222222222');

  const response = await handleProductionBookingHostRequest(
    new Request(FORM_URL, { method: 'POST', body }),
    { fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reference: 'ENQ-2026-TEST' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}${FORM_PATH}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers['content-type'], /^multipart\/form-data/);
  assert.notEqual(calls[0].init.body, undefined);
});

test('a stale non-multipart submission is refused before the backend', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const response = await handleProductionBookingHostRequest(
    new Request(FORM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"artist_id":"forged"}',
    }),
    { fetchImpl },
  );
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'multipart_required');
  assert.equal(calls.length, 0);
});

test('an oversized submission is refused before the backend', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const response = await proxyHostedBookingForm(
    new Request(FORM_URL, {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(__testing.FORMS_MAX_REQUEST_BYTES + 1),
      },
      body: '--x--',
    }),
    { fetchImpl },
  );
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('an upstream rejection keeps its status, message and code', async () => {
  const { fetchImpl } = upstreamFetch({
    postStatus: 404,
    postBody: { ok: false, error: 'This booking form is not available.', code: 'booking_form_unavailable' },
  });
  const body = new FormData();
  body.append('name', 'Test Person');
  const response = await handleProductionBookingHostRequest(
    new Request(FORM_URL, { method: 'POST', body }),
    { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'This booking form is not available.',
    code: 'booking_form_unavailable',
  });
});

test('unsupported methods are refused and preflight is answered locally', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await handleProductionBookingHostRequest(
      new Request(FORM_URL, { method }),
      { fetchImpl },
    );
    assert.equal(response.status, 405, `${method} must be refused`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST, OPTIONS');
  }
  const preflight = await handleProductionBookingHostRequest(
    new Request(FORM_URL, { method: 'OPTIONS' }),
    { fetchImpl },
  );
  assert.equal(preflight.status, 204);
  assert.equal(calls.length, 0);
});

test('the namespace exists only on the branded booking host', async () => {
  const { calls, fetchImpl } = upstreamFetch();
  const response = await handleProductionBookingHostRequest(
    new Request(`https://evil.example${FORM_PATH}`),
    { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failed > 0) process.exit(1);
console.log('booking host hosted-form proxy tests passed');
