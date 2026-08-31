import fs from 'node:fs';
import assert from 'node:assert/strict';

const files = {
  core: 'docs/gpt-actions/openapi.production.core.yaml',
  operations: 'docs/gpt-actions/openapi.production.operations.yaml',
  communications: 'docs/gpt-actions/openapi.production.communications.yaml',
  monolith: 'docs/gpt-actions/openapi.production.yaml',
};
const text = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
const ids = Object.fromEntries(Object.entries(text).map(([key, value]) => [key, [...value.matchAll(/^\s+operationId:\s*([^\s]+)\s*$/gm)].map((match) => match[1])]));

for (const [name, values] of Object.entries(ids)) {
  assert.equal(new Set(values).size, values.length, `${name} has duplicate operationId values`);
}
for (const name of ['core', 'operations', 'communications']) {
  assert(ids[name].length <= 30, `${name} exceeds Builder hard limit: ${ids[name].length}`);
}

const gmailIds = ['searchEmailHistory', 'getEmailThread', 'createGmailReplyDraft'];
for (const id of gmailIds) {
  assert(ids.communications.includes(id), `Communications missing ${id}`);
  assert(ids.monolith.includes(id), `Monolith missing ${id}`);
  assert(!ids.core.includes(id), `Core must not contain ${id}`);
  assert(!ids.operations.includes(id), `Operations import must not retain ${id}`);
}

const splitUnion = new Set([...ids.core, ...ids.operations, ...ids.communications]);
const monolithSet = new Set(ids.monolith);
assert.equal(splitUnion.size, monolithSet.size, 'split schemas and monolith must have equal operation counts');
for (const id of monolithSet) assert(splitUnion.has(id), `split schemas missing ${id}`);

const start = text.communications.indexOf('  /v1/enquiries/{enquiry_id}/gmail/history:');
const end = text.communications.indexOf('  /v1/enquiries/{enquiry_id}/emails:', start);
assert(start >= 0 && end > start, 'Gmail Communications block not found');
const gmailBlock = text.communications.slice(start, end);
for (const forbidden of [
  'artist_id', 'oauth_client_id', 'integration_key', 'access_token', 'refresh_token',
  'google_account', 'client_secret', 'mail.google.com',
]) {
  assert(!gmailBlock.includes(forbidden), `Gmail schema exposes forbidden field/token: ${forbidden}`);
}
assert(gmailBlock.includes('additionalProperties: false'));
assert(gmailBlock.includes('thread_context_id'));
assert(gmailBlock.includes('untrusted data'));
assert(text.communications.includes('url: https://gpt-communications.vishartattoo.com'));
assert(text.communications.includes('authorizationUrl: https://gpt-actions.vishartattoo.com/oauth/authorize'));
assert(text.communications.includes('tokenUrl: https://gpt-actions.vishartattoo.com/oauth/token'));

console.log(`GPT Gmail OpenAPI split valid: core=${ids.core.length}, operations=${ids.operations.length}, communications=${ids.communications.length}, monolith=${ids.monolith.length}`);
