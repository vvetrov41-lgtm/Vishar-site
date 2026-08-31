import assert from 'node:assert/strict';
import { __testing as gmailWorker } from '../workers/gmail-production.js';

const enquiryId = '11111111-1111-4111-8111-111111111111';
const path = `/v1/enquiries/${enquiryId}/gmail/history`;
const env = { GMAIL_READ_ENABLED: 'true' };

let outboundCalls = 0;
const noOutbound = async () => {
  outboundCalls += 1;
  throw new Error('Gmail host boundary must reject before outbound access');
};

for (const host of ['gpt-operations.vishartattoo.com', 'gpt-communications.vishartattoo.com']) {
  const url = new URL(`https://${host}${path}`);
  const response = await gmailWorker.handleGptAction(new Request(url), url, env, noOutbound);
  assert(response instanceof Response, `${host} must be a recognized Gmail GPT Action host`);
  assert.equal(response.status, 401, `${host} must require GPT OAuth before any downstream access`);
  assert.deepEqual(await response.json(), { error: 'oauth_token_required' });
}

for (const host of ['gpt-actions.vishartattoo.com', 'attacker.example']) {
  const url = new URL(`https://${host}${path}`);
  const response = await gmailWorker.handleGptAction(new Request(url), url, env, noOutbound);
  assert.equal(response, null, `${host} must not be accepted by the Gmail GPT Action boundary`);
}

assert.equal(outboundCalls, 0, 'host/auth boundary must not contact Supabase or Gmail');
console.log('Gmail GPT host boundary regression passed.');
