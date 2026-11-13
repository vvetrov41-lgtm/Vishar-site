import assert from 'node:assert/strict';
import { readSafeMetaErrorCode, sendWhatsappMessage, __testing } from '../workers/lib/whatsapp.js';
import { bindingNameFor } from '../workers/lib/provider-routing.js';

const privateData = 'private-client-phone-447700000000@example.test';
const errorBody = { error: {
  code: 131026, message: 'Could not deliver to ' + privateData,
  error_data: { details: privateData }, fbtrace_id: privateData,
}};
assert.equal(await readSafeMetaErrorCode(Response.json(errorBody, { status: 400 })), 131026);
assert.equal(await readSafeMetaErrorCode(Response.json({ error: { code: privateData } }, { status: 400 })), null);
assert.equal(await readSafeMetaErrorCode(Response.json({ error: { code: 999999999 } }, { status: 400 })), null);
assert.equal(await readSafeMetaErrorCode(new Response('not-json', {
  status: 400, headers: { 'content-type': 'text/plain' },
})), null);
assert.equal(await readSafeMetaErrorCode(Response.json({
  error: { code: 131026, message: privateData.repeat(100) },
}, { status: 400 })), null, 'oversized Meta error must not be parsed');

assert.equal(__testing.deliveryError(400, 131026).errorCode, 'whatsapp_rejected');
assert.equal(__testing.deliveryError(400, 130429).errorCode, 'whatsapp_rate_limited');
assert.equal(__testing.deliveryError(400, 131056).errorCode, 'whatsapp_rate_limited');
assert.equal(__testing.deliveryError(500, 131026).errorCode, 'whatsapp_provider_unavailable');
assert.equal(__testing.deliveryError(408).errorCode, 'whatsapp_provider_unavailable');
assert.equal(__testing.deliveryError(401).errorCode, 'whatsapp_credentials_rejected');

const key = 'vladimir-production';
const env = {
  [bindingNameFor('whatsapp', key)]: JSON.stringify({
    phoneNumberId: '100000000000001',
    accessToken: 'unit-test-token-never-live',
  }),
};
const route = { kind: 'whatsapp_message', integration_type: 'whatsapp',
  integration_key: key, provider: 'meta_cloud_api' };

for (const [status, meta, expected] of [
  [400, 131026, 'whatsapp_rejected'],
  [400, 130429, 'whatsapp_rate_limited'],
  [503, 131026, 'whatsapp_provider_unavailable'],
]) {
  let calls = 0;
  const send = await sendWhatsappMessage(env, route, { to: '447700900001', body: 'synthetic' }, async (_url, init) => {
    calls += 1;
    assert.equal(init.method, 'POST');
    return Response.json({ error: { code: meta, message: privateData } }, { status });
  });
  assert.equal(calls, 1);
  assert.equal(send.errorCode, expected);
  assert.equal(send.metaErrorCode, meta);
  assert.equal(JSON.stringify(send).includes(privateData), false, 'no Meta body reaches CRM logging or acknowledgement');
}
console.log('WhatsApp Meta error-code privacy and retry classification passed.');
