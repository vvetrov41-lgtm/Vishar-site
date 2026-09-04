#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  __testing,
  isPublicBookingNamespace,
  isValidPublicBookingPath,
  proxyPublicBooking,
} from '../workers/public-booking-edge.js';

const URL = 'https://vishartattoo.com/book/vladimir';
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function upstream(response = new Response('<!doctype html><title>Booking | Vladimir</title><form></form>', {
  status: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'",
    'x-frame-options': 'DENY',
    'set-cookie': 'must-not-cross=1',
  },
})) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => { calls.push({ url: String(url), init }); return response.clone(); },
  };
}

test('route owns only strict /book/{slug} paths', () => {
  assert.equal(isPublicBookingNamespace('/book/vladimir'), true);
  assert.equal(isPublicBookingNamespace('/portfolio'), false);
  assert.equal(isValidPublicBookingPath('/book/vladimir'), true);
  assert.equal(isValidPublicBookingPath('/book/vladimir/'), true);
  for (const bad of ['/book/', '/book/Vladimir', '/book/v', '/book/vladimir/extra', '/portfolio']) {
    assert.equal(isValidPublicBookingPath(bad), false);
  }
});

test('GET forwards only to the fixed intake origin and keeps query as non-authoritative analytics input', async () => {
  const { calls, fetchImpl } = upstream();
  const response = await proxyPublicBooking(
    new Request(`${URL}?artist_id=kristina&utm_source=instagram`, {
      headers: { Cookie: 'private=1', Authorization: 'Bearer browser', Origin: 'https://evil.example' },
    }),
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${__testing.UPSTREAM_ORIGIN}/book/vladimir?artist_id=kristina&utm_source=instagram`);
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Origin, undefined);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/);
});

test('wrong host and malformed slug never reach upstream', async () => {
  for (const url of ['https://www.vishartattoo.com/book/vladimir', 'https://vishartattoo.com/book/not_valid']) {
    let called = false;
    const response = await proxyPublicBooking(new Request(url), {
      fetchImpl: async () => { called = true; throw new Error('must not run'); },
    });
    assert.equal(response.status, 404);
    assert.equal(called, false);
  }
});

test('POST forwards only multipart content type and body, never browser authority headers', async () => {
  const { calls, fetchImpl } = upstream(Response.json({ ok: true, reference: 'TEST-1' }));
  const body = new FormData();
  body.append('name', 'Test');
  const response = await proxyPublicBooking(
    new Request(URL, {
      method: 'POST',
      body,
      headers: { Cookie: 'private=1', Authorization: 'Bearer browser', Origin: 'https://evil.example' },
    }),
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.headers['content-type'], /^multipart\/form-data/);
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Origin, undefined);
  assert.notEqual(calls[0].init.body, undefined);
});

test('stale JSON, oversized bodies and unsupported methods fail locally', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not run'); };
  let response = await proxyPublicBooking(new Request(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), { fetchImpl });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'multipart_required');

  response = await proxyPublicBooking(new Request(URL, {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(__testing.MAX_REQUEST_BYTES + 1),
    },
    body: '--x--',
  }), { fetchImpl });
  assert.equal(response.status, 413);

  response = await proxyPublicBooking(new Request(URL, { method: 'PUT' }), { fetchImpl });
  assert.equal(response.status, 405);
  assert.equal(calls, 0);
});

test('redirects and network failure are not reflected to visitors', async () => {
  let response = await proxyPublicBooking(new Request(URL), {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);

  response = await proxyPublicBooking(new Request(URL), {
    fetchImpl: async () => { throw new Error('network'); },
  });
  assert.equal(response.status, 502);
});

let failures = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures += 1; console.error(`not ok - ${name}`); console.error(error); }
}
if (failures) process.exit(1);
console.log('public booking edge tests passed');
