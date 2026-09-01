#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  __testing,
  createOperationalReporter,
  sanitizeOperationalEvent,
} from '../workers/lib/observability.js';

let passes = 0;
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

await test('external payload keeps only bounded operational fields', async () => {
  const requestId = '11111111-2222-4333-8444-555555555555';
  const payload = sanitizeOperationalEvent({
    event: 'worker.request.failed',
    stage: 'provider_call',
    requestId,
    component: 'whatsapp-drain',
    operation: 'deliver',
    environment: 'production',
    durationMs: 845,
    statusClass: '5xx',
    errorCode: 'provider_unavailable',
    outcome: 'failed',
    attempt: 2,
  });

  assert.deepEqual(payload, {
    event: 'worker.request.failed',
    stage: 'provider_call',
    requestId,
    component: 'whatsapp-drain',
    operation: 'deliver',
    environment: 'production',
    durationMs: 845,
    statusClass: '5xx',
    errorCode: 'provider_unavailable',
    outcome: 'failed',
    attempt: 2,
  });
});

await test('customer identifiers and content are never external-safe fields', async () => {
  const payload = sanitizeOperationalEvent({
    event: 'worker.request.failed',
    enquiryId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fileId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    artistId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'client@example.test',
    phone: '+447700900123',
    name: 'Ada Client',
    body: 'private message content',
    message: 'private provider message',
    attachments: [{ name: 'private.jpg' }],
    providerMessageId: 'wamid.private',
    route: '/clients/secret-id/messages',
  });

  assert.deepEqual(payload, { event: 'worker.request.failed' });
  for (const forbidden of [
    'enquiryId', 'clientId', 'fileId', 'artistId', 'conversationId',
    'email', 'phone', 'name', 'body', 'message', 'attachments',
    'providerMessageId', 'route',
  ]) {
    assert.ok(!__testing.SAFE_FIELDS.has(forbidden), `${forbidden} must not be externally observable`);
  }
});

await test('credentials and provider payloads are dropped', async () => {
  const payload = sanitizeOperationalEvent({
    event: 'provider.failed',
    token: 'secret-token',
    accessToken: 'secret-token',
    refreshToken: 'secret-token',
    authorization: 'Bearer secret-token',
    cookie: 'session=secret',
    secret: 'secret-value',
    apiKey: 'secret-value',
    dsn: 'https://public@example.ingest.sentry.io/1',
    providerResponse: { error: 'raw-provider-detail' },
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.deepEqual(payload, { event: 'provider.failed' });
});

await test('raw Error and nested values cannot be serialized through safe keys', async () => {
  const raw = new Error('client@example.test failed with secret-token');
  raw.stack = 'private stack';
  const payload = sanitizeOperationalEvent({
    event: raw,
    stage: { value: 'provider_call', raw },
    errorCode: raw,
    outcome: ['failed'],
    component: new String('worker'),
  });
  assert.deepEqual(payload, {});
});

await test('safe string fields reject spaces, URLs and overlong values', async () => {
  const payload = sanitizeOperationalEvent({
    event: 'valid.event',
    stage: 'contains private free text',
    component: 'https://example.test/client/123',
    operation: 'x'.repeat(__testing.MAX_TOKEN_LENGTH + 1),
    environment: 'production',
  });
  assert.deepEqual(payload, { event: 'valid.event', environment: 'production' });
});

await test('identifier-shaped tokens are rejected outside requestId', async () => {
  const requestId = '11111111-2222-4333-8444-555555555555';
  const payload = sanitizeOperationalEvent({
    event: 'worker.failed',
    requestId,
    stage: '447700900123',
    component: 'client-447700900123',
    operation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    errorCode: 'ref_1234567890',
    outcome: 'failed',
  });
  assert.deepEqual(payload, {
    event: 'worker.failed',
    requestId,
    outcome: 'failed',
  });
});

await test('numeric and status fields are bounded', async () => {
  const payload = sanitizeOperationalEvent({
    event: 'worker.failed',
    durationMs: __testing.MAX_DURATION_MS + 1,
    attempt: __testing.MAX_ATTEMPT + 1,
    statusClass: '503',
  });
  assert.deepEqual(payload, { event: 'worker.failed' });
});

await test('disabled reporter never calls transport', async () => {
  let calls = 0;
  const reporter = createOperationalReporter({
    enabled: false,
    emit: async () => { calls += 1; },
  });
  assert.deepEqual(await reporter.capture('worker.failed', { errorCode: 'boom' }), {
    sent: false,
    reason: 'disabled',
  });
  assert.equal(calls, 0);
});

await test('enabled reporter receives only sanitized immutable payload', async () => {
  let received;
  const reporter = createOperationalReporter({
    enabled: true,
    emit: async (payload) => {
      received = payload;
      assert.ok(Object.isFrozen(payload));
    },
  });
  const result = await reporter.capture('worker.failed', {
    errorCode: 'provider_timeout',
    email: 'client@example.test',
    body: 'private message',
  });
  assert.deepEqual(result, { sent: true });
  assert.deepEqual(received, { event: 'worker.failed', errorCode: 'provider_timeout' });
});

await test('transport failures are fail-open for the CRM request path', async () => {
  const reporter = createOperationalReporter({
    enabled: true,
    emit: async () => { throw new Error('transport secret detail'); },
  });
  assert.deepEqual(await reporter.capture('worker.failed', { errorCode: 'provider_timeout' }), {
    sent: false,
    reason: 'transport_failed',
  });
});

await test('invalid events never reach transport', async () => {
  let calls = 0;
  const reporter = createOperationalReporter({
    enabled: true,
    emit: async () => { calls += 1; },
  });
  assert.deepEqual(await reporter.capture('contains private free text', { errorCode: 'boom' }), {
    sent: false,
    reason: 'invalid_event',
  });
  assert.equal(calls, 0);
});

if (failures > 0) {
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exit(1);
}

console.log(`\n${passes} passed`);
