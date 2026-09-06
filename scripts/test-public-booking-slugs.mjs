#!/usr/bin/env node

import assert from 'node:assert/strict';
import tattooaiEntry from '../workers/tattooai-entry.js';
import {
  __testing,
  handlePublicBookingRequest,
  isPublicBookingPath,
  readPublicBookingSlug,
} from '../workers/routes/public-booking.js';
import { readTrustedBookingConfig } from '../workers/lib/provider-routing.js';
import { PUBLIC_SLUG_LOOKUP_RPCS, READ_ONLY_RPCS } from '../workers/lib/supabase.js';

const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
};
const URL = 'https://tattooai.example/book/vladimir';

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function resolverFetch({ status = 200, row = null } = {}) {
  const calls = [];
  const resolved = row ?? {
    booking_source_id: '11111111-1111-4111-8111-111111111111',
    artist_id: '22222222-2222-4222-8222-222222222222',
    source_key: 'vladimir-website',
    form_version: 'booking-v1',
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/rest/v1/rpc/resolve_booking_source')) {
      if (status !== 200) return Response.json({ code: '42501' }, { status });
      return Response.json([resolved]);
    }
    throw new Error(`unexpected backend call ${url}`);
  };
  return { calls, fetchImpl };
}

test('strict /book namespace accepts only canonical lowercase artist slugs', () => {
  assert.equal(isPublicBookingPath(new Request(URL)), true);
  assert.equal(readPublicBookingSlug(new Request(URL)), 'vladimir');
  assert.equal(readPublicBookingSlug(new Request(`${URL}/`)), 'vladimir');
  for (const bad of ['Vladimir', 'v', 'vladimir_x', '../vladimir', 'vladimir/extra']) {
    assert.equal(readPublicBookingSlug(new Request(`https://tattooai.example/book/${bad}`)), null);
  }
  assert.equal(__testing.PUBLIC_ORIGIN, 'https://vishartattoo.com');
});

test('GET resolves only the path slug, renders bounded discovery choices and ignores forged routing input', async () => {
  const { calls, fetchImpl } = resolverFetch();
  const response = await handlePublicBookingRequest(
    new Request(`${URL}?artist_id=kristina&source=forged&utm_source=instagram`),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<form/);
  assert.match(html, /Vladimir/);
  assert.doesNotMatch(html, /kristina|forged/i);
  assert.match(html, /<select id="discoverySource" name="discoverySource" required>/);
  for (const [value, label] of [
    ['instagram', 'Instagram'],
    ['google', 'Google'],
    ['ai', 'ChatGPT \/ AI'],
    ['referral', 'Recommendation \/ Friend'],
    ['convention', 'Tattoo convention'],
    ['returning_client', 'Returning client'],
    ['other', 'Other'],
  ]) {
    assert.match(html, new RegExp(`<option value="${value}">${label}</option>`));
  }
  for (const legacy of ['chatgpt', 'other_ai', 'friend_referral', 'tattoo_convention']) {
    assert.doesNotMatch(html, new RegExp(`<option value="${legacy}">`));
  }
  assert.match(html, /name="discoverySourceDetail"/);
  assert.match(html, /Which AI service\? \(optional\)/);
  assert.match(html, /Who recommended/);
  assert.match(html, /Please tell us where you found/);
  assert.doesNotMatch(html, /For example: Instagram, ChatGPT, other AI\/LLMs, recommendations from friends, Google, etc\./);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    p_source_key: 'public-slug:vladimir',
    p_origin: 'https://vishartattoo.com',
    p_form_version: 'booking-v1',
  });
});

test('unknown/deactivated slug is a safe 404', async () => {
  const { fetchImpl } = resolverFetch({ status: 403 });
  const response = await handlePublicBookingRequest(new Request(URL), env, { fetchImpl });
  assert.equal(response.status, 404);
  const html = await response.text();
  assert.match(html, /Booking form unavailable/);
  assert.doesNotMatch(html, /supabase|source_key|artist_id/i);
});

test('malformed slug never reaches the backend', async () => {
  let called = false;
  const response = await handlePublicBookingRequest(
    new Request('https://tattooai.example/book/not_valid'),
    env,
    { fetchImpl: async () => { called = true; throw new Error('must not run'); } },
  );
  assert.equal(response.status, 404);
  assert.equal(called, false);
});

test('non-multipart POST is refused before source resolution or persistence', async () => {
  let called = false;
  const response = await handlePublicBookingRequest(
    new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    env,
    { fetchImpl: async () => { called = true; throw new Error('must not run'); } },
  );
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'multipart_required');
  assert.equal(called, false);
});

test('multipart POST enters the existing durable intake with a server-owned slug selector', async () => {
  let called = false;
  const form = new FormData();
  form.append('website', 'honeypot');
  form.append('idempotencyKey', '11111111-2222-4333-8444-555555555555');
  const response = await handlePublicBookingRequest(
    new Request(URL, { method: 'POST', body: form }),
    env,
    { fetchImpl: async () => { called = true; throw new Error('honeypot must not persist'); } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(called, false);
});

test('server config admits only strict public-slug pseudo keys', () => {
  assert.deepEqual(
    readTrustedBookingConfig({ BOOKING_SOURCE_KEY: 'public-slug:vladimir', BOOKING_FORM_VERSION: 'booking-v1' }),
    { sourceKey: 'public-slug:vladimir', formVersion: 'booking-v1' },
  );
  for (const sourceKey of ['public-slug:Vladimir', 'public-slug:v', 'public-slug:vladimir/other', 'public-slug:../kristina']) {
    assert.throws(() => readTrustedBookingConfig({ BOOKING_SOURCE_KEY: sourceKey, BOOKING_FORM_VERSION: 'booking-v1' }));
  }
});

test('canonical slug lookup is isolated from legacy read-only and durable-write allowlists', () => {
  assert.deepEqual([...PUBLIC_SLUG_LOOKUP_RPCS], ['resolve_booking_source']);
  assert.equal(READ_ONLY_RPCS.has('resolve_booking_source'), false);
  for (const forbidden of ['sql', 'query', 'select', 'insert', 'update', 'delete']) {
    assert.equal(PUBLIC_SLUG_LOOKUP_RPCS.has(forbidden), false);
    assert.equal(READ_ONLY_RPCS.has(forbidden), false);
  }
});

test('production entrypoint claims malformed /book paths rather than falling through', async () => {
  const response = await tattooaiEntry.fetch(
    new Request('https://tattooai.example/book/not_valid'),
    env,
    {},
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failures) process.exit(1);
console.log('public booking slug tests passed');
