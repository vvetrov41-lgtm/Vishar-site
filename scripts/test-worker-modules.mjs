#!/usr/bin/env node
//
// Unit tests for the Worker library modules.
//
// These test the pieces in isolation: log redaction, origin rules, request
// limits, file sniffing, storage path shape, outbox dedupe keys and the
// reconciliation planner. The end-to-end route behaviour is covered by
// scripts/test-booking-flow.mjs.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(rootDir, 'workers', rel)).href);

const http = await load('lib/http.js');
const logging = await load('lib/logging.js');
const validation = await load('lib/validation.js');
const storage = await load('lib/storage.js');
const outbox = await load('lib/outbox.js');
const activity = await load('lib/activity.js');
const telegram = await load('lib/telegram.js');
const providerRouting = await load('lib/provider-routing.js');
const supabase = await load('lib/supabase.js');
const reconciliation = await load('lib/reconciliation.js');
const email = await load('lib/email.js');
const calendar = await load('lib/calendar.js');
const aiTools = await load('lib/ai-tools.js');

let failures = 0;
let passes = 0;

function test(name, fn) {
  try {
    fn();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

test('the logger keeps only allow-listed fields', () => {
  const out = logging.redact({
    enquiryId: 'abc',
    email: 'client@example.test',
    idea: 'a raven',
    name: 'Ada',
    signedUrl: 'https://example.test/signed',
  });
  assert.deepEqual(Object.keys(out).sort(), ['droppedFields', 'enquiryId']);
  assert.equal(out.droppedFields, 4);
});

test('the logger bounds a safe field value', () => {
  const out = logging.redact({ referenceNumber: 'x'.repeat(1000) });
  assert.equal(out.referenceNumber.length, logging.__testing.MAX_VALUE_LENGTH);
});

test('no PII field name is on the log allow-list', () => {
  for (const forbidden of ['email', 'phone', 'name', 'idea', 'instagram', 'filename', 'signedUrl', 'token']) {
    assert.ok(!logging.__testing.SAFE_FIELDS.has(forbidden), `${forbidden} must not be loggable`);
  }
});

test('status is reduced to its class', () => {
  assert.equal(logging.statusClass(503), '5xx');
  assert.equal(logging.statusClass(404), '4xx');
  assert.equal(logging.statusClass(undefined), 'unknown');
});

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

test('the production origins are allowed and everything else is not', () => {
  assert.ok(http.isAllowedOrigin('https://vishartattoo.com'));
  assert.ok(http.isAllowedOrigin('https://www.vishartattoo.com'));
  assert.ok(!http.isAllowedOrigin('https://preview.vishar-site.pages.dev'));
  assert.ok(!http.isAllowedOrigin('http://vishartattoo.com'), 'plain http is not allowed');
  assert.ok(!http.isAllowedOrigin('https://vishartattoo.com.evil.example'));
  assert.ok(!http.isAllowedOrigin('https://evil.example'));
  assert.ok(!http.isAllowedOrigin(''));
  assert.ok(!http.isAllowedOrigin(null));
});

test('an environment allow-list replaces defaults instead of mixing environments', () => {
  const env = { ALLOWED_ORIGINS: 'https://staging.example, https://other.example' };
  assert.ok(http.isAllowedOriginFor('https://staging.example', env));
  assert.ok(http.isAllowedOriginFor('https://other.example', env));
  assert.ok(!http.isAllowedOriginFor('https://nope.example', env));
  assert.ok(!http.isAllowedOriginFor('https://vishartattoo.com', env));
  assert.ok(!http.isAllowedOriginFor('https://staging.example', {}));
  assert.equal(
    http.getCorsHeaders('https://staging.example', env)['Access-Control-Allow-Origin'],
    'https://staging.example'
  );
});

test('invalid configured origins fail closed and loopback must be explicit', () => {
  const invalid = {
    ALLOWED_ORIGINS: [
      'http://staging.example',
      'https://staging.example/path',
      'https://user:pass@staging.example',
      'not-a-url',
    ].join(','),
  };
  assert.deepEqual(http.allowedOriginsFromEnv(invalid), []);
  assert.ok(!http.isAllowedOriginFor('https://vishartattoo.com', invalid));

  const local = { ALLOWED_ORIGINS: 'http://127.0.0.1:8788' };
  assert.ok(http.isAllowedOriginFor('http://127.0.0.1:8788', local));
  assert.ok(
    !http.isAllowedOriginFor('https://vishartattoo.com', { VISHAR_ENVIRONMENT: 'preview' }),
    'a preview Worker with a missing allow-list fails closed'
  );
});

test('an over-large declared body is refused', () => {
  const big = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'Content-Length': String(http.MAX_REQUEST_BYTES + 1) },
  });
  assert.throws(() => http.assertRequestSize(big), (error) => error.code === 'request_too_large');

  const fine = new Request('https://x.test/', { method: 'POST', headers: { 'Content-Length': '1024' } });
  assert.doesNotThrow(() => http.assertRequestSize(fine));
});

test('multipart detection tolerates casing and parameters', () => {
  const make = (value) => new Request('https://x.test/', { method: 'POST', headers: { 'Content-Type': value } });
  assert.ok(http.isMultipartRequest(make('multipart/form-data; boundary=abc')));
  assert.ok(http.isMultipartRequest(make('Multipart/Form-Data; boundary=abc')));
  assert.ok(!http.isMultipartRequest(make('application/json')));
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('magic bytes identify each accepted format', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(validation.sniffImageType(jpeg), 'image/jpeg');
  assert.equal(validation.sniffImageType(png), 'image/png');
  assert.equal(validation.sniffImageType(webp), 'image/webp');
});

test('magic bytes reject non-images and truncated content', () => {
  assert.equal(validation.sniffImageType(new Uint8Array([0x4d, 0x5a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(validation.sniffImageType(new Uint8Array([0xff, 0xd8])), null, 'too short to judge');
  assert.equal(validation.sniffImageType(null), null);
});

test('a RIFF container that is not WebP is rejected', () => {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(validation.sniffImageType(wav), null);
});

test('control characters are stripped and length is capped', () => {
  assert.equal(validation.cleanText('  hello\u0000world  ', 100), 'helloworld');
  assert.equal(validation.cleanText('abcdef', 3), 'abc');
  assert.equal(validation.cleanText(undefined, 10), '');
});

test('the UUID check is strict', () => {
  assert.ok(validation.isUuid('11111111-2222-4333-8444-555555555555'));
  assert.ok(!validation.isUuid('11111111-2222-4333-8444-55555555555'));
  assert.ok(!validation.isUuid('not-a-uuid'));
  assert.ok(!validation.isUuid(''));
});

test('extensions are read from the filename tail only', () => {
  assert.equal(validation.extensionFromFilename('photo.JPG'), 'jpg');
  assert.equal(validation.extensionFromFilename('archive.tar.gz'), 'gz');
  assert.equal(validation.extensionFromFilename('noextension'), '');
  assert.equal(validation.extensionFromFilename('photo.jpg.exe'), 'exe');
});

test('the accepted formats match the bucket and the database', () => {
  assert.deepEqual([...validation.ALLOWED_MIME_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
  assert.deepEqual([...validation.ALLOWED_EXTENSIONS].sort(), ['jpeg', 'jpg', 'png', 'webp']);
  assert.equal(validation.MAX_FILE_BYTES, 4 * 1024 * 1024);
  assert.equal(validation.MIN_FILES, 1);
  assert.equal(validation.MAX_FILES, 3);
  assert.equal(validation.PRIVACY_NOTICE_VERSION, '2026-07-29');
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test('only canonical storage paths are accepted', () => {
  const client = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const enquiry = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const project = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp'.replace(/p/g, 'a');
  const file = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  assert.ok(storage.isCanonicalPath(`clients/${client}/enquiries/${enquiry}/references/${file}.jpg`));
  assert.ok(storage.isCanonicalPath(`clients/${client}/projects/${project}/designs/${file}.png`));
  assert.ok(storage.isCanonicalPath(`clients/${client}/projects/${project}/sessions/${file}.webp`));
  assert.ok(storage.isCanonicalPath(`clients/${client}/projects/${project}/healed/${file}.jpeg`));

  assert.ok(!storage.isCanonicalPath(`clients/${client}/enquiries/${enquiry}/references/${file}.exe`));
  assert.ok(!storage.isCanonicalPath(`clients/${client}/enquiries/${enquiry}/other/${file}.jpg`));
  assert.ok(!storage.isCanonicalPath('clients/../../etc/passwd'));
  assert.ok(!storage.isCanonicalPath('clients/'));
  assert.ok(!storage.isCanonicalPath(''));
  assert.ok(!storage.isCanonicalPath(`https://example.test/clients/${client}/enquiries/${enquiry}/references/${file}.jpg`));
});

test('the bucket name matches the migration', () => {
  assert.equal(storage.BUCKET, 'crm-files');
});

test('signed URLs are short-lived by default', () => {
  assert.ok(storage.DEFAULT_SIGNED_URL_SECONDS <= 300, 'a signed URL must not be long-lived');
});

// ---------------------------------------------------------------------------
// supabase
// ---------------------------------------------------------------------------

test('a missing Supabase configuration is refused rather than defaulted', () => {
  assert.throws(() => supabase.readSupabaseConfig({}), (error) => error.code === 'supabase_not_configured');
  assert.throws(
    () => supabase.readSupabaseConfig({ SUPABASE_URL: 'https://x.supabase.co' }),
    (error) => error.code === 'supabase_not_configured'
  );
});

test('a Supabase secret key is sent as apikey only', () => {
  const config = supabase.readSupabaseConfig({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test-only',
  });
  assert.equal(config.authHeaders.apikey, 'sb_secret_test-only');
  assert.ok(!('Authorization' in config.authHeaders));
  assert.equal(config.keyKind, 'secret');
});

test('a legacy service-role JWT keeps the Bearer header', () => {
  const config = supabase.readSupabaseConfig({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'legacy-jwt',
  });
  assert.equal(config.authHeaders.apikey, 'legacy-jwt');
  assert.equal(config.authHeaders.Authorization, 'Bearer legacy-jwt');
  assert.equal(config.keyKind, 'legacy_service_role');
});

test('the backend key can only be sent to a hosted Supabase project origin', () => {
  for (const badUrl of [
    'http://x.supabase.co',
    'https://supabase.co',
    'https://x.supabase.co.evil.example',
    'https://evil.example',
    'https://user:pass@x.supabase.co',
    'https://x.supabase.co/rest/v1',
    'https://x.supabase.co?redirect=evil',
  ]) {
    assert.throws(
      () => supabase.readSupabaseConfig({
        SUPABASE_URL: badUrl,
        SUPABASE_SECRET_KEY: 'sb_secret_test-only',
      }),
      (error) => error.code === 'invalid_supabase_url',
      badUrl
    );
  }

  assert.equal(
    supabase.readSupabaseConfig({
      SUPABASE_URL: 'https://Project-Ref.supabase.co/',
      SUPABASE_SECRET_KEY: 'sb_secret_test-only',
    }).url,
    'https://project-ref.supabase.co'
  );
});

test('conflicting or misnamed Supabase backend keys fail closed', () => {
  assert.throws(
    () => supabase.readSupabaseConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_one',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy',
    }),
    (error) => error.code === 'supabase_key_conflict'
  );
  assert.throws(
    () => supabase.readSupabaseConfig({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_' + 'secret_misnamed',
    }),
    (error) => error.code === 'supabase_secret_key_misnamed'
  );
});

test('the RPC allow-list is exactly the intake surface', () => {
  assert.deepEqual([...supabase.ALLOWED_RPCS].sort(), [
    'claim_calendar_availability_outbox',
    'claim_calendar_outbox',
    'claim_telegram_outbox',
    'claim_telegram_outbox_by_id',
    'claim_whatsapp_outbox',
    'claim_whatsapp_outbox_by_id',
    'create_trusted_enquiry_intake',
    'fail_enquiry_intake',
    'finalize_enquiry_intake',
    'list_incomplete_intakes',
    'mark_enquiry_file_uploaded',
    'record_calendar_availability_outbox_result',
    'record_calendar_outbox_result',
    'record_outbox_attempt',
    'record_telegram_outbox_result',
    'record_whatsapp_echo_message',
    'record_whatsapp_inbound_message',
    'record_whatsapp_outbox_result',
    'record_whatsapp_status_update',
    'resolve_outbox_route',
  ]);
});

test('a database error carries no provider body', () => {
  const error = new supabase.SupabaseError('database_unavailable', 500);
  assert.ok(!/select|insert|client@/i.test(error.message), 'the message must not echo the query or the row');
  assert.match(error.message, /5xx/);
});

test('a 5xx is retryable and a 4xx is not', () => {
  assert.equal(supabase.toRequestError(new supabase.SupabaseError('x', 503)).status, 503);
  assert.equal(supabase.toRequestError(new supabase.SupabaseError('x', 400)).status, 400);
});

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

test('dedupe keys match the database helpers', () => {
  assert.equal(outbox.telegramDedupeKey('abc'), 'telegram:enquiry_created:abc');
  assert.equal(outbox.calendarDedupeKey('create', 'sess', 0), 'calendar:create:sess:0');
  assert.equal(outbox.calendarDedupeKey('cancel', 'sess', 3), 'calendar:cancel:sess:3');
  assert.equal(outbox.emailDedupeKey('msg'), 'email:approved:msg');
});

test('the same logical calendar job always produces the same key', () => {
  assert.equal(
    outbox.calendarDedupeKey('create', 'sess', 1),
    outbox.calendarDedupeKey('create', 'sess', 1)
  );
  assert.notEqual(
    outbox.calendarDedupeKey('create', 'sess', 1),
    outbox.calendarDedupeKey('create', 'sess', 2)
  );
});

test('backoff grows and is capped', () => {
  assert.equal(outbox.nextAttemptDelaySeconds(0), 30);
  assert.equal(outbox.nextAttemptDelaySeconds(1), 60);
  assert.equal(outbox.nextAttemptDelaySeconds(3), 240);
  assert.equal(outbox.nextAttemptDelaySeconds(99), 3600);
});

test('a job is exhausted at its attempt limit', () => {
  assert.ok(outbox.isExhausted({ attempt_count: 8, max_attempts: 8 }));
  assert.ok(!outbox.isExhausted({ attempt_count: 7, max_attempts: 8 }));
});

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

test('activity metadata drops anything that duplicates personal data', () => {
  const out = activity.safeMetadata({
    reference_number: 'ENQ-2026-0001',
    file_count: 2,
    email: 'client@example.test',
    idea: 'a raven',
    signed_url: 'https://example.test/x',
    token: 'abc',
  });
  assert.deepEqual(out, { reference_number: 'ENQ-2026-0001', file_count: 2 });
});

test('the Worker and the database forbid the same metadata keys', () => {
  for (const key of ['email', 'phone', 'idea', 'signed_url', 'token', 'password']) {
    assert.ok(activity.__testing.FORBIDDEN_METADATA_KEYS.has(key));
  }
});

test('intake metadata excludes visitor-controlled attribution text', () => {
  const out = activity.intakeMetadata({
    referenceNumber: 'ENQ-2026-0001', fileCount: 3, source: '/booking/', utmSource: 'google',
  });
  assert.deepEqual(out, {
    reference_number: 'ENQ-2026-0001', file_count: 3,
  });
});

// ---------------------------------------------------------------------------
// telegram
// ---------------------------------------------------------------------------

test('the notification contains no client details', () => {
  const text = telegram.buildEnquiryNotification({ referenceNumber: 'ENQ-2026-0001', fileCount: 2 });
  assert.match(text, /ENQ-2026-0001/);
  assert.match(text, /Reference images: 2/);
  for (const leak of ['@', 'phone', 'idea']) {
    assert.ok(!text.toLowerCase().includes(leak), `the notification leaked "${leak}"`);
  }
});

test('a client conflict is flagged for review in the notification', () => {
  const text = telegram.buildEnquiryNotification({
    referenceNumber: 'ENQ-2026-0002', fileCount: 1, clientConflict: true,
  });
  assert.match(text, /two different client records/);
});

test('trusted booking configuration fails closed', () => {
  assert.deepEqual(providerRouting.readTrustedBookingConfig({
    BOOKING_SOURCE_KEY:'vladimir-website',BOOKING_FORM_VERSION:'booking-v1',
  }),{sourceKey:'vladimir-website',formVersion:'booking-v1'});
  assert.throws(() => providerRouting.readTrustedBookingConfig({}),
    error => error.code === 'trusted_booking_source_not_configured');
});
test('binding names distinguish hyphens and underscores', () => {
  assert.equal(providerRouting.bindingNameFor('telegram','vladimir-telegram'),
    'ARTIST_TELEGRAM_VLADIMIR_HTELEGRAM');
  assert.notEqual(providerRouting.bindingNameFor('telegram','artist-key'),
    providerRouting.bindingNameFor('telegram','artist_key'));
});
test('email and calendar use the same future routing boundary', () => {
  assert.equal(providerRouting.integrationTypeForOutboxKind('transactional_email'),'email');
  assert.equal(providerRouting.integrationTypeForOutboxKind('approved_email'),'email');
  assert.equal(providerRouting.integrationTypeForOutboxKind('calendar_create'),'calendar');
  assert.equal(providerRouting.integrationTypeForOutboxKind('calendar_update'),'calendar');
  assert.equal(providerRouting.integrationTypeForOutboxKind('calendar_cancel'),'calendar');
  assert.equal(providerRouting.integrationTypeForOutboxKind('reconciliation'),null);
});
test('an artist route never falls back to global Telegram variables', () => {
  assert.throws(() => providerRouting.resolveProviderBinding({
    TELEGRAM_BOT_TOKEN:'legacy',TELEGRAM_CHAT_ID:'legacy',
  },{kind:'telegram_notification',integration_type:'telegram',provider:'telegram',
     integration_key:'vladimir-telegram'}),error => error.code === 'provider_binding_missing');
});
test('a mismatched route type is rejected', () => {
  assert.throws(() => providerRouting.resolveProviderBinding({},{
    kind:'calendar_create',integration_type:'email',provider:'google',
    integration_key:'vladimir-calendar'}),error => error.code === 'provider_route_invalid');
});

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

test('a fresh incomplete intake is left alone', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const plan = reconciliation.planIntakeAction(
    { enquiry_id: 'e1', created_at: '2026-07-29T11:55:00Z' }, now);
  assert.equal(plan.action, reconciliation.ACTIONS.WAIT);
});

test('a settled incomplete intake is marked resumable', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const plan = reconciliation.planIntakeAction(
    { enquiry_id: 'e1', created_at: '2026-07-29T11:00:00Z' }, now);
  assert.equal(plan.action, reconciliation.ACTIONS.RESUME);
});

test('a day-old incomplete intake is abandoned', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const plan = reconciliation.planIntakeAction(
    { enquiry_id: 'e1', created_at: '2026-07-27T12:00:00Z' }, now);
  assert.equal(plan.action, reconciliation.ACTIONS.ABANDON);
});

test('reconciliation plans a whole batch', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const plans = reconciliation.planReconciliation([
    { enquiry_id: 'fresh', created_at: '2026-07-29T11:59:00Z' },
    { enquiry_id: 'settled', created_at: '2026-07-29T10:00:00Z' },
    { enquiry_id: 'old', created_at: '2026-07-20T10:00:00Z' },
  ], now);
  assert.deepEqual(plans.map((p) => p.action), ['wait', 'resume', 'abandon']);
});

// The executor is exercised against a stub client: only abandonment writes.
await (async () => {
  const calls = [];
  const stub = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_incomplete_intakes') {
        return [
          // Fixed timestamps relative to the fixed `now` below, so the
          // outcome does not depend on when the suite happens to run.
          { enquiry_id: 'fresh', created_at: '2026-07-29T11:59:00Z' },
          { enquiry_id: 'settled', created_at: '2026-07-29T10:00:00Z' },
          { enquiry_id: 'old', created_at: '2020-01-01T00:00:00Z' },
        ];
      }
      return {};
    },
  };

  const summary = await reconciliation.reconcileIncompleteIntakes(stub, {
    now: new Date('2026-07-29T12:00:00Z'),
  });

  test('reconciliation only writes for abandoned intakes', () => {
    assert.deepEqual(summary, { waiting: 1, resumable: 1, abandoned: 1 });
    const writes = calls.filter((c) => c.name === 'fail_enquiry_intake');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args.p_enquiry_id, 'old');
    assert.equal(writes[0].args.p_error_code, 'intake_abandoned');
  });

  test('reconciliation never deletes an enquiry', () => {
    assert.ok(!calls.some((c) => /delete|purge|remove/i.test(c.name)));
  });
})();


// ---------------------------------------------------------------------------
// email boundaries
// ---------------------------------------------------------------------------

test('no provider is bound, and the module says so rather than pretending', () => {
  const service = email.createEmailService({ rpc: async () => ({}) });
  assert.equal(service.isConnected(), false);
});

test('only the acknowledgement template may send automatically', () => {
  assert.equal(email.requiresHumanApproval('enquiry_received'), false);
  for (const kind of email.HUMAN_APPROVAL_REQUIRED) {
    assert.ok(email.requiresHumanApproval(kind), `${kind} must require a person`);
  }
});

test('an unknown template requires approval by default', () => {
  assert.ok(email.requiresHumanApproval('something_new'));
});

test('the automatic list contains nothing personalised', () => {
  const automatic = Object.values(email.AUTOMATIC_TEMPLATES);
  assert.deepEqual(automatic, ['enquiry_received']);
  for (const kind of ['estimate', 'quote', 'date_offer', 'decline', 'deposit_request']) {
    assert.ok(!automatic.includes(kind));
  }
});

await (async () => {
  const service = email.createEmailService({ rpc: async () => ({}) });

  let personalisedSent = false;
  try {
    await service.sendTransactional({
      templateKey: 'estimate',
      toEmail: 'x@example.test',
      data: { referenceNumber: 'ENQ-2026-0001' },
    });
    personalisedSent = true;
  } catch { /* expected */ }

  let queuedWithoutProvider = false;
  try {
    await service.queueApproved('id');
    queuedWithoutProvider = true;
  } catch { /* expected */ }

  test('a personalised template cannot be sent automatically', () => {
    assert.equal(personalisedSent, false);
  });

  test('nothing can be queued for delivery without a provider', () => {
    assert.equal(queuedWithoutProvider, false);
  });
})();

await (async () => {
  const sent = [];
  const service = email.createEmailService(
    { rpc: async () => ({}) },
    {
      send: async (message) => {
        sent.push(message);
        return { providerMessageId: 'provider-1' };
      },
      getStatus: async () => ({ status: 'sent' }),
    }
  );

  await service.sendTransactional({
    templateKey: 'enquiry_received',
    toEmail: 'x@example.test',
    data: {
      referenceNumber: 'ENQ-2026-0001',
      subject: 'Attacker-controlled subject',
      body: 'Attacker-controlled body',
    },
  });

  test('automatic email copy comes only from the approved renderer', () => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'We received your tattoo enquiry');
    assert.ok(sent[0].body.includes('ENQ-2026-0001'));
    assert.ok(!sent[0].body.includes('Attacker-controlled'));
    assert.equal(sent[0].templateKey, 'enquiry_received');
    assert.equal(sent[0].templateVersion, 1);
  });

  test('automatic acknowledgement states that a booking is not confirmed', () => {
    assert.match(sent[0].body, /does not confirm a booking or appointment/i);
  });

  test('automatic templates reject missing or malformed structured data', () => {
    assert.throws(
      () => email.renderTransactionalTemplate('enquiry_received', { referenceNumber: '1234' }),
      /valid enquiry reference/
    );
  });
})();

await (async () => {
  const calls = [];
  const service = email.createEmailService({
    rpc: async (name, args) => { calls.push({ name, args }); return {}; },
  });

  await service.createDraft({ toEmail: 'x@example.test', subject: 's', body: 'b', origin: 'ai' });
  await service.approveDraft('msg-1');

  test('drafting goes through create_email_draft and records the AI origin', () => {
    const draft = calls.find((call) => call.name === 'create_email_draft');
    assert.ok(draft);
    assert.equal(draft.args.p_created_by_kind, 'ai');
  });

  test('approval goes through the owner-only RPC and does not send', () => {
    assert.ok(calls.some((call) => call.name === 'approve_email_draft'));
    assert.ok(!calls.some((call) => /send/i.test(call.name)));
  });
})();

// ---------------------------------------------------------------------------
// calendar boundaries
// ---------------------------------------------------------------------------

test('no calendar provider is bound', () => {
  assert.equal(calendar.createCalendarService().isConnected(), false);
});

test('only a confirmed session is calendar eligible', () => {
  for (const status of ['draft', 'proposed', 'completed', 'cancelled', 'no_show']) {
    assert.ok(!calendar.isEligible({ status }), `${status} must not be eligible`);
  }
  assert.ok(calendar.isEligible({ status: 'confirmed' }));
});

test('a draft or proposed session plans no calendar action', () => {
  assert.equal(calendar.planCalendarAction({ id: 's', status: 'draft' }).action, 'none');
  assert.equal(calendar.planCalendarAction({ id: 's', status: 'proposed' }).action, 'none');
});

test('a confirmed session with no event plans a create', () => {
  const plan = calendar.planCalendarAction({ id: 's1', status: 'confirmed', calendar_version: 0 });
  assert.equal(plan.action, 'create');
  assert.equal(plan.dedupeKey, 'calendar:create:s1:0');
});

test('a confirmed session with an event plans an update', () => {
  const plan = calendar.planCalendarAction({
    id: 's1', status: 'confirmed', calendar_event_id: 'evt', calendar_version: 2,
  });
  assert.equal(plan.action, 'update');
  assert.equal(plan.dedupeKey, 'calendar:update:s1:2');
});

test('a cancelled session that reached the provider plans a cancel', () => {
  const plan = calendar.planCalendarAction({
    id: 's1', status: 'cancelled', calendar_event_id: 'evt', calendar_version: 3,
  });
  assert.equal(plan.action, 'cancel');
  assert.equal(plan.dedupeKey, 'calendar:cancel:s1:3');
});

test('a cancelled session that never reached the provider plans nothing', () => {
  assert.equal(calendar.planCalendarAction({ id: 's1', status: 'cancelled' }).action, 'none');
});

test('completed and no-show sessions keep their historical calendar event', () => {
  for (const status of ['completed', 'no_show']) {
    assert.equal(
      calendar.planCalendarAction({
        id: 's1',
        status,
        calendar_event_id: 'evt',
        calendar_version: 3,
      }).action,
      'none'
    );
  }
});

test('the dedupe key matches the database helper format', () => {
  assert.equal(
    calendar.dedupeKeyFor('create', { id: 'abc', calendar_version: 1 }),
    outbox.calendarDedupeKey('create', 'abc', 1)
  );
});

await (async () => {
  const service = calendar.createCalendarService();
  let createdDraft = false;
  let cancelledConfirmed = false;
  try {
    await service.createConfirmedEvent({ id: 's', status: 'draft' }, {});
    createdDraft = true;
  } catch { /* expected */ }
  try {
    await service.cancelConfirmedEvent({
      id: 's', status: 'confirmed', calendar_event_id: 'event-1',
    });
    cancelledConfirmed = true;
  } catch { /* expected */ }

  test('a draft session cannot be pushed to a calendar even with a provider absent', () => {
    assert.equal(createdDraft, false);
  });

  test('a confirmed database session cannot have its calendar event cancelled', () => {
    assert.equal(cancelledConfirmed, false);
  });
})();

// ---------------------------------------------------------------------------
// AI tool boundaries
// ---------------------------------------------------------------------------

test('exactly the ten named tools exist', () => {
  assert.deepEqual(aiTools.AI_TOOL_NAMES.slice().sort(), [
    'assign_enquiry',
    'create_email_draft',
    'create_follow_up',
    'create_internal_note',
    'get_client',
    'get_enquiry',
    'list_follow_ups',
    'search_clients',
    'search_enquiries',
    'update_enquiry_status',
  ]);
});

test('there is no arbitrary SQL or generic table tool', () => {
  for (const name of aiTools.AI_TOOL_NAMES) {
    assert.ok(!/sql|query|exec|select|table|raw/i.test(name), `${name} looks like an escape hatch`);
  }
  assert.equal(aiTools.getTool('run_sql'), null);
  assert.equal(aiTools.getTool('select'), null);
});

test('every write tool goes through a named RPC', () => {
  for (const tool of aiTools.AI_TOOLS) {
    if (tool.kind !== 'write') continue;
    assert.ok(tool.rpc, `${tool.name} must name the RPC it calls`);
  }
});

test('read_only is offered no tool at all', () => {
  for (const name of aiTools.AI_TOOL_NAMES) {
    assert.ok(!aiTools.isToolAllowed(name, 'read_only'), `${name} must not be offered to read_only`);
  }
});

test('a caller with no role is offered nothing', () => {
  for (const name of aiTools.AI_TOOL_NAMES) {
    assert.ok(!aiTools.isToolAllowed(name, null));
  }
  assert.ok(!aiTools.isToolAllowed('does_not_exist', 'owner'));
});

test('there is no send-email tool, and drafting is marked draft-only', () => {
  assert.ok(!aiTools.AI_TOOL_NAMES.some((name) => /send/i.test(name)));
  assert.equal(aiTools.getTool('create_email_draft').draftOnly, true);
  assert.equal(aiTools.getTool('create_email_draft').rpc, 'create_email_draft');
});

test('client search returns no contact details', () => {
  const returns = aiTools.getTool('search_clients').returns;
  for (const field of ['email', 'phone', 'instagram', 'email_normalized', 'phone_normalized']) {
    assert.ok(!returns.includes(field), `search_clients must not return ${field}`);
  }
});

test('field projection drops anything a tool did not declare', () => {
  const projected = aiTools.projectFields('search_clients', {
    id: 'c1',
    full_name: 'Ada',
    travelling_from: 'Manchester',
    created_at: '2026-07-01T00:00:00Z',
    email: 'ada@example.test',
    phone: '+447700900000',
    notes_summary: 'private',
  });
  assert.deepEqual(Object.keys(projected).sort(), ['created_at', 'full_name', 'id', 'travelling_from']);
});

test('projection applies to every row in a list', () => {
  const rows = aiTools.projectRows('search_clients', [
    { id: 'c1', full_name: 'Ada', email: 'ada@example.test' },
    { id: 'c2', full_name: 'Bea', phone: '+447700900001' },
  ]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(!('email' in row));
    assert.ok(!('phone' in row));
  }
});

test('page size is clamped to the hard cap', () => {
  assert.equal(aiTools.clampLimit(1000), aiTools.MAX_ROWS_PER_CALL);
  assert.equal(aiTools.clampLimit(5), 5);
  assert.equal(aiTools.clampLimit(0), aiTools.DEFAULT_ROWS_PER_CALL);
  assert.equal(aiTools.clampLimit(undefined), aiTools.DEFAULT_ROWS_PER_CALL);
  assert.equal(aiTools.clampLimit(-3), aiTools.DEFAULT_ROWS_PER_CALL);
});

test('every read tool is paginated', () => {
  for (const tool of aiTools.AI_TOOLS) {
    if (tool.kind !== 'read') continue;
    if (tool.name.startsWith('get_')) continue;   // single-record reads
    assert.ok(tool.paginated, `${tool.name} must be paginated`);
  }
});

test('the AI module is a manifest, not a falsely connected gateway', () => {
  assert.equal(aiTools.AI_GATEWAY_CONNECTED, false);
});

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} worker module test(s) failed, ${passes} passed.`);
  process.exit(1);
}

console.log(`Worker module tests passed: ${passes} cases covering log redaction, origin rules, request limits, file sniffing, storage paths, outbox dedupe, reconciliation, and the email, calendar and AI tool boundaries.`);
