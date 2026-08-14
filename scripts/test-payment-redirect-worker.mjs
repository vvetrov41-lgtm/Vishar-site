#!/usr/bin/env node

import assert from 'node:assert/strict';
import paymentWorker from '../workers/payment-redirect.js';
import { createPaymentSupabaseClient } from '../workers/lib/payment-supabase.js';

const PUBLIC_ID = 'c6711111-1111-4111-8111-111111111111';
const PAYMENT_PATH = `/pay-by-bank-transfer/${PUBLIC_ID}`;
const MONZO_URL = 'https://monzo.com/pay/r/synthetic-vladimir_250';
const env = {
  SUPABASE_URL: 'https://synthetic-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only',
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

function withGlobalFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

await test('GET resolves one opaque id through the single backend RPC and redirects to Monzo', async () => {
  const calls = [];
  await withGlobalFetch(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(MONZO_URL), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }, async () => {
    const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), MONZO_URL);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://synthetic-project.supabase.co/rest/v1/rpc/resolve_monzo_deposit_redirect');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_test-only');
  assert.ok(!('Authorization' in calls[0].options.headers));
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_public_id: PUBLIC_ID });
});

await test('non-GET methods fail before any backend request', async () => {
  let called = false;
  await withGlobalFetch(async () => {
    called = true;
    throw new Error('backend must not be called');
  }, async () => {
    const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`, { method: 'POST' }), env);
    assert.equal(response.status, 405);
    assert.equal(await response.text(), 'Payment link unavailable');
  });
  assert.equal(called, false);
});

await test('invalid path and query strings fail before any backend request', async () => {
  let called = false;
  await withGlobalFetch(async () => {
    called = true;
    throw new Error('backend must not be called');
  }, async () => {
    for (const url of [
      'https://pay.example/pay-by-bank-transfer/not-a-uuid',
      `https://pay.example${PAYMENT_PATH}?next=https://evil.example`,
      `https://pay.example${PAYMENT_PATH}/extra`,
    ]) {
      const response = await paymentWorker.fetch(new Request(url), env);
      assert.equal(response.status, 404, url);
    }
  });
  assert.equal(called, false);
});

await test('only a clean monzo.com reusable payment URL can become a redirect', async () => {
  for (const destination of [
    'https://evil.example/pay/r/x',
    'http://monzo.com/pay/r/synthetic_1234',
    'https://monzo.com.evil.example/pay/r/synthetic_1234',
    'https://monzo.com/pay/r/synthetic_1234?next=evil',
    'https://user:pass@monzo.com/pay/r/synthetic_1234',
  ]) {
    await withGlobalFetch(
      async () => new Response(JSON.stringify(destination), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      async () => {
        const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`), env);
        assert.equal(response.status, 404, destination);
        assert.equal(response.headers.get('location'), null);
      },
    );
  }
});

await test('known backend lookup failures stay indistinguishable while server failures return 503', async () => {
  await withGlobalFetch(async () => new Response('{}', { status: 404 }), async () => {
    const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`), env);
    assert.equal(response.status, 404);
  });
  await withGlobalFetch(async () => new Response('{}', { status: 500 }), async () => {
    const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`), env);
    assert.equal(response.status, 503);
  });
});

await test('the public redirect client cannot call Monzo reconciliation RPCs', async () => {
  let called = false;
  const client = createPaymentSupabaseClient(env, async () => {
    called = true;
    return new Response('{}', { status: 200 });
  });
  await assert.rejects(
    () => client.rpc('register_monzo_reconciliation_candidate', {}),
    /payment RPC is not allowed/,
  );
  assert.equal(called, false);
});

if (failures > 0) {
  console.error(`Payment redirect Worker tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}

console.log(`Payment redirect Worker tests: ${passes} passed`);
