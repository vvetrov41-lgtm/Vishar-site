import assert from 'node:assert/strict';
import worker, { __testing } from '../workers/calendar-oauth.js';

const { enforceRateLimit, rateLimitActor, rateLimitRouteClass } = __testing;

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

function request(pathname, headers = {}) {
  return new Request(`https://calendar.vishartattoo.com${pathname}`, { headers });
}

function recordingLimiter(outcome = true) {
  const keys = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success: typeof outcome === 'function' ? outcome(key) : outcome };
    },
  };
}

await test('route classes are a closed enumeration for every artist', () => {
  assert.equal(rateLimitRouteClass('/health'), 'health');
  assert.equal(rateLimitRouteClass('/oauth/google/start/vladimir'), 'oauth_start');
  assert.equal(rateLimitRouteClass('/oauth/google/start/kristina'), 'oauth_start');
  assert.equal(rateLimitRouteClass('/oauth/google/callback'), 'oauth_callback');
  assert.equal(rateLimitRouteClass('/oauth/google/disconnect/vladimir'), 'oauth_disconnect');
  assert.equal(rateLimitRouteClass('/oauth/google/disconnect/kristina'), 'oauth_disconnect');
  // The class is the route, never the artist, so a caller who invents artist
  // references still spends the same oauth_start budget.
  assert.equal(rateLimitRouteClass('/oauth/google/start/sam'), 'oauth_start');
  assert.equal(rateLimitRouteClass('/oauth/google/start/mallory'), 'oauth_start');
  assert.equal(
    rateLimitRouteClass('/oauth/google/disconnect/new-artist-42'),
    'oauth_disconnect',
  );
});

await test('unrecognised paths cannot mint new buckets', () => {
  const classes = new Set([
    rateLimitRouteClass('/'),
    rateLimitRouteClass('/admin'),
    rateLimitRouteClass('/oauth/google/start'),
    rateLimitRouteClass('/oauth/google/start/vladimir/../../etc'),
    rateLimitRouteClass('/health/'),
    rateLimitRouteClass(`/scan-${Math.random()}`),
  ]);
  assert.deepEqual([...classes], ['other'], 'every unmatched path must share one bucket');
});

await test('the actor is the Access session, not an attacker-rotatable claim', async () => {
  const assertion = 'header.payload.signature';
  const first = await rateLimitActor(request('/health', { 'Cf-Access-Jwt-Assertion': assertion }));
  const second = await rateLimitActor(request('/health', { 'Cf-Access-Jwt-Assertion': assertion }));
  assert.equal(first, second, 'one Access session must map to one stable bucket');
  assert.match(first, /^access:[A-Za-z0-9_-]+$/);
  assert.ok(!first.includes(assertion), 'the raw assertion must never appear in the key');

  const other = await rateLimitActor(request('/health', { 'Cf-Access-Jwt-Assertion': 'other.token.value' }));
  assert.notEqual(first, other, 'a different Access session must map to a different bucket');
});

await test('requests without an Access assertion fall back to the connecting address', async () => {
  const actor = await rateLimitActor(request('/health', { 'CF-Connecting-IP': '203.0.113.7' }));
  assert.equal(actor, 'edge:203.0.113.7');
  assert.equal(await rateLimitActor(request('/health')), 'edge:unknown');
});

await test('the limiter key combines route class and actor', async () => {
  const limiter = recordingLimiter(true);
  const url = new URL('https://calendar.vishartattoo.com/oauth/google/start/vladimir');
  const result = await enforceRateLimit(
    request('/oauth/google/start/vladimir', { 'CF-Connecting-IP': '203.0.113.7' }),
    url,
    { CALENDAR_RATE_LIMIT: limiter },
  );
  assert.equal(result, null, 'an allowed request must not be intercepted');
  assert.deepEqual(limiter.keys, ['oauth_start:edge:203.0.113.7']);
});

await test('an exceeded limit returns a safe 429 with no cacheable body', async () => {
  const limiter = recordingLimiter(false);
  const response = await enforceRateLimit(
    request('/oauth/google/start/vladimir'),
    new URL('https://calendar.vishartattoo.com/oauth/google/start/vladimir'),
    { CALENDAR_RATE_LIMIT: limiter },
  );
  assert.ok(response, 'an exceeded limit must be intercepted');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: false, code: 'rate_limited' });
});

await test('the limiter runs before routing and before any Access verification', async () => {
  const limiter = recordingLimiter(false);
  const response = await worker.fetch(
    request('/oauth/google/callback?code=should-never-be-read&state=x'),
    { CALENDAR_RATE_LIMIT: limiter },
  );
  assert.equal(response.status, 429, 'a rate-limited callback must never reach token exchange');
  assert.deepEqual(limiter.keys, ['oauth_callback:edge:unknown']);
});

await test('a rate-limited unknown path is refused before the 404 handler', async () => {
  const limiter = recordingLimiter(false);
  const response = await worker.fetch(request('/wp-login.php'), { CALENDAR_RATE_LIMIT: limiter });
  assert.equal(response.status, 429);
  assert.deepEqual(limiter.keys, ['other:edge:unknown']);
});

await test('an environment without the binding is unaffected', async () => {
  // Retained staging keeps its existing Access and zone-level controls and
  // declares no binding. The Worker must behave exactly as it did before.
  for (const env of [{}, { CALENDAR_RATE_LIMIT: undefined }, { CALENDAR_RATE_LIMIT: {} }]) {
    const result = await enforceRateLimit(
      request('/health'),
      new URL('https://calendar-staging.vishartattoo.com/health'),
      env,
    );
    assert.equal(result, null, 'a Worker without a limiter binding must not be intercepted');
  }

  const response = await worker.fetch(request('/definitely-not-a-route'), {});
  assert.equal(response.status, 404, 'routing must be unchanged without the binding');
  assert.deepEqual(await response.json(), { ok: false, code: 'not_found' });
});

await test('an allowed request still reaches the existing router', async () => {
  const limiter = recordingLimiter(true);
  const response = await worker.fetch(request('/definitely-not-a-route'), { CALENDAR_RATE_LIMIT: limiter });
  assert.equal(response.status, 404);
  assert.deepEqual(limiter.keys, ['other:edge:unknown']);
});

if (failures > 0) {
  console.error(`Calendar rate limit: ${passes} passed, ${failures} failed`);
  process.exit(1);
}
console.log(`Calendar rate limit: ${passes} passed`);
