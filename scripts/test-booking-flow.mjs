#!/usr/bin/env node
//
// Worker route contract and failure tests.
//
// Covers the durable tattoo-enquiry intake end to end against stubbed Supabase,
// Storage and Telegram endpoints, and pins the behaviour of the AI, lead,
// sendIdea and book-waitlist routes so a CRM change cannot regress them.
//
// No network call leaves this process: global fetch is replaced for every case.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(pathToFileURL(path.join(rootDir, 'workers/tattooai.js')).href)).default;

const ORIGIN = 'https://vishartattoo.com';
const ENDPOINT = 'https://tattooai.vvetrov41.workers.dev/';

const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: 'test-chat',
};

let failures = 0;
let passes = 0;

// The Worker emits structured logs on every request. They are captured rather
// than printed so the test output stays readable, and so the log-redaction test
// has something to assert against. A failing case dumps its own logs.
const captured = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = (...args) => captured.push(args.map(String).join(' '));
console.warn = (...args) => captured.push(args.map(String).join(' '));
console.error = (...args) => captured.push(args.map(String).join(' '));

function capturedLines() {
  return captured.slice();
}

async function test(name, fn) {
  captured.length = 0;
  try {
    await fn();
    passes += 1;
  } catch (error) {
    failures += 1;
    realConsole.error(`FAIL ${name}`);
    realConsole.error(`     ${error.message}`);
    for (const line of captured) realConsole.error(`     | ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const NOT_AN_IMAGE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]);

function imageFile(bytes, type, name) {
  return new File([bytes], name, { type });
}

/**
 * A real over-limit file. Faking `size` would not work: the form is serialised
 * into the request body and re-parsed by the Worker, so the size the Worker
 * sees is the actual byte length.
 */
function oversizedJpeg() {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1024);
  bytes.set(JPEG, 0);
  return new File([bytes], 'big.jpg', { type: 'image/jpeg' });
}

function enquiryForm(overrides = {}) {
  const form = new FormData();
  const fields = {
    idempotencyKey: '11111111-2222-4333-8444-555555555555',
    name: 'Test Client',
    email: 'client@example.test',
    phone: '',
    instagram: '',
    preferredReply: 'Email',
    travellingFrom: 'London',
    projectType: 'Colour realism',
    placement: 'Outer forearm',
    size: '20 cm',
    coverUp: 'No',
    timing: 'Flexible',
    idea: 'A realistic raven with natural lighting.',
    website: '',
    source: '/booking/',
    landingPage: 'https://vishartattoo.com/booking/?utm_source=google',
    referrer: 'https://www.google.com/',
    utmSource: 'google',
    utmMedium: 'organic',
    ...overrides.fields,
  };

  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const files = overrides.files ?? [imageFile(JPEG, 'image/jpeg', 'reference-1.jpg')];
  for (const file of files) form.append('references', file, file.name);

  return form;
}

function enquiryRequest(form, { origin = ORIGIN, headers = {} } = {}) {
  const requestHeaders = origin === null ? { ...headers } : { Origin: origin, ...headers };
  return new Request(ENDPOINT, { method: 'POST', headers: requestHeaders, body: form });
}

/**
 * Stubs the Supabase, Storage and Telegram endpoints. `overrides` lets one
 * endpoint fail while the rest behave.
 */
function stubBackend(overrides = {}) {
  const calls = { rpc: [], uploads: [], deletes: [], telegram: 0 };

  const state = {
    enquiryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    clientId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    reference: 'ENQ-2026-0001',
    replayed: false,
    intakeState: 'files_pending',
    clientConflict: false,
    fileIds: ['f1111111-1111-4111-8111-111111111111', 'f2222222-2222-4222-8222-222222222222', 'f3333333-3333-4333-8333-333333333333'],
    ...overrides.state,
  };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes('/rest/v1/rpc/')) {
      const name = href.split('/rest/v1/rpc/')[1];
      const args = init.body ? JSON.parse(init.body) : {};
      calls.rpc.push({ name, args, headers: init.headers });

      if (overrides.rpc && overrides.rpc[name]) return overrides.rpc[name](args, calls);

      if (name === 'create_enquiry_intake') {
        const fileCount = Array.isArray(args.p_files) ? args.p_files.length : 0;
        return Response.json({
          enquiry_id: state.enquiryId,
          client_id: state.clientId,
          reference_number: state.reference,
          intake_state: state.intakeState,
          replayed: state.replayed,
          client_conflict: state.clientConflict,
          files: args.p_files.map((file, index) => ({
            file_id: state.fileIds[index],
            storage_path: `clients/${state.clientId}/enquiries/${state.enquiryId}/references/${state.fileIds[index]}.${file.safe_extension}`,
            upload_state: state.replayed && state.intakeState === 'complete' ? 'ready' : 'pending',
            mime_type: file.mime_type,
            safe_extension: file.safe_extension,
          })).slice(0, fileCount),
        });
      }

      return Response.json({ ok: true });
    }

    if (href.includes('/storage/v1/object/')) {
      if ((init.method || 'GET').toUpperCase() === 'DELETE') {
        calls.deletes.push(href);
        return new Response('{}', { status: 200 });
      }
      calls.uploads.push(href);
      if (overrides.uploadFailsAt !== undefined && calls.uploads.length === overrides.uploadFailsAt) {
        return new Response('{}', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }

    if (href.includes('api.telegram.org')) {
      calls.telegram += 1;
      if (overrides.telegramStatus) return new Response('{}', { status: overrides.telegramStatus });
      if (overrides.telegramThrows) throw new Error('network down');
      return new Response('{}', { status: 200 });
    }

    throw new Error(`Unexpected fetch: ${href}`);
  };

  return calls;
}

async function send(form, options = {}) {
  const response = await worker.fetch(enquiryRequest(form, options), options.env ?? env);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function sendJson(body, workerEnv = env) {
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, workerEnv);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

// ---------------------------------------------------------------------------
// Durable intake — happy paths
// ---------------------------------------------------------------------------

for (const count of [1, 2, 3]) {
  await test(`${count} reference image(s) are accepted and stored`, async () => {
    const calls = stubBackend();
    const files = Array.from({ length: count }, (_, i) => imageFile(JPEG, 'image/jpeg', `reference-${i + 1}.jpg`));
    const { response, payload } = await send(enquiryForm({ files }));

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.reference, 'ENQ-2026-0001');
    assert.equal(calls.uploads.length, count, 'one upload per file');
    assert.equal(calls.rpc.filter((c) => c.name === 'mark_enquiry_file_uploaded').length, count);
    assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 1);
    assert.equal(calls.telegram, 1, 'the notification is sent after persistence');
  });
}

await test('PNG and WebP references are accepted', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({
    files: [imageFile(PNG, 'image/png', 'a.png'), imageFile(WEBP, 'image/webp', 'b.webp')],
  }));
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

await test('attribution and idempotency reach the database', async () => {
  const calls = stubBackend();
  await send(enquiryForm());
  const intake = calls.rpc.find((c) => c.name === 'create_enquiry_intake');
  assert.equal(intake.args.p_idempotency_key, '11111111-2222-4333-8444-555555555555');
  assert.equal(intake.args.p_enquiry.utm_source, 'google');
  assert.equal(intake.args.p_enquiry.utm_medium, 'organic');
  assert.equal(intake.args.p_enquiry.referrer, 'https://www.google.com/');
  assert.equal(intake.args.p_enquiry.landing_page, 'https://vishartattoo.com/booking/?utm_source=google');
});

await test('the storage path is server-derived, never client-supplied', async () => {
  const calls = stubBackend();
  await send(enquiryForm());
  const uploaded = calls.uploads[0];
  assert.match(uploaded, /\/storage\/v1\/object\/crm-files\/clients\/[0-9a-f-]+\/enquiries\/[0-9a-f-]+\/references\/[0-9a-f-]+\.jpg$/);
  assert.ok(!uploaded.includes('reference-1.jpg'), 'the original filename is not in the path');
});

await test('a checksum is computed for every file', async () => {
  const calls = stubBackend();
  await send(enquiryForm());
  const intake = calls.rpc.find((c) => c.name === 'create_enquiry_intake');
  assert.match(intake.args.p_files[0].checksum, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// Durable intake — replay
// ---------------------------------------------------------------------------

await test('a replay of a completed enquiry returns the original reference and re-uploads nothing', async () => {
  const calls = stubBackend({ state: { replayed: true, intakeState: 'complete' } });
  const { response, payload } = await send(enquiryForm());

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.reference, 'ENQ-2026-0001');
  assert.equal(payload.replayed, true);
  assert.equal(calls.uploads.length, 0, 'nothing is re-uploaded');
  assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 0);
});

await test('a replay of an unfinished enquiry resumes the upload', async () => {
  const calls = stubBackend({ state: { replayed: true, intakeState: 'files_pending' } });
  const { response, payload } = await send(enquiryForm());

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.uploads.length, 1, 'the pending file is uploaded');
  assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 1);
});

// ---------------------------------------------------------------------------
// Durable intake — rejections
// ---------------------------------------------------------------------------

await test('a missing Origin is rejected before anything is called', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm(), { origin: null });
  assert.equal(response.status, 403);
  assert.equal(payload.code, 'origin_not_allowed');
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.uploads.length, 0);
});

await test('a disallowed Origin is rejected, not merely un-readable', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm(), { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.equal(payload.code, 'origin_not_allowed');
  assert.equal(calls.rpc.length, 0);
});

await test('an approved preview origin is accepted', async () => {
  stubBackend();
  const { response } = await send(enquiryForm(), { origin: 'https://abc123.vishar-site.pages.dev' });
  assert.equal(response.status, 200);
});

await test('an over-large declared body is rejected before parsing', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm(), {
    headers: { 'Content-Length': String(20 * 1024 * 1024) },
  });
  assert.equal(response.status, 413);
  assert.equal(payload.code, 'request_too_large');
  assert.equal(calls.rpc.length, 0);
});

await test('malformed multipart is rejected', async () => {
  stubBackend();
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'multipart/form-data; boundary=----nope' },
    body: 'this is not a valid multipart body',
  });
  const response = await worker.fetch(request, env);
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'malformed_multipart');
});

await test('a missing idempotency key is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { idempotencyKey: 'not-a-uuid' } }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_idempotency_key');
  assert.equal(calls.rpc.length, 0);
});

await test('a missing required field is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { placement: '' } }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'missing_required_field');
  assert.equal(calls.rpc.length, 0);
});

await test('an invalid email is rejected', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { email: 'not-an-email' } }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_email');
});

await test('WhatsApp selected without a number is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { preferredReply: 'WhatsApp', phone: '' } }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'missing_whatsapp_number');
  assert.equal(calls.telegram, 0);
});

await test('Instagram selected without a username is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { preferredReply: 'Instagram', instagram: '' } }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'missing_instagram_username');
  assert.equal(calls.telegram, 0);
});

await test('four reference images are rejected', async () => {
  const calls = stubBackend();
  const files = Array.from({ length: 4 }, (_, i) => imageFile(JPEG, 'image/jpeg', `r${i}.jpg`));
  const { response, payload } = await send(enquiryForm({ files }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_file_count');
  assert.equal(calls.rpc.length, 0);
});

await test('zero reference images are rejected', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({ files: [] }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_file_count');
});

await test('an oversized file is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ files: [oversizedJpeg()] }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'file_too_large');
  assert.equal(calls.uploads.length, 0);
});

await test('a disallowed declared MIME type is rejected', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({
    files: [imageFile(JPEG, 'image/gif', 'sneaky.gif')],
  }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_file_type');
});

await test('a false MIME type that disagrees with the bytes is rejected', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({
    files: [imageFile(PNG, 'image/jpeg', 'actually-a-png.jpg')],
  }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'file_content_mismatch');
  assert.equal(calls.uploads.length, 0);
});

await test('content that is not an image at all is rejected', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({
    files: [imageFile(NOT_AN_IMAGE, 'image/jpeg', 'payload.jpg')],
  }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'unrecognised_file_content');
});

await test('a disallowed file extension is rejected', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm({
    files: [imageFile(JPEG, 'image/jpeg', 'reference.exe')],
  }));
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_file_extension');
});

await test('the honeypot answers as success and stores nothing', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm({ fields: { website: 'https://spam.example' } }));
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.telegram, 0);
});

// ---------------------------------------------------------------------------
// Durable intake — failure handling
// ---------------------------------------------------------------------------

await test('a Supabase RPC failure returns a retryable error and stores nothing', async () => {
  const calls = stubBackend({
    rpc: { create_enquiry_intake: async () => new Response('{}', { status: 500 }) },
  });
  const { response, payload } = await send(enquiryForm());
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'database_unavailable');
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.telegram, 0, 'nothing is announced that was not saved');
});

await test('a rejected enquiry (4xx from the database) is not reported as retryable', async () => {
  stubBackend({
    rpc: { create_enquiry_intake: async () => new Response('{}', { status: 400 }) },
  });
  const { response, payload } = await send(enquiryForm());
  assert.equal(response.status, 400);
  assert.equal(payload.code, 'enquiry_rejected');
});

await test('a total Storage failure cleans up and records a safe failure code', async () => {
  const calls = stubBackend({ uploadFailsAt: 1 });
  const { response, payload } = await send(enquiryForm());

  assert.equal(response.status, 503);
  assert.equal(payload.code, 'storage_upload_failed');
  const failure = calls.rpc.find((c) => c.name === 'fail_enquiry_intake');
  assert.ok(failure, 'the intake is marked failed');
  assert.equal(failure.args.p_error_code, 'storage_upload_failed');
  assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 0);
  assert.equal(calls.telegram, 0);
});

await test('a partial Storage failure deletes what this attempt uploaded', async () => {
  const calls = stubBackend({ uploadFailsAt: 2 });
  const files = [
    imageFile(JPEG, 'image/jpeg', 'a.jpg'),
    imageFile(JPEG, 'image/jpeg', 'b.jpg'),
    imageFile(JPEG, 'image/jpeg', 'c.jpg'),
  ];
  const { response, payload } = await send(enquiryForm({ files }));

  assert.equal(response.status, 503);
  assert.equal(payload.code, 'storage_upload_failed');
  assert.equal(calls.deletes.length, 1, 'the one successful upload is compensated');
  assert.ok(calls.deletes[0].includes('/crm-files/'), 'the deletion targets the private bucket');
  assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 0);
});

await test('the enquiry survives a Storage failure so the same key can resume it', async () => {
  const calls = stubBackend({ uploadFailsAt: 1 });
  await send(enquiryForm());
  const intake = calls.rpc.find((c) => c.name === 'create_enquiry_intake');
  assert.ok(intake, 'the enquiry was still created');
  assert.equal(intake.args.p_idempotency_key, '11111111-2222-4333-8444-555555555555');
});

await test('a Telegram failure after a durable save still reports success', async () => {
  const calls = stubBackend({ telegramStatus: 502 });
  const { response, payload } = await send(enquiryForm());
  assert.equal(response.status, 200, 'the enquiry is saved, so the submission succeeded');
  assert.equal(payload.ok, true);
  assert.equal(payload.reference, 'ENQ-2026-0001');
  assert.equal(calls.rpc.filter((c) => c.name === 'finalize_enquiry_intake').length, 1);
});

await test('an unreachable Telegram still reports success', async () => {
  stubBackend({ telegramThrows: true });
  const { response, payload } = await send(enquiryForm());
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

await test('an unconfigured Telegram does not block a booking', async () => {
  stubBackend();
  const { response, payload } = await send(enquiryForm(), {
    env: { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

await test('a client identifier conflict is still a successful booking', async () => {
  const calls = stubBackend({ state: { clientConflict: true } });
  const { response, payload } = await send(enquiryForm());
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.telegram, 1, 'the notification flags the conflict for review');
});

await test('a missing Supabase configuration refuses the route instead of degrading', async () => {
  const calls = stubBackend();
  const { response, payload } = await send(enquiryForm(), {
    env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' },
  });
  assert.equal(response.status, 500);
  assert.equal(payload.code, 'supabase_not_configured');
  assert.equal(calls.telegram, 0, 'it must not silently fall back to Telegram-only');
});

// ---------------------------------------------------------------------------
// No secret leakage
// ---------------------------------------------------------------------------

await test('no response body contains a secret', async () => {
  const cases = [
    async () => send(enquiryForm()),
    async () => send(enquiryForm({ fields: { email: 'bad' } })),
    async () => send(enquiryForm(), { origin: 'https://evil.example' }),
  ];

  for (const run of cases) {
    stubBackend({ uploadFailsAt: 1 });
    const { payload } = await run();
    const text = JSON.stringify(payload);
    for (const secret of ['test-service-role-key', 'test-token', 'test-chat']) {
      assert.ok(!text.includes(secret), `response leaked ${secret}`);
    }
  }
});

await test('no log line contains a secret or personal data', async () => {
  stubBackend({ uploadFailsAt: 1 });
  await send(enquiryForm({ fields: { email: 'private.person@example.test' } }));
  stubBackend();
  await send(enquiryForm());

  const lines = capturedLines();
  assert.ok(lines.length > 0, 'the intake produced structured logs');
  const forbidden = [
    'test-service-role-key', 'test-token', 'test-chat',
    'private.person@example.test', 'Test Client', 'realistic raven',
    'reference-1.jpg', 'www.google.com',
  ];
  for (const line of lines) {
    for (const value of forbidden) {
      assert.ok(!line.includes(value), `log line leaked "${value}": ${line}`);
    }
  }
});

await test('the service-role key is only ever sent to Supabase', async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const serialised = JSON.stringify(headers) + String(init.body ?? '');
    seen.push({ url: String(url), leaks: serialised.includes('test-service-role-key') });
    if (String(url).includes('/rest/v1/rpc/create_enquiry_intake')) {
      return Response.json({
        enquiry_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        client_id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        reference_number: 'ENQ-2026-0001',
        intake_state: 'files_pending',
        replayed: false,
        files: [{
          file_id: 'f1111111-1111-4111-8111-111111111111',
          storage_path: 'clients/cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee/enquiries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/references/f1111111-1111-4111-8111-111111111111.jpg',
          upload_state: 'pending',
        }],
      });
    }
    return new Response('{}', { status: 200 });
  };

  await send(enquiryForm());
  for (const call of seen) {
    if (call.leaks) {
      assert.ok(call.url.startsWith('https://project.supabase.co'), `service key sent to ${call.url}`);
    }
  }
  assert.ok(seen.some((c) => c.url.includes('api.telegram.org')), 'Telegram was called');
  assert.ok(seen.filter((c) => c.url.includes('api.telegram.org')).every((c) => !c.leaks));
});

// ---------------------------------------------------------------------------
// Preserved routes
// ---------------------------------------------------------------------------

await test('the legacy JSON tattoo-enquiry shape gets an explicit 415', async () => {
  stubBackend();
  const { response, payload } = await sendJson({ type: 'tattoo-enquiry', name: 'X', images: [] });
  assert.equal(response.status, 415);
  assert.equal(payload.code, 'multipart_required');
  assert.match(payload.error, /refresh/i);
});

await test('lead keeps its contract', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response('{}', { status: 200 });
  };
  const { response, payload } = await sendJson({
    type: 'lead', name: 'Lead Person', contact: 'lead@example.test',
    preferredReply: 'Email', page: '/', originalIdea: 'A wolf', aiSummary: 'Wildlife realism',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.ok(sent.url.endsWith('/sendMessage'));
  assert.match(sent.body.text, /New tattoo idea from website/);
  assert.match(sent.body.text, /Contact: lead@example\.test/);
});

await test('lead without contact is still rejected the same way', async () => {
  globalThis.fetch = async () => { throw new Error('Telegram must not be called'); };
  const { response, payload } = await sendJson({ type: 'lead' });
  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Contact is required.');
});

await test('sendIdea keeps its contract', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const { response, payload } = await sendJson({ type: 'sendIdea', contact: 'idea@example.test' });
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
});

await test('a Telegram failure on lead still surfaces the same 502 contract', async () => {
  globalThis.fetch = async () => Response.json({ ok: false, error_code: 400, description: 'chat not found' }, { status: 400 });
  const { response, payload } = await sendJson({ type: 'lead', contact: 'x@example.test' });
  assert.equal(response.status, 502);
  assert.equal(payload.ok, false);
  assert.equal(payload.telegramStatus, 400);
  assert.equal(payload.telegramError, 'chat not found');
});

await test('book-waitlist keeps its contract', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };
  const { response, payload } = await sendJson({
    type: 'book-waitlist', name: 'Reader', email: 'reader@example.test',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.match(sent.text, /Book waitlist/);
  assert.match(sent.text, /Email: reader@example\.test/);
});

await test('book-waitlist still rejects an invalid email', async () => {
  globalThis.fetch = async () => { throw new Error('Telegram must not be called'); };
  const { response, payload } = await sendJson({ type: 'book-waitlist', email: 'nope' });
  assert.equal(response.status, 400);
  assert.equal(payload.error, 'A valid email is required.');
});

await test('the AI route is unchanged', async () => {
  const seen = [];
  const aiEnv = {
    ...env,
    AI: {
      run: async (model, options) => {
        seen.push({ model, options });
        return { response: 'Concept: a raven.' };
      },
    },
  };
  globalThis.fetch = async () => { throw new Error('the AI route must not call fetch'); };

  const { response, payload } = await sendJson({ type: 'idea', message: 'A wolf' }, aiEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { response: 'Concept: a raven.' });
  assert.equal(seen[0].model, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(seen[0].options.messages[0].role, 'system');
  assert.match(seen[0].options.messages[0].content, /AI Concept Consultant for Vladimir Vishar/);
  assert.equal(seen[0].options.messages[1].content, 'A wolf');
});

await test('the aftercare prompt is still selected by type', async () => {
  let systemPrompt = '';
  const aiEnv = { ...env, AI: { run: async (_m, o) => { systemPrompt = o.messages[0].content; return { response: 'ok' }; } } };
  await sendJson({ type: 'aftercare', message: 'Is redness normal?' }, aiEnv);
  assert.match(systemPrompt, /aftercare assistant/);
});

await test('OPTIONS and non-POST behaviour is unchanged', async () => {
  const preflight = await worker.fetch(
    new Request(ENDPOINT, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const get = await worker.fetch(new Request(ENDPOINT, { method: 'GET' }), env);
  assert.equal(get.status, 405);
});

await test('malformed JSON is still rejected', async () => {
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: '{not json',
  });
  const response = await worker.fetch(request, env);
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error, 'A valid JSON request is required.');
});

// ---------------------------------------------------------------------------

if (failures > 0) {
  realConsole.error(`\n${failures} booking flow test(s) failed, ${passes} passed.`);
  process.exit(1);
}

realConsole.log(`Booking flow tests passed: ${passes} cases covering durable intake, failure handling, secret containment and the unchanged AI, lead, sendIdea and book-waitlist routes.`);
