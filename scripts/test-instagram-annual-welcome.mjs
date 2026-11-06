import assert from 'node:assert/strict';
import { sendInstagramMessage } from '../workers/lib/instagram.js';

const args = {
  accessToken: 'fixture-token', instagramUserId: '17841400000000001',
  recipientId: '100000000001', body: 'Fixture only',
};
for (const [label, fetchImpl] of [
  ['transport after possible acceptance', async () => { throw new Error('reset'); }],
  ['unparseable success', async () => new Response('oops', { status: 200 })],
  ['success without message id', async () => Response.json({})],
  ['ambiguous server failure', async () => Response.json({ error: {} }, { status: 503 })],
  ['redirect without acceptance evidence', async () => new Response('', { status: 302 })],
]) {
  const result = await sendInstagramMessage({ ...args, fetchImpl });
  assert.equal(result.errorCode, 'communication_send_result_unknown', label);
  assert.equal(result.delivered, false, label);
}
assert.deepEqual(await sendInstagramMessage({ ...args,
  fetchImpl: async () => Response.json({ message_id: 'fixture-message-id' }),
}), { delivered: true, providerMessageId: 'fixture-message-id' });
assert.equal((await sendInstagramMessage({ ...args,
  fetchImpl: async () => Response.json({ error: { code: 190 } }, { status: 401 }),
})).delivered, false);
console.log('PASS: Instagram uncertain outcomes cannot automatically retry');
