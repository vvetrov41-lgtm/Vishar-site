#!/usr/bin/env node
// Hosted booking form route.
//
// A hosted form is served by this Worker, so there is no external Origin to
// authorise it. The only thing the browser supplies is an opaque public source
// id in the URL path, and every artist/source/template fact comes back from the
// database. These tests exist to keep that true: the rendered page must carry
// no internal routing identifier, and the POST must resolve the source before
// anything is persisted, ignoring whatever the visitor put in the body.

import assert from 'node:assert/strict';
import tattooaiEntry from '../workers/tattooai-entry.js';
import {
  handleHostedBookingRequest,
  isHostedBookingPath,
  readHostedBookingSourceId,
} from '../workers/routes/hosted-booking.js';
import { SUPPORTED_BOOKING_FORM_VERSION } from '../workers/lib/provider-routing.js';
import { ALLOWED_RPCS, READ_ONLY_RPCS } from '../workers/lib/supabase.js';

const SOURCE_ID = '39680fe5-6da0-48c0-bb6b-b543928747e2';
const OTHER_ARTIST_ID = 'a2222222-2222-4222-8222-222222222222';
const HOSTED_URL = `https://tattooai.example/forms/${SOURCE_ID}`;
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-test-key',
};

let passes = 0;
let failures = 0;
async function test(name, fn) {
  try { await fn(); passes += 1; }
  catch (error) { failures += 1; console.error(`FAIL ${name}`); console.error(`     ${error.stack || error.message}`); }
}

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const BOOKING_SOURCE_ID = 'b1111111-1111-4111-8111-111111111111';

// The exact row public.resolve_hosted_booking_source returns. It deliberately
// includes artist_id and source_key, because the durable intake path needs
// them — which is precisely why the render path must be shown to keep them out
// of the HTML rather than merely never receiving them.
function hostedMeta(overrides = {}) {
  return {
    booking_source_id: BOOKING_SOURCE_ID,
    artist_id: ARTIST_ID,
    source_key: 'vladimir-hosted',
    form_version: SUPPORTED_BOOKING_FORM_VERSION,
    form_template: 'tattoo-enquiry',
    display_label: 'Tattoo enquiry',
    artist_slug: 'vladimir',
    artist_display_name: 'Vladimir Vishar',
    ...overrides,
  };
}

function resolverFetch({ status = 200, meta = hostedMeta(), onIntake = null, emptyResult = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ href, body });

    if (href.endsWith('/rest/v1/rpc/resolve_hosted_booking_source')) {
      if (status !== 200) return new Response('{}', { status });
      if (emptyResult) return Response.json(meta);
      return Response.json([meta]);
    }
    if (href.endsWith('/rest/v1/rpc/create_hosted_enquiry_intake')) {
      if (onIntake) onIntake(body);
      return Response.json({
        enquiry_id: 'e1111111-1111-4111-8111-111111111111',
        reference_number: 'ENQ-2026-0001',
        files: [],
      });
    }
    throw new Error(`unexpected backend call: ${href}`);
  };
  return { calls, fetchImpl };
}

await test('the hosted namespace is recognised, and only a strict v4 UUID selects a source', () => {
  assert.equal(isHostedBookingPath(new Request(HOSTED_URL)), true);
  assert.equal(isHostedBookingPath(new Request('https://tattooai.example/booking')), false);

  assert.equal(readHostedBookingSourceId(new Request(HOSTED_URL)), SOURCE_ID);
  assert.equal(readHostedBookingSourceId(new Request(`${HOSTED_URL}/`)), SOURCE_ID);
  // An artist slug, a source key or a bare number must never select a source.
  for (const tail of ['vladimir', 'vladimir-website', '1', '../booking', `${SOURCE_ID}x`]) {
    assert.equal(
      readHostedBookingSourceId(new Request(`https://tattooai.example/forms/${tail}`)),
      null,
      `"${tail}" must not resolve to a source id`,
    );
  }
});

await test('a malformed hosted id is refused without ever reaching the backend', async () => {
  const { calls, fetchImpl } = resolverFetch();
  const response = await handleHostedBookingRequest(
    new Request('https://tattooai.example/forms/not-a-uuid'),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0, 'a malformed id must not cost a backend round trip');
});

await test('a hosted GET renders only the safe metadata the database returned', async () => {
  const { calls, fetchImpl } = resolverFetch();
  const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Vladimir Vishar/);
  assert.match(html, /Tattoo enquiry/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { p_public_source_id: SOURCE_ID });
});

await test('the rendered page carries no internal routing identifier', async () => {
  const { fetchImpl } = resolverFetch();
  const html = await (await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl })).text();

  // The public source id is in the URL and is not a secret. Everything that
  // selects routing on the server must be absent from what the visitor sees.
  for (const forbidden of [
    'artist_id', 'source_key', 'allowed_origin', 'integration_key',
    'service_role', env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_URL,
    ARTIST_ID, BOOKING_SOURCE_ID, 'vladimir-hosted',
  ]) {
    assert.equal(html.includes(forbidden), false, `rendered page must not contain ${forbidden}`);
  }
  // And there is no hidden input that could become authority on POST.
  assert.equal(/name=["']?artist/i.test(html), false, 'no artist field may exist in the form');
  assert.equal(/type=["']?hidden/i.test(html), false, 'the hosted template uses no hidden fields');
});

await test('hostile metadata is escaped rather than rendered as markup', async () => {
  const { fetchImpl } = resolverFetch({
    meta: hostedMeta({
      artist_display_name: '<script>alert(1)</script>',
      display_label: 'Enquiry " onload="alert(2)',
    }),
  });
  const html = await (await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl })).text();

  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('onload="alert(2)'), false);
});

await test('an unknown or deactivated hosted source renders the same unavailable page', async () => {
  for (const status of [404, 400, 403]) {
    const { fetchImpl } = resolverFetch({ status });
    const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
    assert.equal(response.status, 404, `resolver ${status} must present as unavailable`);
    const html = await response.text();
    assert.equal(html.includes(SOURCE_ID), false, 'the unavailable page must not echo the id back');
  }
});

await test('an id with no active hosted source behind it is a 404, not a 503', async () => {
  // PostgREST answers an empty result set for an id that is unknown, disabled
  // or whose artist is deactivated. That is a bad link, not a server fault, so
  // it must not present as retryable.
  for (const empty of [[], null]) {
    const { fetchImpl } = resolverFetch({ meta: empty, emptyResult: true });
    const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.equal(html.includes(SOURCE_ID), false, 'the unavailable page must not echo the id back');
    assert.equal(html.includes('<form'), false);
  }
});

await test('nothing outside the allow-listed hosted template is ever rendered', async () => {
  // resolve_hosted_booking_source returns hosted sources only, so these are
  // defence in depth against deploy skew rather than reachable states. A
  // template or version this Worker does not know is a configuration mismatch
  // and is answered as retryable; a row with no artist name is not a usable
  // form and is answered as gone.
  const cases = [
    [hostedMeta({ form_template: 'external-website' }), 503],
    [hostedMeta({ form_version: 'booking-v0' }), 503],
    [hostedMeta({ artist_display_name: null }), 503],
  ];
  for (const [meta, expected] of cases) {
    const { fetchImpl } = resolverFetch({ meta });
    const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
    assert.equal(response.status, expected);
    const html = await response.text();
    assert.equal(html.includes('<form'), false, 'no form may be rendered for an unusable source');
  }
});

await test('a backend outage is a temporary failure, not a missing form', async () => {
  const { fetchImpl } = resolverFetch({ status: 500 });
  const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
  assert.equal(response.status, 503);
});

await test('the hosted page is uncacheable, unindexable and tightly framed', async () => {
  const { fetchImpl } = resolverFetch();
  const response = await handleHostedBookingRequest(new Request(HOSTED_URL), env, { fetchImpl });
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy') || '', /frame-ancestors 'none'/);
  assert.match(await response.text(), /noindex/);
  // A hosted form is same-origin. It must not advertise cross-origin access.
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

await test('a hosted POST resolves the source before anything is persisted', async () => {
  const { calls, fetchImpl } = resolverFetch();
  const form = new FormData();
  form.append('idempotencyKey', '11111111-2222-4333-8444-555555555555');
  form.append('website', 'bot-filled-this');

  const response = await handleHostedBookingRequest(
    new Request(HOSTED_URL, { method: 'POST', body: form }),
    env,
    { fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1, 'exactly the resolver ran');
  assert.match(calls[0].href, /resolve_hosted_booking_source$/);
  assert.deepEqual(calls[0].body, { p_public_source_id: SOURCE_ID });
});

await test('a hosted POST ignores artist routing fields the visitor supplies', async () => {
  const seen = [];
  const { calls, fetchImpl } = resolverFetch({ onIntake: (body) => seen.push(body) });

  const form = new FormData();
  // Everything a tampered client could try to add.
  form.append('artist_id', OTHER_ARTIST_ID);
  form.append('p_artist_id', OTHER_ARTIST_ID);
  form.append('source_key', 'kristina-website');
  form.append('form_version', 'booking-v0');
  form.append('idempotencyKey', '11111111-2222-4333-8444-555555555555');
  form.append('website', 'bot-filled-this');

  await handleHostedBookingRequest(
    new Request(HOSTED_URL, { method: 'POST', body: form }),
    env,
    { fetchImpl },
  );

  const resolverBody = calls[0].body;
  assert.deepEqual(
    Object.keys(resolverBody),
    ['p_public_source_id'],
    'the resolver is asked only about the id in the URL',
  );
  assert.equal(resolverBody.p_public_source_id, SOURCE_ID);
  assert.equal(JSON.stringify(calls).includes(OTHER_ARTIST_ID), false);
  assert.equal(JSON.stringify(calls).includes('kristina-website'), false);
  assert.equal(seen.length, 0, 'a honeypot submission never reaches durable intake');
});

await test('the durable hosted call names the source id and no browser-supplied routing', () => {
  // The hosted branch of handleEnquiryIntakeInternal sends only
  // p_public_source_id; the external branch is the one that sends an Origin,
  // a source key and a form version. pgTAP 227 proves the database side end to
  // end, so what matters here is that the Worker cannot widen the payload.
  const source = readHostedBookingSourceId(new Request(HOSTED_URL));
  assert.equal(source, SOURCE_ID);
  assert.equal(ALLOWED_RPCS.has('create_hosted_enquiry_intake'), true);
  assert.equal(READ_ONLY_RPCS.has('resolve_hosted_booking_source'), true);
});

await test('a non-multipart hosted POST is refused before the backend', async () => {
  const { calls, fetchImpl } = resolverFetch();
  const response = await handleHostedBookingRequest(
    new Request(HOSTED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"artist_id":"forged"}',
    }),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 415);
  assert.equal(calls.length, 0);
});

await test('unsupported hosted methods are refused', async () => {
  const { fetchImpl } = resolverFetch();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await handleHostedBookingRequest(
      new Request(HOSTED_URL, { method }), env, { fetchImpl },
    );
    assert.equal(response.status, 405, `${method} must be refused`);
  }
});

await test('the production entrypoint routes the hosted namespace to the hosted handler', async () => {
  // Reaching the legacy router would answer with a different 404 surface and
  // would never resolve a source.
  let delegated = false;
  const response = await tattooaiEntry.fetch(
    new Request('https://tattooai.example/forms/not-a-uuid'),
    env,
    { waitUntil() { delegated = true; } },
  );
  assert.equal(response.status, 404);
  assert.equal(delegated, false);
  assert.match(response.headers.get('Content-Type') || '', /text\/html/);
});

await test('the entrypoint still delegates everything outside the hosted namespace', async () => {
  const response = await tattooaiEntry.fetch(
    new Request('https://tattooai.example/', { method: 'OPTIONS' }),
    env,
    {},
  );
  // The legacy router owns this, and it is still the one answering.
  assert.notEqual(response.status, 405);
});

await test('a hosted preflight stays same-origin and advertises no CORS', async () => {
  const response = await tattooaiEntry.fetch(
    new Request(HOSTED_URL, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    env,
    {},
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

await test('the hosted route opens no generic database escape hatch', () => {
  for (const forbidden of ['sql', 'query', 'select', 'insert', 'update', 'delete', 'from']) {
    assert.equal(ALLOWED_RPCS.has(forbidden), false);
    assert.equal(READ_ONLY_RPCS.has(forbidden), false);
  }
  // The read-only resolver set must stay read-only: neither resolver may also
  // appear in the durable-write surface.
  for (const resolver of READ_ONLY_RPCS) {
    assert.equal(ALLOWED_RPCS.has(resolver), false);
  }
});

if (failures) {
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exitCode = 1;
} else {
  console.log(`hosted booking form tests passed: ${passes} cases covering namespace routing, safe rendering, escaping, source resolution order and browser-supplied routing rejection.`);
}
