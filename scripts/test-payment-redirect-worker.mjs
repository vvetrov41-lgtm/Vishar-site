#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import paymentWorker from '../workers/payment-redirect.js';
import monzoGateway from '../workers/monzo-api-gateway.js';
import { createPaymentSupabaseClient } from '../workers/lib/payment-supabase.js';

const PUBLIC_ID = 'c6711111-1111-4111-8111-111111111111';
const PAYMENT_PATH = `/pay-by-bank-transfer/${PUBLIC_ID}`;
const MONZO_URL = 'https://monzo.com/pay/r/synthetic-vladimir_250';
const allowedLimiter = { limit: async () => ({ success: true }) };
const env = {
  SUPABASE_URL: 'https://synthetic-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only',
  PAYMENT_REDIRECT_RATE_LIMIT: allowedLimiter,
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

await test('existing Monzo gateway intercepts the first-party payment path before owner management handling', async () => {
  let backendCalls = 0;
  await withGlobalFetch(async () => {
    backendCalls += 1;
    return new Response(JSON.stringify(MONZO_URL), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }, async () => {
    const response = await monzoGateway.fetch(
      new Request(`https://vishartattoo.com${PAYMENT_PATH}`),
      env,
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), MONZO_URL);
  });
  assert.equal(backendCalls, 1);
});

await test('Cloudflare-safe broader route prefix still fails closed on malformed payment paths', async () => {
  let backendCalled = false;
  let rateCalled = false;
  const localEnv = {
    ...env,
    PAYMENT_REDIRECT_RATE_LIMIT: {
      limit: async () => {
        rateCalled = true;
        return { success: true };
      },
    },
  };
  await withGlobalFetch(async () => {
    backendCalled = true;
    throw new Error('payment backend must not be called');
  }, async () => {
    for (const path of [
      '/pay-by-bank-transfer',
      '/pay-by-bank-transferXYZ',
      '/pay-by-bank-transfer/not-a-uuid',
    ]) {
      const response = await monzoGateway.fetch(
        new Request(`https://vishartattoo.com${path}`),
        localEnv,
      );
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), 'Payment link unavailable', path);
    }
  });
  assert.equal(rateCalled, false);
  assert.equal(backendCalled, false);
});

await test('Monzo hostname cannot use the public payment redirect shortcut', async () => {
  let backendCalled = false;
  await withGlobalFetch(async () => {
    backendCalled = true;
    throw new Error('payment backend must not be called');
  }, async () => {
    const response = await monzoGateway.fetch(
      new Request(`https://monzo.vishartattoo.com${PAYMENT_PATH}`),
      {},
    );
    assert.notEqual(response.status, 302);
  });
  assert.equal(backendCalled, false);
});

await test('non-GET methods fail before rate limiting or backend access', async () => {
  let backendCalled = false;
  let rateCalled = false;
  const localEnv = { ...env, PAYMENT_REDIRECT_RATE_LIMIT: { limit: async () => { rateCalled = true; return { success: true }; } } };
  await withGlobalFetch(async () => {
    backendCalled = true;
    throw new Error('backend must not be called');
  }, async () => {
    const response = await paymentWorker.fetch(new Request(`https://pay.example${PAYMENT_PATH}`, { method: 'POST' }), localEnv);
    assert.equal(response.status, 405);
  });
  assert.equal(rateCalled, false);
  assert.equal(backendCalled, false);
});

await test('invalid path and query strings fail before rate limiting or backend access', async () => {
  let backendCalled = false;
  let rateCalled = false;
  const localEnv = { ...env, PAYMENT_REDIRECT_RATE_LIMIT: { limit: async () => { rateCalled = true; return { success: true }; } } };
  await withGlobalFetch(async () => {
    backendCalled = true;
    throw new Error('backend must not be called');
  }, async () => {
    for (const url of [
      'https://pay.example/pay-by-bank-transfer/not-a-uuid',
      `https://pay.example${PAYMENT_PATH}?next=https://evil.example`,
      `https://pay.example${PAYMENT_PATH}/extra`,
    ]) {
      const response = await paymentWorker.fetch(new Request(url), localEnv);
      assert.equal(response.status, 404, url);
    }
  });
  assert.equal(rateCalled, false);
  assert.equal(backendCalled, false);
});

await test('rate limiting applies before the privileged backend lookup and fails closed', async () => {
  for (const [limiter, expected] of [
    [{ limit: async () => ({ success: false }) }, 429],
    [undefined, 503],
    [{ limit: async () => { throw new Error('limiter unavailable'); } }, 503],
  ]) {
    let backendCalled = false;
    await withGlobalFetch(async () => {
      backendCalled = true;
      throw new Error('backend must not be called');
    }, async () => {
      const response = await paymentWorker.fetch(
        new Request(`https://pay.example${PAYMENT_PATH}`),
        { ...env, PAYMENT_REDIRECT_RATE_LIMIT: limiter },
      );
      assert.equal(response.status, expected);
    });
    assert.equal(backendCalled, false);
  }
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

await test('production Monzo config owns the bounded payment route without introducing a new backend credential', async () => {
  const config = fs.readFileSync(new URL('../wrangler.monzo-api.production.toml', import.meta.url), 'utf8');
  assert.match(config, /name = "vishar-monzo-api-production"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /preview_urls = false/);
  assert.match(config, /pattern = "vishartattoo\.com\/pay-by-bank-transfer\*"/);
  assert.doesNotMatch(config, /pattern = "vishartattoo\.com\/pay-by-bank-transfer\/\*"/);
  assert.match(config, /SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"/);
  assert.match(config, /name = "PAYMENT_REDIRECT_RATE_LIMIT"/);
  assert.match(config, /name = "MONZO_WEBHOOK_RATE_LIMIT"/);
  assert.doesNotMatch(config, /SUPABASE_SECRET_KEY\s*=/);
  assert.doesNotMatch(config, /gwaliusblwrzisrwnsvs/);
});

if (failures > 0) {
  console.error(`Payment redirect Worker tests: ${passes} passed, ${failures} failed`);
  process.exit(1);
}

console.log(`Payment redirect Worker tests: ${passes} passed`);
