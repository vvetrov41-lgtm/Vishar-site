import assert from 'node:assert/strict';
import worker, { omitNullFields, __testing } from '../workers/gpt-actions.js';

assert.deepEqual(
  omitNullFields({
    appointment_id: '11111111-1111-4111-8111-111111111111',
    enquiry_id: null,
    nested: { project_id: null, status: 'proposed' },
    rows: [{ value: 1, optional: null }],
  }),
  {
    appointment_id: '11111111-1111-4111-8111-111111111111',
    nested: { status: 'proposed' },
    rows: [{ value: 1 }],
  },
  'null fields are removed recursively without changing non-null values',
);

{
  const disabledEnv = {
    GPT_ACTIONS_ENABLED: 'false',
    SUPABASE_URL: 'https://exampleproject.supabase.co',
  };
  const response = await worker.fetch(
    new Request('https://gpt-actions-staging.vishartattoo.com/privacy'),
    disabledEnv,
  );
  assert.equal(response.status, 200, 'privacy notice stays available while action API is disabled');
  assert.match(response.headers.get('content-type') || '', /^text\/html/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /synthetic retained-staging data only/);
  assert.match(html, /does not accept an artist identifier from ChatGPT/);
  assert.match(html, /specific linked client's contact details/i);
  assert.match(html, /Bulk client lists remain minimised/);
  assert.match(html, /Finance and communications are separate owner-controlled capabilities/i);
  assert.match(html, /Storage paths, checksums and file bytes are not exposed/i);
  assert.match(html, /arbitrary SQL/i);
  assert.match(html, /OpenAI provides ChatGPT/);
  assert.doesNotMatch(html, /service_role|SUPABASE_SECRET_KEY|sb_secret_/);
}

{
  const response = await worker.fetch(
    new Request('https://gpt-actions-staging.vishartattoo.com/privacy', { method: 'HEAD' }),
    { GPT_ACTIONS_ENABLED: 'false' },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
}

const env = {
  GPT_ACTIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://exampleproject.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value_1234567890',
};

{
  const normalized = __testing.normalizedActionEnv({
    ...env,
    SUPABASE_PUBLISHABLE_KEY: `  ${env.SUPABASE_PUBLISHABLE_KEY}\n`,
  });
  assert.equal(normalized.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_PUBLISHABLE_KEY);
}

{
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('malformed bearer must fail before Supabase');
  };
  try {
    const response = await worker.fetch(
      new Request(
        'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z',
        { headers: { authorization: 'Bearer deliberately-invalid-token' } },
      ),
      env,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'oauth_token_required' });
    assert.equal(called, false, 'malformed non-JWT bearer must fail before an upstream request');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify([{
      appointment_id: '22222222-2222-4222-8222-222222222222',
      appointment_type: 'in_person_consultation',
      status: 'proposed',
      start_at: '2026-08-10T10:00:00Z',
      end_at: '2026-08-10T10:30:00Z',
      calendar_version: 0,
      calendar_sync_status: 'not_connected',
      client_id: '33333333-3333-4333-8333-333333333333',
      client_name: 'Synthetic Client',
      enquiry_id: null,
      project_id: null,
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await worker.fetch(
      new Request(
        'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z',
        { headers: { authorization: 'Bearer header.payload.signature' } },
      ),
      {
        ...env,
        SUPABASE_PUBLISHABLE_KEY: `${env.SUPABASE_PUBLISHABLE_KEY}\n`,
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.length, 1);
    assert.equal('enquiry_id' in body[0], false);
    assert.equal('project_id' in body[0], false);
    assert.equal(body[0].client_name, 'Synthetic Client');
    assert.equal(captured.url, 'https://exampleproject.supabase.co/rest/v1/rpc/gpt_list_appointments');
    assert.equal(captured.init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY,
      'runtime public project key whitespace must be stripped before constructing upstream headers');
    assert.equal(captured.init.redirect, 'manual',
      'Supabase subrequests must never automatically follow redirects with OAuth headers');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  let capturedRedirect;
  globalThis.fetch = async (_url, init) => {
    capturedRedirect = init.redirect;
    return new Response('', {
      status: 302,
      headers: { location: 'https://unexpected.example/' },
    });
  };
  try {
    const response = await worker.fetch(
      new Request(
        'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z',
        { headers: { authorization: 'Bearer header.payload.signature' } },
      ),
      env,
    );
    assert.equal(capturedRedirect, 'manual');
    assert.deepEqual(await (async () => ({ status: response.status, body: await response.json() }))(), {
      status: 502,
      body: {
        error: 'upstream_error',
        message: 'The CRM action could not be completed.',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('synthetic network failure'); };
  try {
    const response = await worker.fetch(
      new Request(
        'https://gpt.example/v1/appointments?from=2026-08-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z',
        { headers: { authorization: 'Bearer header.payload.signature' } },
      ),
      env,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'gateway_error' });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('GPT Actions entrypoint tests passed: privacy public, OAuth gated, trimmed project key and no-follow upstream transport.');
