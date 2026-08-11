import assert from 'node:assert/strict';
import worker, { handleOAuthRelay, __testing } from '../workers/gpt-actions-staging.js';

const env = {
  GPT_ACTIONS_ENABLED: 'false',
  GPT_OAUTH_RELAY_ENABLED: 'true',
  SUPABASE_URL: __testing.RETAINED_STAGING_SUPABASE_ORIGIN,
};

{
  let captured;
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fchat.openai.com%2Faip%2Fsynthetic%2Foauth%2Fcallback&state=synthetic-state&code_challenge=synthetic-challenge&code_challenge_method=S256', {
    headers: { accept: 'text/html', authorization: 'Bearer must-not-forward', cookie: 'must-not-forward=1' },
  }), env, async (url, init) => {
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
  });

  assert.equal(captured.url, 'https://gwaliusblwrzisrwnsvs.supabase.co/auth/v1/oauth/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Fchat.openai.com%2Faip%2Fsynthetic%2Foauth%2Fcallback&state=synthetic-state&code_challenge=synthetic-challenge&code_challenge_method=S256');
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
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize?client_id=synthetic-client'), env, async () => new Response(null, {
    status: 302,
    headers: { location: 'https://example.invalid/callback' },
  }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_unsafe_redirect' });
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize?client_id=synthetic-client'), env, async () => new Response(JSON.stringify({ error: 'invalid_client' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_upstream_rejected' });
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize', { method: 'POST' }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env);
  assert.equal(response.status, 415);
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/token', { method: 'GET' }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize?state=synthetic'), { ...env, SUPABASE_URL: 'https://another-project.supabase.co' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'oauth_relay_staging_boundary_mismatch' });
}

{
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/authorize?state=synthetic'), { ...env, GPT_OAUTH_RELAY_ENABLED: 'false' });
  assert.equal(response, null);
}

{
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      method: init.method,
      authorization: init.headers.get('authorization'),
      contentType: init.headers.get('content-type'),
      cookie: init.headers.get('cookie'),
      body: new TextDecoder().decode(init.body),
    };
    return new Response(JSON.stringify({ access_token: 'synthetic-access-token', token_type: 'bearer' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'should-not-be-forwarded=1' },
    });
  };

  try {
    const form = 'grant_type=authorization_code&code=synthetic-code&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fsynthetic&code_verifier=synthetic-verifier';
    const response = await worker.fetch(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/token', {
      method: 'POST',
      headers: {
        authorization: 'Basic c3ludGhldGljOmNyZWRlbnRpYWw=',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'must-not-forward=1',
      },
      body: form,
    }), env);

    assert.equal(captured.url, 'https://gwaliusblwrzisrwnsvs.supabase.co/auth/v1/oauth/token');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.authorization, 'Basic c3ludGhldGljOmNyZWRlbnRpYWw=');
    assert.equal(captured.contentType, 'application/x-www-form-urlencoded');
    assert.equal(captured.cookie, null);
    assert.equal(captured.body, form);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { access_token: 'synthetic-access-token', token_type: 'bearer' });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const oversized = 'x'.repeat(__testing.OAUTH_TOKEN_BODY_BYTES + 1);
  const response = await handleOAuthRelay(new Request('https://gpt-actions-staging.vishartattoo.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: oversized }), env);
  assert.equal(response.status, 413);
}

{
  const response = await worker.fetch(new Request('https://gpt-actions-staging.vishartattoo.com/v1/appointments?from=2026-08-10T00%3A00%3A00Z&to=2026-08-11T00%3A00%3A00Z'), env);
  assert.equal(response.status, 404, 'OAuth relay activation must not expose appointment actions while the action surface is disabled');
}

console.log('GPT OAuth relay tests passed: proxied staging authorize, bounded token proxy, actions remain disabled.');
