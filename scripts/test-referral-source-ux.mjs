#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseEnquiryFields, PRIVACY_NOTICE_VERSION } from '../workers/lib/validation.js';
import { handleHostedBookingRequest } from '../workers/routes/hosted-booking.js';
import { handlePublicBookingRequest } from '../workers/routes/public-booking.js';
import { SUPPORTED_BOOKING_FORM_VERSION } from '../workers/lib/provider-routing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
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

const expectedOptions = [
  ['instagram', 'Instagram'],
  ['google', 'Google'],
  ['ai', 'ChatGPT / AI'],
  ['referral', 'Recommendation / Friend'],
  ['convention', 'Tattoo convention'],
  ['returning_client', 'Returning client'],
  ['other', 'Other'],
];

function assertReferralMarkup(html) {
  assert.match(html, /How did you hear about/);
  for (const [value, label] of expectedOptions) {
    assert.ok(
      html.includes(`<option value="${value}">${label}</option>`),
      `missing ${value} option`,
    );
  }
  for (const legacy of ['chatgpt', 'other_ai', 'friend_referral', 'tattoo_convention']) {
    assert.equal(html.includes(`value="${legacy}"`), false, `legacy option ${legacy} must not be rendered`);
  }
  assert.match(html, /name="discoverySourceDetail"/);
  assert.match(html, /Which AI service\? \(optional\)/);
  assert.match(html, /Who recommended/);
  assert.match(html, /Please tell us where you found/);
}

function formWith(overrides = {}) {
  const form = new FormData();
  const fields = {
    idempotencyKey: '11111111-2222-4333-8444-555555555555',
    name: 'Test Client',
    email: 'client@example.test',
    phone: '',
    instagram: '',
    preferredReply: 'Email',
    travellingFrom: 'London',
    projectType: 'Colour realism',
    placement: 'Outer forearm',
    size: '20 cm',
    coverUp: 'No',
    timing: 'Flexible',
    idea: 'A realistic raven.',
    discoverySource: 'instagram',
    discoverySourceDetail: '',
    source: '/booking/',
    privacyAcknowledged: 'true',
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    website: '',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

await test('server validation accepts normalized source and keeps AI detail', () => {
  const { enquiry } = parseEnquiryFields(formWith({
    discoverySource: 'ai',
    discoverySourceDetail: 'ChatGPT',
  }));
  assert.equal(enquiry.discoverySource, 'ai');
  assert.equal(enquiry.discoverySourceDetail, 'ChatGPT');
});

await test('Other requires a detail server-side', () => {
  assert.throws(
    () => parseEnquiryFields(formWith({ discoverySource: 'other', discoverySourceDetail: '' })),
    (error) => error?.code === 'missing_discovery_source_detail',
  );
});

await test('irrelevant detail is discarded before persistence', () => {
  const { enquiry } = parseEnquiryFields(formWith({
    discoverySource: 'convention',
    discoverySourceDetail: 'should not survive',
  }));
  assert.equal(enquiry.discoverySourceDetail, '');
});

await test('legacy no-source submissions remain accepted during rollout', () => {
  const { enquiry } = parseEnquiryFields(formWith({ discoverySource: '', discoverySourceDetail: 'ignored' }));
  assert.equal(enquiry.discoverySource, '');
  assert.equal(enquiry.discoverySourceDetail, '');
});

await test('unknown discovery categories fail closed', () => {
  assert.throws(
    () => parseEnquiryFields(formWith({ discoverySource: 'social_network_magic' })),
    (error) => error?.code === 'invalid_discovery_source',
  );
});

await test('canonical public form renders normalized referral UX', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/rest/v1/rpc/resolve_booking_source')) {
      return Response.json([{
        booking_source_id: 'b1111111-1111-4111-8111-111111111111',
        artist_id: 'a1111111-1111-4111-8111-111111111111',
        source_key: 'public-slug:vladimir-vishar',
        form_version: SUPPORTED_BOOKING_FORM_VERSION,
      }]);
    }
    throw new Error(`unexpected backend call: ${url}`);
  };
  const response = await handlePublicBookingRequest(
    new Request('https://vishartattoo.com/book/vladimir-vishar'),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  assertReferralMarkup(await response.text());
  assert.equal(calls.length, 1);
});

await test('shared hosted form renders the same normalized referral UX', async () => {
  const sourceId = '39680fe5-6da0-48c0-bb6b-b543928747e2';
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/rest/v1/rpc/resolve_hosted_booking_source')) {
      return Response.json([{
        booking_source_id: 'b1111111-1111-4111-8111-111111111111',
        artist_id: 'a1111111-1111-4111-8111-111111111111',
        source_key: 'vladimir-hosted',
        form_version: SUPPORTED_BOOKING_FORM_VERSION,
        form_template: 'tattoo-enquiry',
        display_label: 'Tattoo enquiry',
        artist_slug: 'vladimir',
        artist_display_name: 'Vladimir Vishar',
      }]);
    }
    throw new Error(`unexpected backend call: ${url}`);
  };
  const response = await handleHostedBookingRequest(
    new Request(`https://tattooai.example/forms/${sourceId}`),
    env,
    { fetchImpl },
  );
  assert.equal(response.status, 200);
  assertReferralMarkup(await response.text());
});

await test('Vladimir personal form exposes the normalized referral UX', async () => {
  const html = await readFile(path.join(root, 'booking/index.html'), 'utf8');
  assertReferralMarkup(html);
  assert.match(html, /How did you hear about Vladimir\?/);
});

await test('worker forwards discovery detail inside enquiry metadata', async () => {
  const source = await readFile(path.join(root, 'workers/routes/enquiries.js'), 'utf8');
  assert.match(source, /discovery_source:\s*enquiry\.discoverySource\s*\|\|\s*null/);
  assert.match(source, /discovery_source_detail:\s*enquiry\.discoverySourceDetail\s*\|\|\s*null/);
});

await test('migration normalizes legacy values without widening routing authority', async () => {
  const sql = await readFile(path.join(root, 'supabase/migrations/0141_enquiry_discovery_source_detail.sql'), 'utf8');
  assert.match(sql, /add column if not exists discovery_source_detail text/);
  assert.match(sql, /when 'chatgpt' then 'ai'/);
  assert.match(sql, /when 'other_ai' then 'ai'/);
  assert.match(sql, /when 'friend_referral' then 'referral'/);
  assert.match(sql, /'returning_client'/);
  assert.match(sql, /discovery_source in \('ai', 'referral', 'other'\)/);
  assert.match(sql, /create or replace function crm_private\.create_enquiry_for_booking_source/);
  assert.doesNotMatch(sql, /create or replace function public\.create_enquiry_intake/);
});

if (failures) {
  console.error(`\n${failures} referral-source test(s) failed; ${passes} passed.`);
  process.exit(1);
}
console.log(`${passes} referral-source tests passed.`);
