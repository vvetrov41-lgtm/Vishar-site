import assert from 'node:assert/strict';
import { OAuthSecurityError } from '../workers/lib/calendar-oauth-security.js';
import { __testing } from '../workers/calendar-oauth.js';

const config = {
  artistId: 'a1111111-1111-4111-8111-111111111111',
  expectedEmail: 'vvetrov41@gmail.com',
  integrationKey: 'google_calendar_vladimir',
};

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
};

let captured;
await __testing.updateIntegrationMetadata(
  config,
  'vvetrov41@gmail.com',
  true,
  env,
  async (url, init) => {
    captured = {
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    return new Response(null, { status: 204 });
  },
);

assert.equal(
  captured.url,
  'https://example.supabase.co/rest/v1/rpc/set_calendar_connection_metadata',
);
assert.equal(captured.method, 'POST');
assert.equal(captured.headers.apikey, 'sb_secret_test');
assert.equal(captured.headers.Authorization, undefined);
assert.deepEqual(captured.body, {
  p_artist_id: config.artistId,
  p_integration_key: config.integrationKey,
  p_external_account_label: 'vvetrov41@gmail.com',
  p_is_enabled: true,
});
assert.ok(!('provider' in captured.body));
assert.ok(!('configuration' in captured.body));
assert.ok(!('token' in captured.body));
assert.ok(!('refresh_token' in captured.body));

await assert.rejects(
  __testing.updateIntegrationMetadata(
    config,
    'vvetrov41@gmail.com',
    true,
    env,
    async () => Response.json({ message: 'denied' }, { status: 403 }),
  ),
  (error) => error instanceof OAuthSecurityError
    && error.code === 'calendar_metadata_update_failed'
    && error.status === 502,
);

console.log('Calendar metadata RPC tests passed: backend-only endpoint, minimal payload and safe failure mapping.');
