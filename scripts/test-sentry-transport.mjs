#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createOperationalReporter, sanitizeOperationalEvent } from '../workers/lib/observability.js';
import {
  buildSentryEnvelope,
  createSentryTransport,
  parseSentryDsn,
} from '../workers/lib/sentry-transport.js';

const DSN = 'https://abcdef0123456789abcdef0123456789@o111111.ingest.de.sentry.io/4508000000000000';

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

function parseEnvelope(text) {
  const [header, itemHeader, body] = text.split('\n');
  return { header: JSON.parse(header), itemHeader: JSON.parse(itemHeader), event: JSON.parse(body) };
}

await test('a well-formed DSN yields the envelope endpoint and public key only', async () => {
  const parsed = parseSentryDsn(DSN);
  assert.equal(parsed.publicKey, 'abcdef0123456789abcdef0123456789');
  assert.equal(parsed.projectId, '4508000000000000');
  assert.equal(parsed.envelopeUrl, 'https://o111111.ingest.de.sentry.io/api/4508000000000000/envelope/');
});

await test('malformed, non-https or secret-bearing DSNs disable the transport', async () => {
  for (const value of [
    null, '', 'not-a-url', 'http://key@o1.ingest.sentry.io/1',
    'https://key:secret@o1.ingest.sentry.io/1',
    'https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/notanumber',
    'https://o1.ingest.sentry.io/1',
    'https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/1?x=1',
    `https://abcdef0123456789abcdef0123456789@o1.ingest.sentry.io/${'1'.repeat(300)}`,
  ]) {
    assert.equal(parseSentryDsn(value), null, `expected null for ${String(value).slice(0, 40)}`);
    assert.equal(createSentryTransport({ enabled: true, dsn: value }), null);
  }
});

await test('the transport stays dormant unless explicitly enabled', async () => {
  assert.equal(createSentryTransport({ enabled: false, dsn: DSN }), null);
  assert.equal(createSentryTransport({}), null);
});

await test('the envelope carries only allow-listed sanitized fields', async () => {
  const requestId = '11111111-2222-4333-8444-555555555555';
  const payload = sanitizeOperationalEvent({
    event: 'worker.request.failed',
    stage: 'provider_call',
    requestId,
    component: 'gpt-actions-production',
    operation: 'web_search',
    environment: 'production',
    durationMs: 845,
    statusClass: '5xx',
    errorCode: 'provider_unavailable',
    outcome: 'failed',
    attempt: 2,
  });
  const { envelope } = buildSentryEnvelope(payload, parseSentryDsn(DSN), { release: 'abc1234' });
  const { header, itemHeader, event } = parseEnvelope(envelope);

  assert.equal(itemHeader.type, 'event');
  assert.equal(header.dsn, null, 'the DSN must not be echoed into the envelope header');
  assert.equal(event.message.formatted, 'worker.request.failed');
  assert.equal(event.level, 'error');
  assert.equal(event.environment, 'production');
  assert.equal(event.release, 'abc1234');
  assert.deepEqual(event.tags, {
    stage: 'provider_call',
    component: 'gpt-actions-production',
    operation: 'web_search',
    environment: 'production',
    statusClass: '5xx',
    errorCode: 'provider_unavailable',
    outcome: 'failed',
    requestId,
  });
  assert.deepEqual(event.extra, { durationMs: 845, attempt: 2 });
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.server_name, undefined);
  assert.deepEqual(event.breadcrumbs, []);
  assert.ok(!('exception' in event), 'raw exceptions must never be serialized');
  assert.ok(!('stacktrace' in event), 'stack traces must never be serialized');
});

await test('customer data cannot reach Sentry even when a caller supplies it', async () => {
  const forbidden = {
    event: 'worker.request.failed',
    component: 'telegram-drain',
    clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    enquiryId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    email: 'client@example.com',
    phone: '+447700900123',
    name: 'A Real Client',
    body: 'please cancel my appointment',
    url: 'https://crm.vishartattoo.com/enquiries?id=42',
    providerPayload: { token: 'secret-value' },
    error: new Error('boom'),
  };
  const payload = sanitizeOperationalEvent(forbidden);
  assert.deepEqual(payload, { event: 'worker.request.failed', component: 'telegram-drain' });

  const { envelope } = buildSentryEnvelope(payload, parseSentryDsn(DSN));
  for (const leak of [
    'client@example.com', '447700900123', 'A Real Client', 'please cancel',
    'crm.vishartattoo.com', 'secret-value', 'boom',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  ]) {
    assert.ok(!envelope.includes(leak), `envelope leaked ${leak}`);
  }
});

await test('the DSN secret never appears in the request body', async () => {
  let captured = null;
  const emit = createSentryTransport({
    enabled: true,
    dsn: DSN,
    fetchImpl: async (url, init) => { captured = { url, init }; return new Response('', { status: 200 }); },
  });
  await emit(sanitizeOperationalEvent({ event: 'probe.observability.sanitized', component: 'gpt-actions-production' }));

  assert.equal(captured.url, 'https://o111111.ingest.de.sentry.io/api/4508000000000000/envelope/');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'manual');
  assert.equal(captured.init.headers['content-type'], 'application/x-sentry-envelope');
  assert.match(captured.init.headers['x-sentry-auth'], /sentry_key=abcdef0123456789abcdef0123456789/);
  assert.ok(!captured.init.body.includes('abcdef0123456789abcdef0123456789'), 'DSN key must stay in the auth header');
});

await test('a Sentry outage cannot fail the CRM request path', async () => {
  const reporter = createOperationalReporter({
    enabled: true,
    emit: createSentryTransport({
      enabled: true,
      dsn: DSN,
      fetchImpl: async () => { throw new Error('sentry unreachable'); },
    }),
  });
  const result = await reporter.capture('worker.request.failed', { component: 'gpt-actions-production' });
  assert.deepEqual(result, { sent: false, reason: 'transport_failed' });
});

await test('a hung Sentry ingest is abandoned rather than held open', async () => {
  const emit = createSentryTransport({
    enabled: true,
    dsn: DSN,
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const reporter = createOperationalReporter({ enabled: true, emit });
  const result = await reporter.capture('worker.request.failed', { component: 'gpt-actions-production' });
  assert.deepEqual(result, { sent: false, reason: 'transport_failed' });
});

await test('severity is derived only from bounded status/outcome tokens', async () => {
  const cases = [
    [{ statusClass: '5xx' }, 'error'],
    [{ outcome: 'failed' }, 'error'],
    [{ statusClass: '4xx' }, 'warning'],
    [{ statusClass: '2xx', outcome: 'succeeded' }, 'info'],
    [{}, 'info'],
  ];
  for (const [fields, expected] of cases) {
    const payload = sanitizeOperationalEvent({ event: 'worker.request.completed', ...fields });
    const { event } = parseEnvelope(buildSentryEnvelope(payload, parseSentryDsn(DSN)).envelope);
    assert.equal(event.level, expected);
  }
});

await test('an unsafe release tag is dropped instead of forwarded', async () => {
  const payload = sanitizeOperationalEvent({ event: 'probe.observability.sanitized' });
  for (const release of ['../etc/passwd', 'a b', '', null, 'x'.repeat(200)]) {
    const { event } = parseEnvelope(buildSentryEnvelope(payload, parseSentryDsn(DSN), { release }).envelope);
    assert.equal(event.release, undefined, `release ${String(release).slice(0, 20)} should be dropped`);
  }
});


// --- bounded production coverage in the private Cloudflare gateway Worker ---

const { handleCloudflareGatewayRequest } = await import('../workers/cloudflare-gateway.js');
const { statusClass } = await import('../workers/lib/worker-observability.js');

const GATEWAY_ENV = Object.freeze({
  VISHAR_ENVIRONMENT: 'production',
  CLOUDFLARE_API_TOKEN: 'x'.repeat(40),
  SENTRY_ENABLED: 'true',
  SENTRY_DSN: DSN,
});

function probeRequest() {
  return new Request('https://gateway.internal/internal/observability/probe', { method: 'POST' });
}

await test('status classes are reduced to bounded tokens', async () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(502), '5xx');
  for (const bad of [null, undefined, 99, 600, 'x', 1.5]) assert.equal(statusClass(bad), 'unknown');
});

await test('observability stays dormant until Sentry is explicitly configured', async () => {
  for (const env of [
    { ...GATEWAY_ENV, SENTRY_ENABLED: 'false' },
    { ...GATEWAY_ENV, SENTRY_DSN: 'not-a-dsn' },
    { VISHAR_ENVIRONMENT: 'production', CLOUDFLARE_API_TOKEN: 'x'.repeat(40) },
  ]) {
    let called = false;
    const response = await handleCloudflareGatewayRequest(probeRequest(), env, async () => { called = true; return new Response('{}'); });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.sent, false, 'a dormant reporter must not send');
    assert.equal(called, false, 'no network call may leave a dormant Worker');
  }
});

await test('the release probe emits one sanitized event and nothing else', async () => {
  const sent = [];
  const response = await handleCloudflareGatewayRequest(probeRequest(), GATEWAY_ENV, async (url, init) => {
    sent.push({ url, body: init.body });
    return new Response('', { status: 200 });
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { probe: 'observability', sent: true, reason: null });
  assert.equal(sent.length, 1);

  const event = JSON.parse(sent[0].body.split('\n')[2]);
  assert.equal(event.message.formatted, 'probe.observability.sanitized');
  assert.deepEqual(event.tags, {
    component: 'cloudflare-gateway',
    environment: 'production',
    stage: 'release_probe',
    operation: 'observability_probe',
    outcome: 'succeeded',
    statusClass: '2xx',
  });
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.ok(!sent[0].body.includes('gateway.internal'), 'the probe URL must never be sent');
});

await test('only 5xx gateway outcomes are reported, never request content', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://o111111.ingest.de.sentry.io')) {
      sent.push(init.body);
      return new Response('', { status: 200 });
    }
    return new Response('upstream exploded', { status: 500 });
  };
  const request = new Request('https://gateway.internal/internal/cloudflare/account', { method: 'GET' });
  const response = await handleCloudflareGatewayRequest(request, GATEWAY_ENV, fetchImpl);

  assert.ok(response.status >= 500, `expected a 5xx, got ${response.status}`);
  assert.equal(sent.length, 1, 'exactly one bounded failure event');
  const event = JSON.parse(sent[0].split('\n')[2]);
  assert.equal(event.message.formatted, 'worker.request.failed');
  assert.equal(event.level, 'error');
  assert.equal(event.tags.stage, 'gateway_dispatch');
  assert.equal(event.tags.statusClass, '5xx');
  assert.equal(event.tags.outcome, 'failed');
  assert.equal(typeof event.extra.durationMs, 'number');
  for (const leak of ['gateway.internal', 'upstream exploded', 'internal/cloudflare/account']) {
    assert.ok(!sent[0].includes(leak), `failure event leaked ${leak}`);
  }
});

await test('successful gateway traffic reports nothing at all', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://o111111.ingest.de.sentry.io')) { sent.push(init.body); return new Response('', { status: 200 }); }
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: [{ id: 'a'.repeat(32), name: 'Vishar Account' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const request = new Request('https://gateway.internal/internal/cloudflare/account', { method: 'GET' });
  const response = await handleCloudflareGatewayRequest(request, GATEWAY_ENV, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0, 'healthy traffic must stay silent');
});

await test('a Sentry outage never changes the gateway response', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://o111111.ingest.de.sentry.io')) throw new Error('sentry down');
    return new Response('boom', { status: 503 });
  };
  // A path whose upstream call is not served from the resolved-account cache.
  const request = new Request('https://gateway.internal/internal/cloudflare/zones', { method: 'GET' });
  const response = await handleCloudflareGatewayRequest(request, GATEWAY_ENV, fetchImpl);
  assert.ok(response.status >= 500, `expected a 5xx, got ${response.status}`);
  const body = await response.json();
  assert.ok(typeof body.error === 'string', 'the CRM error contract is unchanged');
});

console.log(`\nSentry transport: ${passes} passed, ${failures} failed.`);
if (failures) process.exit(1);
console.log('Sentry transport tests passed: DSN-guarded, sanitizer-bound, PII-free, fail-open, timeout-bounded and dormant until configured.');
