import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { handleOAuthRelay, __testing } from '../workers/gpt-actions-staging.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK = 'https://chat.openai.com/aip/g-synthetic-runtime/oauth/callback';
const BRIDGE_SECRET = Buffer.alloc(32, 7).toString('base64url');
const VALID_CHALLENGE = 'a'.repeat(43);
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:synthetic-secret`).toString('base64')}`;

const env = {
  GPT_ACTIONS_ENABLED: 'false',
  GPT_OAUTH_RELAY_ENABLED: 'true',
  GPT_OAUTH_PKCE_BRIDGE_ENABLED: 'false',
  SUPABASE_URL: __testing.RETAINED_STAGING_SUPABASE_ORIGIN,
};

const bridgeEnv = {
  ...env,
  GPT_OAUTH_PKCE_BRIDGE_ENABLED: 'true',
  GPT_OAUTH_BRIDGE_KEY: BRIDGE_SECRET,
};

function authorizeUrl(overrides = {}) {
  const url = new URL(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/authorize`);
  const params = {
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    response_type: 'code',
    scope: 'email',
    state: 'synthetic-state',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === null) continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function directPkceAuthorizeUrl(overrides = {}) {
  return authorizeUrl({
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  });
}

{
  let captured;
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl(), {
      headers: {
        accept: 'text/html',
        authorization: 'Bearer must-not-forward',
        cookie: 'must-not-forward=1',
      },
    }),
    bridgeEnv,
    async (url, init) => {
      captured = {
        url: String(url),
        method: init.method,
        redirect: init.redirect,
        accept: init.headers.get('accept'),
        authorization: init.headers.get('authorization'),
        cookie: init.headers.get('cookie'),
      };
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://vishar-crm-staging.pages.dev/oauth/consent?authorization_id=synthetic-authorization',
          'set-cookie': 'must-not-forward=1',
        },
      });
    },
  );

  const capturedUrl = new URL(captured.url);
  assert.equal(capturedUrl.origin, __testing.RETAINED_STAGING_SUPABASE_ORIGIN);
  assert.equal(capturedUrl.pathname, '/auth/v1/oauth/authorize');
  assert.equal(capturedUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(capturedUrl.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(capturedUrl.searchParams.get('response_type'), 'code');
  assert.equal(capturedUrl.searchParams.get('scope'), 'email');
  assert.equal(capturedUrl.searchParams.get('code_challenge'), VALID_CHALLENGE);
  assert.equal(capturedUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(captured.method, 'GET');
  assert.equal(captured.redirect, 'manual');
  assert.equal(captured.accept, 'text/html');
  assert.equal(captured.authorization, null);
  assert.equal(captured.cookie, null);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://vishar-crm-staging.pages.dev/oauth/consent?authorization_id=synthetic-authorization');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
}

{
  let authorizeTarget;
  const authorizeResponse = await handleOAuthRelay(
    new Request(authorizeUrl(), {
      headers: {
        accept: 'text/html',
        authorization: 'Bearer must-not-forward',
        cookie: 'must-not-forward=1',
      },
    }),
    bridgeEnv,
    async (url, init) => {
      authorizeTarget = new URL(String(url));
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.get('authorization'), null);
      assert.equal(init.headers.get('cookie'), null);
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://vishar-crm-staging.pages.dev/oauth/consent?authorization_id=synthetic-bridged-authorization',
        },
      });
    },
  );

  assert.equal(authorizeResponse.status, 302);
  assert.equal(authorizeTarget.origin, __testing.RETAINED_STAGING_SUPABASE_ORIGIN);
  assert.equal(authorizeTarget.pathname, '/auth/v1/oauth/authorize');
  assert.equal(authorizeTarget.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizeTarget.searchParams.get('redirect_uri'), __testing.INTERNAL_BRIDGE_CALLBACK);
  assert.equal(authorizeTarget.searchParams.get('response_type'), 'code');
  assert.equal(authorizeTarget.searchParams.get('scope'), 'email');
  assert.equal(authorizeTarget.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeTarget.searchParams.get('code_challenge').length, 43);
  assert.notEqual(authorizeTarget.searchParams.get('state'), 'synthetic-state');

  const bridgeCallback = new URL(__testing.INTERNAL_BRIDGE_CALLBACK);
  bridgeCallback.searchParams.set('code', 'synthetic-upstream-code');
  bridgeCallback.searchParams.set('state', authorizeTarget.searchParams.get('state'));
  const callbackResponse = await handleOAuthRelay(new Request(bridgeCallback), bridgeEnv);
  assert.equal(callbackResponse.status, 302);

  const chatgptRedirect = new URL(callbackResponse.headers.get('location'));
  assert.equal(chatgptRedirect.origin, new URL(CALLBACK).origin);
  assert.equal(chatgptRedirect.pathname, new URL(CALLBACK).pathname);
  assert.equal(chatgptRedirect.searchParams.get('state'), 'synthetic-state');
  const syntheticCode = chatgptRedirect.searchParams.get('code');
  assert.match(syntheticCode, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(chatgptRedirect.searchParams.get('error'), null);

  let tokenCaptured;
  const tokenResponse = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: BASIC,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'must-not-forward=1',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: syntheticCode,
        redirect_uri: CALLBACK,
      }).toString(),
    }),
    bridgeEnv,
    async (url, init) => {
      tokenCaptured = {
        url: String(url),
        method: init.method,
        authorization: init.headers.get('authorization'),
        contentType: init.headers.get('content-type'),
        cookie: init.headers.get('cookie'),
        body: String(init.body),
      };
      return new Response(JSON.stringify({ access_token: 'synthetic-access-token', token_type: 'bearer' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'must-not-forward=1',
        },
      });
    },
  );

  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get('set-cookie'), null);
  assert.equal(tokenCaptured.url, `${__testing.RETAINED_STAGING_SUPABASE_ORIGIN}/auth/v1/oauth/token`);
  assert.equal(tokenCaptured.method, 'POST');
  assert.equal(tokenCaptured.authorization, BASIC);
  assert.equal(tokenCaptured.contentType, 'application/x-www-form-urlencoded');
  assert.equal(tokenCaptured.cookie, null);

  const upstreamToken = new URLSearchParams(tokenCaptured.body);
  assert.equal(upstreamToken.get('grant_type'), 'authorization_code');
  assert.equal(upstreamToken.get('code'), 'synthetic-upstream-code');
  assert.equal(upstreamToken.get('redirect_uri'), __testing.INTERNAL_BRIDGE_CALLBACK);
  const verifier = upstreamToken.get('code_verifier');
  assert.equal(verifier.length, 43);
  const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(expectedChallenge, authorizeTarget.searchParams.get('code_challenge'));
  assert.deepEqual(await tokenResponse.json(), { access_token: 'synthetic-access-token', token_type: 'bearer' });

  const tampered = `${syntheticCode.slice(0, -1)}${syntheticCode.endsWith('A') ? 'B' : 'A'}`;
  const tamperedResponse = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: BASIC,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: tampered,
        redirect_uri: CALLBACK,
      }).toString(),
    }),
    bridgeEnv,
    async () => {
      throw new Error('tampered bridge code must not reach upstream');
    },
  );
  assert.equal(tamperedResponse.status, 400);
  assert.deepEqual(await tamperedResponse.json(), { error: 'oauth_bridge_code_invalid' });
}

{
  let upstreamCalled = false;
  const response = await handleOAuthRelay(
    new Request(authorizeUrl()),
    env,
    async () => {
      upstreamCalled = true;
      return new Response(null, { status: 500 });
    },
  );
  assert.equal(upstreamCalled, false);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_pkce_missing' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl({ code_challenge: VALID_CHALLENGE })),
    bridgeEnv,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_pkce_partial' });
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl({ code_challenge_method: 'unsupported' })),
    bridgeEnv,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_pkce_method_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl({ code_challenge: 'too-short' })),
    bridgeEnv,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_pkce_challenge_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl({ response_type: 'token' })),
    bridgeEnv,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_response_type_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(authorizeUrl({ scope: 'profile' })),
    bridgeEnv,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_scope_invalid' });
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl()),
    bridgeEnv,
    async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.invalid/callback' },
    }),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_unsafe_redirect' });
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl()),
    bridgeEnv,
    async () => new Response(JSON.stringify({ error: 'invalid_client' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_upstream_rejected' });
}

{
  const response = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/authorize`, { method: 'POST' }),
    bridgeEnv,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
}

{
  const response = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    bridgeEnv,
  );
  assert.equal(response.status, 415);
}

{
  const response = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, { method: 'GET' }),
    bridgeEnv,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl()),
    { ...bridgeEnv, SUPABASE_URL: 'https://another-project.supabase.co' },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'oauth_relay_staging_boundary_mismatch' });
}

{
  const response = await handleOAuthRelay(
    new Request(directPkceAuthorizeUrl()),
    { ...bridgeEnv, GPT_OAUTH_RELAY_ENABLED: 'false' },
  );
  assert.equal(response, null);
}

{
  let captured;
  const form = 'grant_type=refresh_token&refresh_token=synthetic-refresh-token';
  const response = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: BASIC,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'must-not-forward=1',
      },
      body: form,
    }),
    bridgeEnv,
    async (url, init) => {
      captured = {
        url: String(url),
        method: init.method,
        authorization: init.headers.get('authorization'),
        contentType: init.headers.get('content-type'),
        cookie: init.headers.get('cookie'),
        body: new TextDecoder().decode(init.body),
      };
      return new Response(JSON.stringify({ access_token: 'refreshed-token', token_type: 'bearer' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'should-not-be-forwarded=1',
        },
      });
    },
  );

  assert.equal(captured.url, `${__testing.RETAINED_STAGING_SUPABASE_ORIGIN}/auth/v1/oauth/token`);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.authorization, BASIC);
  assert.equal(captured.contentType, 'application/x-www-form-urlencoded');
  assert.equal(captured.cookie, null);
  assert.equal(captured.body, form);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
}

{
  const oversized = 'x'.repeat(__testing.OAUTH_TOKEN_BODY_BYTES + 1);
  const response = await handleOAuthRelay(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: oversized,
    }),
    bridgeEnv,
  );
  assert.equal(response.status, 413);
}

{
  const response = await worker.fetch(
    new Request(`${__testing.GPT_ACTIONS_STAGING_ORIGIN}/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z`),
    bridgeEnv,
  );
  assert.equal(response.status, 404, 'OAuth bridge activation must not expose appointment actions while the action surface is disabled');
}

console.log('GPT OAuth relay tests passed: direct PKCE, stateless PKCE bridge, tamper guards, bounded token proxy, actions remain disabled.');