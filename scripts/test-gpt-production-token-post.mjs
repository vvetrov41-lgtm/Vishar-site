import assert from 'node:assert/strict';
import { normalizeTokenClientAuth } from '../workers/gpt-actions-production-entrypoint.js';

const CLIENT_ID = 'synthetic-production-client';
const CLIENT_SECRET = 'synthetic-production-client-secret';
const TOKEN_URL = 'https://gpt-actions.vishartattoo.com/oauth/token';

{
  const request = new Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      redirect_uri: 'https://chat.openai.com/aip/g-synthetic/oauth/callback',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const normalized = await normalizeTokenClientAuth(request);
  assert.ok(normalized instanceof Request);
  const expected = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
  assert.equal(normalized.headers.get('authorization'), expected);
  const body = new URLSearchParams(await normalized.text());
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.has('client_secret'), false, 'POST client secret must be stripped before canonical relay');
  assert.equal(body.get('grant_type'), 'authorization_code');
}

{
  const basic = `Basic ${btoa(`${CLIENT_ID}:already-basic-secret`)}`;
  const request = new Request(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basic,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'synthetic-refresh-token',
    }),
  });
  const normalized = await normalizeTokenClientAuth(request);
  assert.strictEqual(normalized, request, 'existing client_secret_basic path must remain untouched');
}

{
  const response = await normalizeTokenClientAuth(new Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      client_id: CLIENT_ID,
      client_secret: '',
    }),
  }));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'oauth_token_client_auth_required' });
}

{
  const response = await normalizeTokenClientAuth(new Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      client_id: 'bad client id',
      client_secret: CLIENT_SECRET,
    }),
  }));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 401);
}

{
  const request = new Request('https://gpt-actions.vishartattoo.com/v1/appointments', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'client_id=must-not-normalize&client_secret=must-not-normalize',
  });
  const normalized = await normalizeTokenClientAuth(request);
  assert.strictEqual(normalized, request, 'only the OAuth token endpoint may normalize POST client credentials');
}

console.log('GPT production token POST compatibility tests passed: POST credentials become transient Basic auth, secrets are stripped from the body, existing Basic flow is unchanged, and scope stays token-endpoint-only.');
