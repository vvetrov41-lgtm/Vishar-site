import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const auth = { authorization: 'Bearer header.payload.signature' };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };

async function capture(request, upstreamBody) {
  let captured = null;
  const response = await handleGptActionsRequest(request, env, async (url, init) => {
    captured = { url: String(url), payload: JSON.parse(init.body) };
    return new Response(JSON.stringify(upstreamBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { response, captured };
}

{
  const { response, captured } = await capture(
    new Request('https://gpt.example/v1/artists', { headers: auth }),
    [{ artist_key: 'vladimir', display_name: 'Vladimir', is_active: true }],
  );
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_accessible_artists');
  assert.deepEqual(captured.payload, {});
  assert.deepEqual(await response.json(), [{ artist_key: 'vladimir', display_name: 'Vladimir', is_active: true }]);
}

{
  const context = {
    active_artist: { key: 'kristina', display_name: 'Kristina' },
    accessible_artist_count: 2,
    selection_required: false,
  };
  const { response, captured } = await capture(
    new Request('https://gpt.example/v1/context', { headers: auth }),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_get_artist_context');
  assert.deepEqual(await response.json(), context);
}

{
  const { response, captured } = await capture(new Request('https://gpt.example/v1/context/artist', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ artist_key: 'kristina' }),
  }), { active_artist: { key: 'kristina', display_name: 'Kristina' }, changed: true });
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_set_active_artist');
  assert.deepEqual(captured.payload, { p_artist_key: 'kristina' });
  assert.equal('p_artist_id' in captured.payload, false);
}

for (const body of [
  { artist_id: 'a1111111-1111-4111-8111-111111111111', artist_key: 'vladimir' },
  { profile_id: 'f1111111-1111-4111-8111-111111111111', artist_key: 'vladimir' },
  { oauth_client_id: 'forged-client', artist_key: 'vladimir' },
  { artist_key: 'vladimir', unexpected: true },
  { artist_key: '../vladimir' },
  {},
]) {
  let called = false;
  const response = await handleGptActionsRequest(new Request('https://gpt.example/v1/context/artist', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  }), env, async () => { called = true; throw new Error('upstream must not be called'); });
  assert.equal(response.status, 400);
  assert.equal(called, false);
}

console.log('GPT unified-context tests passed: minimal routes, server RPC selection and no caller-supplied identity fields.');
