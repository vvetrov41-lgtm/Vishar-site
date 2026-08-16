import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const auth = { authorization: 'Bearer header.payload.signature' };

{
  let captured;
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/enquiries?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&status=waiting_for_client&limit=25',
      { headers: auth },
    ),
    env,
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([{ enquiry_id: '11111111-1111-4111-8111-111111111111' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_enquiries');
  assert.deepEqual(JSON.parse(captured.init.body), {
    p_from: '2026-08-01T00:00:00Z',
    p_to: '2026-09-01T00:00:00Z',
    p_status: 'waiting_for_client',
    p_limit: 25,
  });
}

{
  let captured;
  const enquiryId = '11111111-1111-4111-8111-111111111111';
  const response = await handleGptActionsRequest(
    new Request(`https://gpt.example/v1/enquiries/${enquiryId}`, { headers: auth }),
    env,
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([{ enquiry_id: enquiryId, client_name: 'Synthetic Client' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_get_enquiry');
  assert.deepEqual(JSON.parse(captured.init.body), { p_enquiry_id: enquiryId });
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/enquiries?status=not-a-real-status', { headers: auth }),
    env,
    async () => { called = true; throw new Error('unexpected'); },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_field', field: 'status' });
  assert.equal(called, false, 'invalid enquiry status must fail before Supabase');
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/enquiries?artist_id=a1111111-1111-4111-8111-111111111111', { headers: auth }),
    env,
    async () => { called = true; throw new Error('unexpected'); },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_field', field: 'artist_id' });
  assert.equal(called, false, 'caller-selected artist_id must fail before Supabase');
}

{
  const enquiryId = '11111111-1111-4111-8111-111111111111';
  const response = await handleGptActionsRequest(
    new Request(`https://gpt.example/v1/enquiries/${enquiryId}`, { headers: auth }),
    env,
    async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'enquiry_not_found' });
}

console.log('GPT enquiry action tests passed: read-only, bounded and artist-id-free.');
