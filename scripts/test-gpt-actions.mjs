import assert from 'node:assert/strict';
import { handleGptActionsRequest } from '../workers/lib/gpt-actions.js';

const enabledEnv = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};

async function read(response) {
  return { status: response.status, body: await response.json() };
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/health'),
    { ...enabledEnv, GPT_ACTIONS_ENABLED: 'false' },
    async () => { called = true; throw new Error('unexpected'); },
  );
  assert.deepEqual(await read(response), { status: 404, body: { error: 'not_found' } });
  assert.equal(called, false, 'disabled gateway must not call Supabase');
}

{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z'),
    enabledEnv,
    async () => { throw new Error('unexpected'); },
  );
  assert.deepEqual(await read(response), {
    status: 401,
    body: { error: 'oauth_token_required' },
  });
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments', {
      method: 'POST',
      headers: { authorization: 'Bearer header.payload.signature' },
      body: '{}',
    }),
    enabledEnv,
    async () => { called = true; throw new Error('unexpected'); },
  );
  assert.deepEqual(await read(response), {
    status: 415,
    body: { error: 'unsupported_media_type' },
  });
  assert.equal(called, false, 'non-JSON writes must fail before an upstream request');
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request_id: '11111111-1111-4111-8111-111111111111',
        artist_id: 'a2222222-2222-4222-8222-222222222222',
        client_id: '22222222-2222-4222-8222-222222222222',
        appointment_type: 'in_person_consultation',
        start_at: '2026-08-10T10:00:00Z',
        end_at: '2026-08-10T10:30:00Z',
      }),
    }),
    enabledEnv,
    async () => { called = true; throw new Error('unexpected'); },
  );
  const result = await read(response);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'forbidden_field');
  assert.equal(result.body.field, 'artist_id');
  assert.equal(called, false, 'artist_id input must fail before an upstream request');
}

{
  let captured;
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request_id: '11111111-1111-4111-8111-111111111111',
        client_id: '22222222-2222-4222-8222-222222222222',
        appointment_type: 'in_person_consultation',
        start_at: '2026-08-10T10:00:00Z',
        end_at: '2026-08-10T10:30:00Z',
      }),
    }),
    enabledEnv,
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ appointment_id: '33333333-3333-4333-8333-333333333333' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  const result = await read(response);
  assert.equal(result.status, 200);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_schedule_appointment');
  assert.equal(captured.init.headers.authorization, 'Bearer header.payload.signature');
  assert.equal(captured.init.headers.apikey, enabledEnv.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(captured.init.redirect, 'manual', 'OAuth bearer subrequests must never follow redirects');
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.p_status, 'proposed');
  assert.equal('p_artist_id' in payload, false, 'proxy must never forward artist_id');
  assert.equal('p_oauth_client_id' in payload, false, 'proxy must never forward OAuth client identity');
}

{
  let captured;
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/clients/search?q=Kris&limit=5',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([
        { client_id: '33333333-3333-4333-8333-333333333333', client_name: 'Kristina Test Client' },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  const result = await read(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_search_clients');
  assert.deepEqual(JSON.parse(captured.init.body), { p_query: 'Kris', p_limit: 5 });
}

{
  let captured;
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&limit=25',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([{ appointment_id: '33333333-3333-4333-8333-333333333333' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  const result = await read(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_appointments');
  assert.equal(captured.init.redirect, 'manual');
  assert.equal(JSON.parse(captured.init.body).p_limit, 25);
}

{
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&limit=1',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async () => { throw new TypeError('synthetic network failure'); },
  );
  assert.deepEqual(await read(response), {
    status: 502,
    body: { error: 'upstream_fetch_failed' },
  });
}

{
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&limit=1',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async () => new Response(null, {
      status: 302,
      headers: { location: 'https://redirect.example.test/' },
    }),
  );
  assert.deepEqual(await read(response), {
    status: 502,
    body: { error: 'upstream_redirect_rejected' },
  });
}

{
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&limit=1',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async () => ({
      status: 200,
      ok: true,
      text: async () => { throw new TypeError('synthetic body read failure'); },
    }),
  );
  assert.deepEqual(await read(response), {
    status: 502,
    body: { error: 'upstream_read_failed' },
  });
}

{
  let called = false;
  const response = await handleGptActionsRequest(
    new Request(
      'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z&limit=26',
      { headers: { authorization: 'Bearer header.payload.signature' } },
    ),
    enabledEnv,
    async () => { called = true; throw new Error('unexpected'); },
  );
  assert.deepEqual(await read(response), {
    status: 400,
    body: { error: 'invalid_field', field: 'limit' },
  });
  assert.equal(called, false, 'oversized reads must fail at the edge');
}

{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments/33333333-3333-4333-8333-333333333333', {
      headers: { authorization: 'Bearer header.payload.signature' },
    }),
    enabledEnv,
    async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  assert.deepEqual(await read(response), {
    status: 404,
    body: { error: 'appointment_not_found' },
  });
}

{
  const response = await handleGptActionsRequest(
    new Request('https://gpt.example/v1/appointments/33333333-3333-4333-8333-333333333333/cancel', {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request_id: '11111111-1111-4111-8111-111111111111',
        expected_calendar_version: 4,
      }),
    }),
    enabledEnv,
    async () => new Response(JSON.stringify({
      code: '40001',
      message: 'private database text must not be returned',
      details: 'private internal detail must not be returned',
      hint: 'private hint',
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  );
  assert.deepEqual(await read(response), {
    status: 409,
    body: {
      error: '40001',
      message: 'The appointment changed since it was read. Refresh it before changing it.',
    },
  });
}

console.log('GPT Actions proxy tests passed: OAuth-only, fail-closed and artist_id-free.');
