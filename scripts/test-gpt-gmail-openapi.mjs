import fs from 'node:fs';
import assert from 'node:assert/strict';

const files = {
  core: 'docs/gpt-actions/openapi.production.core.yaml',
  operations: 'docs/gpt-actions/openapi.production.operations.yaml',
  monolith: 'docs/gpt-actions/openapi.production.yaml',
};
const text = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
const ids = Object.fromEntries(Object.entries(text).map(([key, value]) => [key, [...value.matchAll(/^\s+operationId:\s*([^\s]+)\s*$/gm)].map((match) => match[1])]));

for (const [name, values] of Object.entries(ids)) {
  assert.equal(new Set(values).size, values.length, `${name} has duplicate operationId values`);
}
assert(ids.core.length <= 30, `Core exceeds Builder limit: ${ids.core.length}`);
assert(ids.operations.length <= 30, `Operations exceeds Builder limit: ${ids.operations.length}`);

const gmailIds = ['searchEmailHistory', 'getEmailThread', 'createGmailReplyDraft'];
for (const id of gmailIds) {
  assert(ids.operations.includes(id), `Operations missing ${id}`);
  assert(ids.monolith.includes(id), `Monolith missing ${id}`);
  assert(!ids.core.includes(id), `Core must not contain ${id}`);
}

const splitUnion = new Set([...ids.core, ...ids.operations]);
const monolithSet = new Set(ids.monolith);
for (const id of gmailIds) assert(splitUnion.has(id) && monolithSet.has(id));

const start = text.operations.indexOf('  /v1/enquiries/{enquiry_id}/gmail/history:');
const end = text.operations.indexOf('  /v1/enquiries/{enquiry_id}/emails:', start);
assert(start >= 0 && end > start, 'Gmail Operations block not found');
const gmailBlock = text.operations.slice(start, end);
for (const forbidden of [
  'artist_id', 'oauth_client_id', 'integration_key', 'access_token', 'refresh_token',
  'google_account', 'client_secret', 'mail.google.com',
]) {
  assert(!gmailBlock.includes(forbidden), `Gmail schema exposes forbidden field/token: ${forbidden}`);
}
assert(gmailBlock.includes('additionalProperties: false'));
assert(gmailBlock.includes('thread_context_id'));
assert(gmailBlock.includes('untrusted data'));
assert(text.operations.includes('url: https://gpt-operations.vishartattoo.com'));

console.log(`GPT Gmail OpenAPI split valid: core=${ids.core.length}, operations=${ids.operations.length}, monolith=${ids.monolith.length}`);
