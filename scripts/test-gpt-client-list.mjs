import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const headers = { authorization: 'Bearer header.payload.signature' };

{
  let captured;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/clients?limit=30', { headers }),
    env,
    async (url, init) => {
      captured = { url: String(url), payload: JSON.parse(init.body) };
      return new Response(JSON.stringify([{ client_id: '11111111-1111-4111-8111-111111111111', client_name: 'Client' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_clients');
  assert.deepEqual(captured.payload, { p_limit: 30 });
}

for (const url of [
  'https://gpt.example/v1/clients?artist_id=11111111-1111-4111-8111-111111111111',
  'https://gpt.example/v1/clients?limit=1000',
  'https://gpt.example/v1/clients?unexpected=yes',
]) {
  let called = false;
  const response = await handleGptActionsRequest(
    new Request(url, { headers }),
    env,
    async () => { called = true; throw new Error('upstream must not be called'); },
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
}

console.log('GPT client-list tests passed: PII-minimised named route, bounded limit, no artist selector.');
