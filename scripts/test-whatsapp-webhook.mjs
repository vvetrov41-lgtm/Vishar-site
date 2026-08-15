// Meta WhatsApp webhook tests.
//
// Everything is synthetic: the app secrets, phone number ids and wamids below
// are obviously-fake strings, and Supabase is mocked at the transport
// boundary. No network request is made and no Meta account is contacted.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { bindingNameFor } from '../workers/lib/provider-routing.js';
import { planOperations, readWhatsappBindings, __testing } from '../workers/lib/whatsapp-webhook.js';
import worker, { handleWhatsappWebhook } from '../workers/whatsapp-webhook-worker.js';

let passes = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passes += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

const VLADIMIR_KEY = 'vladimir-production';
const KRISTINA_KEY = 'kristina-production';
const VLADIMIR_PHONE_ID = '100000000000001';
const KRISTINA_PHONE_ID = '100000000000002';
const APP_SECRET = 'unit-test-shared-app-secret';
const VERIFY_TOKEN = 'unit-test-verify-token';

const env = {
  WHATSAPP_WEBHOOK_ENABLED: 'true',
  WHATSAPP_INTEGRATION_KEYS: `${VLADIMIR_KEY},${KRISTINA_KEY}`,
  WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-service-role',
  [bindingNameFor('whatsapp', VLADIMIR_KEY)]: JSON.stringify({
    phoneNumberId: VLADIMIR_PHONE_ID,
    accessToken: 'unit-test-vladimir-access-token',
    appSecret: APP_SECRET,
  }),
  [bindingNameFor('whatsapp', KRISTINA_KEY)]: JSON.stringify({
    phoneNumberId: KRISTINA_PHONE_ID,
    accessToken: 'unit-test-kristina-access-token',
    appSecret: APP_SECRET,
  }),
};

function sign(body, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function inboundPayload(phoneNumberId, { waId = '447700900001', id = 'wamid.INBOUND0000001' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Synthetic Client' }, wa_id: waId }],
          messages: [{
            from: waId,
            id,
            timestamp: '1749416383',
            type: 'text',
            text: { body: 'Does it come in another colour?' },
          }],
        },
      }],
    }],
  };
}

function post(body, signature = sign(body)) {
  return new Request('https://whatsapp.example.com/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body,
  });
}

function makeFetch() {
  const rpcCalls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (!value.includes('/rest/v1/rpc/')) throw new Error(`unexpected URL ${value}`);
    const name = value.split('/').pop();
    rpcCalls.push({ name, args: JSON.parse(init.body || '{}') });
    return Response.json({ ok: true });
  };
  return { fetchImpl, rpcCalls };
}

// ---------------------------------------------------------------------------
// Verification handshake
// ---------------------------------------------------------------------------

await test('a valid verification handshake echoes the challenge', async () => {
  const request = new Request(
    'https://whatsapp.example.com/webhooks/whatsapp'
    + `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    { method: 'GET' }
  );
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '1158201444');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
});

await test('an invalid verify token is refused', async () => {
  const request = new Request(
    'https://whatsapp.example.com/webhooks/whatsapp'
    + '?hub.mode=subscribe&hub.verify_token=wrong-token-value&hub.challenge=1158201444',
    { method: 'GET' }
  );
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'verification_invalid');
});

await test('a verification without subscribe mode is refused', async () => {
  const request = new Request(
    'https://whatsapp.example.com/webhooks/whatsapp'
    + `?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    { method: 'GET' }
  );
  assert.equal((await worker.fetch(request, env)).status, 400);
});

// ---------------------------------------------------------------------------
// Authenticity
// ---------------------------------------------------------------------------

await test('a valid signature is accepted and ingested', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const { fetchImpl, rpcCalls } = makeFetch();
  const response = await handleWhatsappWebhook(post(body), env, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'record_whatsapp_inbound_message');
  assert.equal(rpcCalls[0].args.p_integration_key, VLADIMIR_KEY);
});

await test('an invalid signature is rejected before any database call', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const { fetchImpl, rpcCalls } = makeFetch();
  const response = await worker.fetch(post(body, sign(body, 'unit-test-wrong-secret')), env, fetchImpl);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'signature_invalid');
  assert.equal(rpcCalls.length, 0);
});

await test('a missing or malformed signature header is rejected', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  for (const header of ['', 'sha1=abc', 'sha256=not-hex', 'garbage']) {
    const response = await worker.fetch(post(body, header), env);
    assert.equal(response.status, 401, `header ${JSON.stringify(header)}`);
  }
});

await test('a tampered body invalidates the signature', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const signature = sign(body);
  const tampered = JSON.stringify(inboundPayload(KRISTINA_PHONE_ID));
  const response = await worker.fetch(post(tampered, signature), env);
  assert.equal(response.status, 401);
});

// ---------------------------------------------------------------------------
// Artist resolution
// ---------------------------------------------------------------------------

await test('each business phone number resolves to its own artist', async () => {
  for (const [phoneNumberId, expectedKey] of [
    [VLADIMIR_PHONE_ID, VLADIMIR_KEY],
    [KRISTINA_PHONE_ID, KRISTINA_KEY],
  ]) {
    const body = JSON.stringify(inboundPayload(phoneNumberId));
    const { fetchImpl, rpcCalls } = makeFetch();
    await handleWhatsappWebhook(post(body), env, fetchImpl);
    assert.equal(rpcCalls[0].args.p_integration_key, expectedKey);
  }
});

await test('an unknown phone number id is acknowledged but never routed', async () => {
  const body = JSON.stringify(inboundPayload('999999999999999'));
  const { fetchImpl, rpcCalls } = makeFetch();
  const response = await handleWhatsappWebhook(post(body), env, fetchImpl);
  // Acknowledged so Meta stops retrying, but no artist was selected.
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ignored, true);
  assert.equal(rpcCalls.length, 0, 'an unknown number must never reach the database');
});

await test('the webhook body cannot select an artist or integration', async () => {
  const payload = inboundPayload(VLADIMIR_PHONE_ID);
  // A hostile payload naming Kristina's key and artist directly.
  payload.entry[0].changes[0].value.integration_key = KRISTINA_KEY;
  payload.entry[0].changes[0].value.artist_id = 'a2222222-2222-4222-8222-222222222222';
  const body = JSON.stringify(payload);
  const { fetchImpl, rpcCalls } = makeFetch();
  await handleWhatsappWebhook(post(body), env, fetchImpl);
  assert.equal(rpcCalls[0].args.p_integration_key, VLADIMIR_KEY,
    'routing must follow the verified phone number id, not the body');
  assert.ok(!('p_artist_id' in rpcCalls[0].args), 'no artist id crosses the boundary');
});

await test('only a binding whose secret signed the delivery may be routed to', async () => {
  // Kristina is onboarded through a different Meta app with its own secret.
  const splitEnv = {
    ...env,
    [bindingNameFor('whatsapp', KRISTINA_KEY)]: JSON.stringify({
      phoneNumberId: KRISTINA_PHONE_ID,
      accessToken: 'unit-test-kristina-access-token',
      appSecret: 'unit-test-kristina-app-secret',
    }),
  };
  // A delivery for Kristina's number signed with Vladimir's secret must not be
  // accepted just because some configured secret verified it.
  const body = JSON.stringify(inboundPayload(KRISTINA_PHONE_ID));
  const { fetchImpl, rpcCalls } = makeFetch();
  const response = await handleWhatsappWebhook(post(body, sign(body, APP_SECRET)), splitEnv, fetchImpl);
  assert.equal(response.status, 202);
  assert.equal(rpcCalls.length, 0, 'a mismatched signing binding must not route');
});

// ---------------------------------------------------------------------------
// Coexistence
// ---------------------------------------------------------------------------

await test('a Business App echo is ingested and attributed separately', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102290129340398',
      changes: [{
        field: 'smb_message_echoes',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550783881', phone_number_id: VLADIMIR_PHONE_ID },
          message_echoes: [{
            from: '15550783881',
            to: '447700900001',
            id: 'wamid.ECHO000000001',
            timestamp: '1749416400',
            type: 'text',
            text: { body: 'Replying from my phone' },
          }],
        },
      }],
    }],
  };
  const body = JSON.stringify(payload);
  const { fetchImpl, rpcCalls } = makeFetch();
  await handleWhatsappWebhook(post(body), env, fetchImpl);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'record_whatsapp_echo_message');
  assert.equal(rpcCalls[0].args.p_integration_key, VLADIMIR_KEY);
  assert.equal(rpcCalls[0].args.p_contact_wa_id, '447700900001');
  assert.equal(rpcCalls[0].args.p_provider_message_id, 'wamid.ECHO000000001');
});

await test('echo revocations and edits are acknowledged but not applied', async () => {
  for (const type of ['revoke', 'edit']) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'smb_message_echoes',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: VLADIMIR_PHONE_ID },
            message_echoes: [{
              from: '15550783881', to: '447700900001',
              id: 'wamid.ECHO000000002', timestamp: '1749416400', type,
            }],
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    const { fetchImpl, rpcCalls } = makeFetch();
    const response = await handleWhatsappWebhook(post(body), env, fetchImpl);
    assert.equal(response.status, 202, type);
    assert.equal(rpcCalls.length, 0, type);
  }
});

await test('history and app state sync are acknowledged without ingestion', async () => {
  for (const field of ['history', 'smb_app_state_sync']) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: VLADIMIR_PHONE_ID },
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    const { fetchImpl, rpcCalls } = makeFetch();
    const response = await handleWhatsappWebhook(post(body), env, fetchImpl);
    assert.equal(response.status, 202, field);
    assert.equal(rpcCalls.length, 0, field);
  }
});

// ---------------------------------------------------------------------------
// Delivery statuses
// ---------------------------------------------------------------------------

await test('status callbacks are forwarded with a safe error code', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: VLADIMIR_PHONE_ID },
          statuses: [
            { id: 'wamid.SENT0000000001', status: 'delivered', timestamp: '1750263773', recipient_id: '447700900001' },
            {
              id: 'wamid.SENT0000000002',
              status: 'failed',
              timestamp: '1750263799',
              recipient_id: '447700900001',
              errors: [{ code: 131047, title: 'Re-engagement message', message: 'a message body' }],
            },
            { id: 'wamid.SENT0000000003', status: 'invented', timestamp: '1750263800' },
          ],
        },
      }],
    }],
  };
  const body = JSON.stringify(payload);
  const { fetchImpl, rpcCalls } = makeFetch();
  await handleWhatsappWebhook(post(body), env, fetchImpl);
  assert.equal(rpcCalls.length, 2, 'an unknown status value is dropped');
  assert.equal(rpcCalls[0].args.p_status, 'delivered');
  assert.equal(rpcCalls[0].args.p_error_code, null);
  assert.equal(rpcCalls[1].args.p_status, 'failed');
  assert.match(rpcCalls[1].args.p_error_code, /^[a-z][a-z0-9_]{2,63}$/);
  // Meta's error object is not fully documented, so none of it is stored.
  const serialised = JSON.stringify(rpcCalls);
  assert.ok(!serialised.includes('Re-engagement'), 'no provider error text is forwarded');
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

await test('the Worker is inert unless explicitly enabled', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    const response = await worker.fetch(post(body), { ...env, WHATSAPP_WEBHOOK_ENABLED: value });
    assert.equal(response.status, 503, `enabled=${String(value)}`);
    assert.equal((await response.json()).code, 'whatsapp_webhook_disabled');
  }
});

await test('only one path and two methods exist', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  for (const path of ['/', '/webhooks', '/webhooks/whatsapp/extra', '/webhooks/telegram']) {
    const request = new Request(`https://whatsapp.example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
      body,
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 404, path);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const request = new Request('https://whatsapp.example.com/webhooks/whatsapp', { method });
    assert.equal((await worker.fetch(request, env)).status, 405, method);
  }
});

await test('there is no browser CORS surface', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const response = await worker.fetch(post(body), env, makeFetch().fetchImpl);
  for (const header of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods']) {
    assert.equal(response.headers.get(header), null, header);
  }
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

await test('a non-JSON or oversized body is refused', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const form = new Request('https://whatsapp.example.com/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  assert.equal((await worker.fetch(form, env)).status, 415);

  const huge = 'x'.repeat(300 * 1024);
  const oversized = new Request('https://whatsapp.example.com/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(300 * 1024),
      'X-Hub-Signature-256': sign(huge),
    },
    body: huge,
  });
  assert.equal((await worker.fetch(oversized, env)).status, 413);
});

await test('malformed JSON that is correctly signed still fails closed', async () => {
  const body = '{"object":';
  const response = await worker.fetch(post(body), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'json_invalid');
});

await test('a Worker without configured bindings fails closed', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const bare = {
    WHATSAPP_WEBHOOK_ENABLED: 'true',
    WHATSAPP_INTEGRATION_KEYS: '',
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
  };
  const response = await worker.fetch(post(body), bare);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'whatsapp_not_configured');
});

await test('no response body ever carries a secret or contact data', async () => {
  const body = JSON.stringify(inboundPayload(VLADIMIR_PHONE_ID));
  const response = await handleWhatsappWebhook(post(body), env, makeFetch().fetchImpl);
  const text = await response.text();
  for (const secret of [APP_SECRET, VERIFY_TOKEN, VLADIMIR_PHONE_ID, '447700900001', 'another colour']) {
    assert.ok(!text.includes(secret), `response leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

await test('binding discovery ignores incomplete envelopes', () => {
  const partial = {
    WHATSAPP_INTEGRATION_KEYS: `${VLADIMIR_KEY},${KRISTINA_KEY}`,
    [bindingNameFor('whatsapp', VLADIMIR_KEY)]: JSON.stringify({
      phoneNumberId: VLADIMIR_PHONE_ID, appSecret: APP_SECRET,
    }),
    // Kristina's envelope has no app secret and must be skipped.
    [bindingNameFor('whatsapp', KRISTINA_KEY)]: JSON.stringify({
      phoneNumberId: KRISTINA_PHONE_ID,
    }),
  };
  const bindings = readWhatsappBindings(partial);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].integrationKey, VLADIMIR_KEY);
});

await test('control characters are stripped from ingested text', () => {
  assert.equal(__testing.safeText('line onetwo'), 'lineonetwo');
  assert.equal(__testing.safeText(42), '');
  assert.equal(__testing.safeText('x'.repeat(5000)).length, 4096);
});

await test('a payload for the wrong object type plans nothing', () => {
  const bindings = readWhatsappBindings(env);
  assert.deepEqual(planOperations({ object: 'page', entry: [] }, bindings), []);
  assert.deepEqual(planOperations(null, bindings), []);
});

if (failures > 0) {
  console.error(`WhatsApp webhook tests failed: ${failures} of ${passes + failures}`);
  process.exit(1);
}

console.log(
  `WhatsApp webhook tests passed: ${passes} cases covering Meta verification, signature authenticity, `
  + 'server-side artist resolution, coexistence echoes, status callbacks and a fail-closed public surface.'
);
