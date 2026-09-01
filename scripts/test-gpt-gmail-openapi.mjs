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

// The 66-operation monolith is retained as the legacy CRM contract. ChatGPT
// production imports the three split schemas, where Operations also carries the
// two bounded Web Research reads. They are intentionally absent from the legacy
// monolith because they do not read or mutate CRM records.
const webResearchIds = ['searchWeb', 'scrapeWebPage'];
for (const id of webResearchIds) {
  assert(ids.operations.includes(id), `Operations missing ${id}`);
  assert(!ids.monolith.includes(id), `Legacy CRM monolith must not contain ${id}`);
  assert(!ids.core.includes(id), `Core must not contain ${id}`);
  assert(!ids.communications.includes(id), `Communications must not contain ${id}`);
}

const splitUnion = new Set([...ids.core, ...ids.operations, ...ids.communications]);
const expectedSplit = new Set([...ids.monolith, ...webResearchIds]);
assert.equal(splitUnion.size, expectedSplit.size, 'split schemas must equal the legacy CRM monolith plus Web Research');
for (const id of expectedSplit) assert(splitUnion.has(id), `split schemas missing ${id}`);

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

console.log(`GPT Gmail OpenAPI split valid: core=${ids.core.length}, operations=${ids.operations.length}, communications=${ids.communications.length}, legacy_monolith=${ids.monolith.length}`);
