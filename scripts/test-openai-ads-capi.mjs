#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ads = await import(pathToFileURL(path.join(rootDir, 'workers', 'lib', 'openai-ads.js')).href);

let passes = 0;
let failures = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(`     ${error.stack || error.message}`);
    });
}

function form(fields = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function loggerStub() {
  const records = [];
  return {
    records,
    info(event, fields) { records.push({ level: 'info', event, fields }); },
    warn(event, fields) { records.push({ level: 'warn', event, fields }); },
  };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;

  for (const [key, nested] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    collectKeys(nested, keys);
  }
  return keys;
}

test('measurement context requires explicit granted consent', () => {
  const source = 'https://vishartattoo.com/booking/';
  assert.equal(ads.readOpenAiAdsMeasurementContext(form({ openaiAdsSourceUrl: source }), 'https://vishartattoo.com'), null);
  assert.equal(ads.readOpenAiAdsMeasurementContext(form({
    openaiAdsMeasurementConsent: 'denied',
    openaiAdsSourceUrl: source,
  }), 'https://vishartattoo.com'), null);
});

test('measurement context is restricted to Vladimir public origins', () => {
  const data = form({
    openaiAdsMeasurementConsent: 'granted',
    openaiAdsSourceUrl: 'https://other-artist.example/booking/',
  });
  assert.equal(ads.readOpenAiAdsMeasurementContext(data, 'https://other-artist.example'), null);
});

test('source URL is origin-bound and stripped of query and fragment', () => {
  const data = form({
    openaiAdsMeasurementConsent: 'granted',
    openaiAdsSourceUrl: 'https://vishartattoo.com/booking/?utm_source=test#done',
    openaiAdsOppref: 'opaque-oppref-value',
    openaiAdsObref: 'opaque-obref-value',
  });
  const context = ads.readOpenAiAdsMeasurementContext(data, 'https://vishartattoo.com');
  assert.deepEqual(context, {
    sourceUrl: 'https://vishartattoo.com/booking/',
    oppref: 'opaque-oppref-value',
    obref: 'opaque-obref-value',
  });
});

test('source URL cannot cross the observed Origin', () => {
  const data = form({
    openaiAdsMeasurementConsent: 'granted',
    openaiAdsSourceUrl: 'https://www.vishartattoo.com/booking/',
  });
  assert.equal(ads.readOpenAiAdsMeasurementContext(data, 'https://vishartattoo.com'), null);
});

test('oversized and control-character provider references are dropped', () => {
  const data = form({
    openaiAdsMeasurementConsent: 'granted',
    openaiAdsSourceUrl: 'https://vishartattoo.com/booking/',
    openaiAdsOppref: 'x'.repeat(2049),
    openaiAdsObref: 'opaque\u0000value',
  });
  const context = ads.readOpenAiAdsMeasurementContext(data, 'https://vishartattoo.com');
  assert.equal(context.oppref, '');
  assert.equal(context.obref, '');
});

test('missing CAPI secret schedules no request', () => {
  let scheduled = false;
  let fetched = false;
  const logger = loggerStub();
  const result = ads.scheduleOpenAiLeadConversion({
    env: {},
    eventId: '11111111-2222-4333-8444-555555555555',
    context: { sourceUrl: 'https://vishartattoo.com/booking/', oppref: '', obref: '' },
    schedule: () => { scheduled = true; },
    fetchImpl: async () => { fetched = true; return new Response(null, { status: 204 }); },
    logger,
  });
  assert.equal(result, false);
  assert.equal(scheduled, false);
  assert.equal(fetched, false);
  assert.equal(logger.records[0]?.event, 'openai_ads.capi_skipped');
});

test('consented lead uses the shared event id and contains no client identity', async () => {
  let task;
  let request;
  const logger = loggerStub();
  const eventId = '11111111-2222-4333-8444-555555555555';
  const result = ads.scheduleOpenAiLeadConversion({
    env: { OPENAI_ADS_CAPI_KEY: 'test-only-capi-secret' },
    eventId,
    context: {
      sourceUrl: 'https://vishartattoo.com/booking/',
      oppref: 'opaque-oppref-value',
      obref: 'opaque-obref-value',
    },
    schedule: (promise) => { task = promise; },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
    logger,
    now: () => 1788709000000,
  });

  assert.equal(result, true);
  assert.ok(task instanceof Promise);
  await task;

  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://bzr.openai.com/v1/events');
  assert.equal(url.searchParams.get('pid'), ads.OPENAI_ADS_CONFIG.pixelId);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only-capi-secret');

  const payload = JSON.parse(request.options.body);
  assert.equal(payload.validate_only, false);
  assert.equal(payload.integration_source, 'vishar_booking_worker');
  assert.equal(payload.events.length, 1);
  assert.deepEqual(payload.events[0], {
    id: eventId,
    type: 'lead_created',
    timestamp_ms: 1788709000000,
    source_url: 'https://vishartattoo.com/booking/',
    action_source: 'web',
    opt_out: true,
    data: { type: 'customer_action' },
    oppref: 'opaque-oppref-value',
    user: { obref: 'opaque-obref-value' },
  });

  const payloadKeys = collectKeys(payload);
  for (const forbidden of [
    'email',
    'phone',
    'instagram',
    'full_name',
    'name',
    'tattoo',
    'idea',
    'user_agent',
    'ip_address',
  ]) {
    assert.ok(!payloadKeys.has(forbidden), `${forbidden} must not be a CAPI payload field`);
  }
});

test('provider HTTP failure is contained inside the scheduled task', async () => {
  let task;
  const logger = loggerStub();
  assert.doesNotThrow(() => {
    ads.scheduleOpenAiLeadConversion({
      env: { OPENAI_ADS_CAPI_KEY: 'test-only-capi-secret' },
      eventId: '11111111-2222-4333-8444-555555555555',
      context: { sourceUrl: 'https://vishartattoo.com/booking/', oppref: '', obref: '' },
      schedule: (promise) => { task = promise; },
      fetchImpl: async () => new Response(null, { status: 503 }),
      logger,
    });
  });
  await task;
  assert.ok(logger.records.some((record) => record.event === 'openai_ads.capi_failed'));
});

test('a scheduler failure cannot throw into booking', () => {
  const logger = loggerStub();
  assert.doesNotThrow(() => {
    const result = ads.scheduleOpenAiLeadConversion({
      env: { OPENAI_ADS_CAPI_KEY: 'test-only-capi-secret' },
      eventId: '11111111-2222-4333-8444-555555555555',
      context: { sourceUrl: 'https://vishartattoo.com/booking/', oppref: '', obref: '' },
      schedule: () => { throw new Error('scheduler unavailable'); },
      fetchImpl: async () => new Response(null, { status: 204 }),
      logger,
    });
    assert.equal(result, false);
  });
});

await new Promise((resolve) => setTimeout(resolve, 0));
if (failures > 0) {
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`\n${passes} passed`);
