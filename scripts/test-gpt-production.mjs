import assert from 'node:assert/strict';
import worker, { handleOAuthRelay, __testing } from '../workers/gpt-actions-production.js';

const CLIENT_ID = 'synthetic-production-client';
const CHATGPT_CALLBACK = 'https://chat.openai.com/aip/g-51c4dd8ab377adfd476ee62cbb6adeba15502fef/oauth/callback';
const BRIDGE_SECRET = 'synthetic-production-bridge-secret-32-bytes-minimum';
const BASIC_AUTH = `Basic ${btoa(`${CLIENT_ID}:synthetic-client-secret`)}`;
const env = {
  VISHAR_ENVIRONMENT: 'production',
  GPT_ACTIONS_ENABLED: 'false',
  GPT_OAUTH_RELAY_ENABLED: 'true',
  GPT_OAUTH_BRIDGE_SECRET: BRIDGE_SECRET,
  SUPABASE_URL: __testing.PRODUCTION_SUPABASE_ORIGIN,
};

function authorizeUrl(overrides = {}) {
  const url = new URL('https://gpt-actions.vishartattoo.com/oauth/authorize');
  const params = {
    client_id: CLIENT_ID,
    redirect_uri: CHATGPT_CALLBACK,
    response_type: 'code',
    scope: 'email',
    state: 'synthetic-chatgpt-state',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

{
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/privacy'),
    env,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /private production integration/);
  assert.match(html, /does not accept an artist identifier from ChatGPT/);
  assert.doesNotMatch(html, /retained-staging|service_role|SUPABASE_SECRET_KEY|sb_secret_/);
}

let capturedBridgeState;
let capturedVerifier;
let bridgeCode;

{
  let captured;
  const response = await handleOAuthRelay(
    new Request(authorizeUrl(), {
      headers: {
        accept: 'text/html',
        authorization: 'Bearer must-not-forward',
        cookie: 'must-not-forward=1',
      },
    }),
    env,
    async (url, init) => {
      const parsed = new URL(url);
      capturedBridgeState = parsed.searchParams.get('state');
      captured = {
        url: String(url),
        authorization: init.headers.get('authorization'),
        cookie: init.headers.get('cookie'),
      };
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://crm.vishartattoo.com/oauth/consent?authorization_id=synthetic',
          'set-cookie': 'must-not-forward=1',
        },
      });
    },
  );
  const upstream = new URL(captured.url);
  assert.equal(upstream.origin, __testing.PRODUCTION_SUPABASE_ORIGIN);
  assert.equal(upstream.pathname, '/auth/v1/oauth/authorize');
  assert.equal(upstream.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(upstream.searchParams.get('redirect_uri'), __testing.OAUTH_BRIDGE_CALLBACK);
  assert.equal(upstream.searchParams.get('response_type'), 'code');
  assert.equal(upstream.searchParams.get('scope'), 'email');
  assert.equal(upstream.searchParams.get('code_challenge_method'), 'S256');
  assert.match(upstream.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(capturedBridgeState?.startsWith('v1.'));
  assert.notEqual(capturedBridgeState, 'synthetic-chatgpt-state');
  assert.equal(captured.authorization, null);
  assert.equal(captured.cookie, null);
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('location'),
    'https://crm.vishartattoo.com/oauth/consent?authorization_id=synthetic',
  );
  assert.equal(response.headers.get('set-cookie'), null);
}

{
  const response = await handleOAuthRelay(
    new Request(`https://gpt-actions.vishartattoo.com/oauth/callback?code=synthetic-upstream-code&state=${encodeURIComponent(capturedBridgeState)}`),
    env,
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, CHATGPT_CALLBACK);
  assert.equal(location.searchParams.get('state'), 'synthetic-chatgpt-state');
  bridgeCode = location.searchParams.get('code');
  assert.ok(bridgeCode?.startsWith('v1.'));
  assert.notEqual(bridgeCode, 'synthetic-upstream-code');
}

{
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: bridgeCode,
    redirect_uri: CHATGPT_CALLBACK,
  });
  const response = await handleOAuthRelay(
    new Request('https://gpt-actions.vishartattoo.com/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: BASIC_AUTH,
      },
      body: tokenBody,
    }),
    env,
    async (url, init) => {
      assert.equal(String(url), `${__testing.PRODUCTION_SUPABASE_ORIGIN}/auth/v1/oauth/token`);
      assert.equal(init.headers.get('authorization'), BASIC_AUTH);
      const upstream = new URLSearchParams(init.body);
      assert.equal(upstream.get('grant_type'), 'authorization_code');
      assert.equal(upstream.get('code'), 'synthetic-upstream-code');
      assert.equal(upstream.get('redirect_uri'), __testing.OAUTH_BRIDGE_CALLBACK);
      capturedVerifier = upstream.get('code_verifier');
      assert.match(capturedVerifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(upstream.has('client_secret'), false);
      return new Response(JSON.stringify({ access_token: 'synthetic-access-token', token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: 'synthetic-access-token', token_type: 'bearer' });
}

{
  assert.ok(capturedVerifier);
  const tampered = `${bridgeCode.slice(0, -1)}${bridgeCode.endsWith('A') ? 'B' : 'A'}`;
  const response = await handleOAuthRelay(
    new Request('https://gpt-actions.vishartattoo.com/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: BASIC_AUTH,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: tampered,
        redirect_uri: CHATGPT_CALLBACK,
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_token_bridge_code_invalid' });
}

{
  const wrongBasic = `Basic ${btoa(`different-production-client:synthetic-client-secret`)}`;
  const response = await handleOAuthRelay(
    new Request('https://gpt-actions.vishartattoo.com/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: wrongBasic,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_token_bridge_code_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl({ redirect_uri: 'https://evil.example/oauth/callback' })),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_redirect_uri_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl()),
    { ...env, GPT_OAUTH_BRIDGE_SECRET: undefined },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'oauth_bridge_secret_unavailable' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl()),
    { ...env, SUPABASE_URL: 'https://gwaliusblwrzisrwnsvs.supabase.co' },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'oauth_relay_production_boundary_mismatch' });
}

{
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z'),
    env,
  );
  assert.equal(response.status, 404, 'production actions remain closed while GPT_ACTIONS_ENABLED=false');
}

{
  const seen = [];
  const rateEnv = {
    ...env,
    GPT_RATE_LIMIT: {
      async limit({ key }) {
        seen.push(key);
        return { success: false };
      },
    },
  };
  const response = await worker.fetch(
    new Request('https://gpt-actions.vishartattoo.com/privacy', {
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    }),
    rateEnv,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.deepEqual(seen, ['privacy:203.0.113.7']);
}

console.log('GPT production boundary tests passed: exact production origin, ChatGPT-to-Supabase S256 PKCE bridge, encrypted callback code, inert actions, public privacy and isolated rate limit.');
