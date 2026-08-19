import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions-combined.js';

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};
const auth = { authorization: 'Bearer header.payload.signature' };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };
const V = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';

async function parsed(response) {
  return { status: response.status, body: await response.json() };
}

async function capture(request, upstreamBody = {}) {
  let captured = null;
  const response = await handleGptActionsRequest(request, env, async (url, init) => {
    captured = { url, init, payload: JSON.parse(init.body) };
    return new Response(JSON.stringify(upstreamBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { result: await parsed(response), captured };
}

// Existing appointment surface must continue through the unchanged core handler.
{
  const { result, captured } = await capture(new Request(
    'https://gpt.example/v1/appointments?from=2026-11-01T00%3A00%3A00Z&to=2026-12-01T00%3A00%3A00Z',
    { headers: auth },
  ), []);
  assert.equal(result.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_appointments');
}

// Single-client detail can carry PII but never artist routing input.
{
  const { result, captured } = await capture(
    new Request(`https://gpt.example/v1/clients/${C}`, { headers: auth }),
    [{ client_id: C, full_name: 'Client', email: 'client@example.test' }],
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.email, 'client@example.test');
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_get_client');
  assert.deepEqual(captured.payload, { p_client_id: C });
}

{
  let called = false;
  const response = await handleGptActionsRequest(new Request(`https://gpt.example/v1/clients/${C}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ instagram: '@updated', artist_id: V }),
  }), env, async () => { called = true; throw new Error('unexpected'); });
  assert.deepEqual(await parsed(response), {
    status: 400,
    body: { error: 'forbidden_field', field: 'artist_id' },
  });
  assert.equal(called, false);
}

// Manual enquiry creation derives artist in SQL. Edge forwards no artist_id.
{
  const { result, captured } = await capture(new Request('https://gpt.example/v1/enquiries/manual', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      request_id: V,
      client: { full_name: 'Manual Client', email: 'manual@example.test', preferred_contact: 'Email' },
      enquiry: { project_type: 'Portrait', idea: 'Test' },
      privacy_acknowledged: true,
    }),
  }), { enquiry_id: E });
  assert.equal(result.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_create_manual_enquiry');
  assert.equal('p_artist_id' in captured.payload, false);
  assert.equal(captured.payload.p_idempotency_key, V);
}

{
  let called = false;
  const response = await handleGptActionsRequest(new Request('https://gpt.example/v1/enquiries/manual', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      request_id: V,
      client: { full_name: 'Manual Client', email: 'manual@example.test' },
      enquiry: { artist_id: V, project_type: 'Portrait' },
      privacy_acknowledged: true,
    }),
  }), env, async () => { called = true; throw new Error('unexpected'); });
  const result = await parsed(response);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'forbidden_field');
  assert.equal(result.body.field, 'artist_id');
  assert.equal(called, false);
}

// Enquiry mutations are named RPCs with strict field allow-lists.
{
  const { captured } = await capture(new Request(`https://gpt.example/v1/enquiries/${E}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ placement: 'Outer forearm', preferred_timing: 'November' }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_update_enquiry');
  assert.deepEqual(captured.payload.p_enquiry, { placement: 'Outer forearm', preferred_timing: 'November' });
}

{
  const { captured } = await capture(new Request(`https://gpt.example/v1/enquiries/${E}/status`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ status: 'accepted' }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_set_enquiry_status');
}

// Project management and finance are separate named RPCs.
{
  const { captured } = await capture(new Request(`https://gpt.example/v1/projects/${P}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ title: 'Updated project' }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_update_project_details');
}

{
  const { captured } = await capture(new Request(`https://gpt.example/v1/projects/${P}/deposit`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ amount: 250, status: 'requested', currency: 'GBP' }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_update_project_deposit');
  assert.equal(captured.payload.p_deposit_amount, 250);
}

// Availability writes never accept an artist id.
{
  const { captured } = await capture(new Request('https://gpt.example/v1/availability', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      block_kind: 'day_off',
      start_at: '2026-12-01T00:00:00Z',
      end_at: '2026-12-02T00:00:00Z',
      is_all_day: true,
    }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_create_availability_block');
  assert.equal('p_artist_id' in captured.payload, false);
}

// Payment recording requires an idempotency UUID and bounded numeric amount.
{
  const { captured } = await capture(new Request(`https://gpt.example/v1/payments/requests/${P}/manual-payment`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ request_id: V, amount: 140 }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_record_manual_payment');
  assert.equal(captured.payload.p_amount, 140);
}

// Monzo reconciliation is four fixed named RPCs. The edge never accepts artist or provider routing input.
{
  const upstream = [{ candidate_id: A, amount: 250, currency: 'GBP', status: 'candidate', confirmed: false }];
  const { result, captured } = await capture(
    new Request('https://gpt.example/v1/payments/monzo/reconciliation', { headers: auth }),
    upstream,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, upstream);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_monzo_reconciliation_candidates');
  assert.deepEqual(captured.payload, {});
}

{
  const { captured } = await capture(new Request(`https://gpt.example/v1/payments/monzo/reconciliation/${A}/match`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ payment_request_id: P }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_match_monzo_reconciliation_candidate');
  assert.deepEqual(captured.payload, { p_candidate_id: A, p_payment_request_id: P });
  assert.equal('p_artist_id' in captured.payload, false);
}

for (const [action, rpc] of [
  ['ignore', 'gpt_ignore_monzo_reconciliation_candidate'],
  ['confirm', 'gpt_confirm_monzo_reconciliation_candidate'],
]) {
  const { captured } = await capture(new Request(`https://gpt.example/v1/payments/monzo/reconciliation/${A}/${action}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({}),
  }));
  assert.equal(captured.url, `https://exampleproject.supabase.co/rest/v1/rpc/${rpc}`);
  assert.deepEqual(captured.payload, { p_candidate_id: A });
}

{
  let called = false;
  const response = await handleGptActionsRequest(new Request(`https://gpt.example/v1/payments/monzo/reconciliation/${A}/match`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ payment_request_id: P, artist_id: V }),
  }), env, async () => { called = true; throw new Error('unexpected'); });
  assert.deepEqual(await parsed(response), {
    status: 400,
    body: { error: 'forbidden_field', field: 'artist_id' },
  });
  assert.equal(called, false);
}

{
  let called = false;
  const response = await handleGptActionsRequest(new Request(`https://gpt.example/v1/payments/monzo/reconciliation/${A}/confirm`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ provider_transaction_id: 'tx-secret' }),
  }), env, async () => { called = true; throw new Error('unexpected'); });
  assert.deepEqual(await parsed(response), {
    status: 400,
    body: { error: 'forbidden_field', field: 'provider_transaction_id' },
  });
  assert.equal(called, false);
}

// Communication sends are explicit named consequential routes with idempotency.
{
  const { captured } = await capture(new Request(`https://gpt.example/v1/whatsapp/conversations/${A}/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ request_id: V, body: 'Hello from a bounded test' }),
  }));
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_send_whatsapp_message');
  assert.deepEqual(captured.payload, { p_conversation_id: A, p_body: 'Hello from a bounded test', p_request_id: V });
}

// Private-file Actions expose metadata RPCs only, never a Storage path parameter.
{
  const { captured } = await capture(
    new Request(`https://gpt.example/v1/enquiries/${E}/files`, { headers: auth }),
    [],
  );
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_enquiry_files');
  assert.deepEqual(captured.payload, { p_enquiry_id: E });
}

// Unknown RPC selection fields fail before any upstream request.
{
  let called = false;
  const response = await handleGptActionsRequest(new Request('https://gpt.example/v1/notes', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ body: 'note', rpc: 'dangerous_rpc' }),
  }), env, async () => { called = true; throw new Error('unexpected'); });
  const result = await parsed(response);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'forbidden_field');
  assert.equal(result.body.field, 'rpc');
  assert.equal(called, false);
}

console.log('GPT full CRM Actions tests passed: named RPCs, fixed artist routing, bounded PII/finance/communications and Monzo reconciliation.');
