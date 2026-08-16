import assert from 'node:assert/strict';
import worker, { handleOAuthRelay, __testing } from '../workers/gpt-actions-production.js';

const env = {
  VISHAR_ENVIRONMENT: 'production',
  GPT_ACTIONS_ENABLED: 'false',
  GPT_OAUTH_RELAY_ENABLED: 'true',
  SUPABASE_URL: __testing.PRODUCTION_SUPABASE_ORIGIN,
};
const VALID_CHALLENGE = 'a'.repeat(43);

function authorizeUrl(overrides = {}) {
  const url = new URL('https://gpt-actions.vishartattoo.com/oauth/authorize');
  const params = {
    client_id: 'synthetic-production-client',
    redirect_uri: 'https://chatgpt.com/aip/g-synthetic/oauth/callback',
    response_type: 'code',
    scope: 'email',
    state: 'synthetic-state',
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
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
  assert.equal(new URL(captured.url).origin, __testing.PRODUCTION_SUPABASE_ORIGIN);
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
    new Request(authorizeUrl({ code_challenge_method: 'plain' })),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'oauth_authorize_pkce_method_invalid' });
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

console.log('GPT production boundary tests passed: exact production origin, S256 OAuth relay, inert actions, public privacy and isolated rate limit.');
