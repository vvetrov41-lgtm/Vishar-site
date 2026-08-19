import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monolith = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const communications = readFileSync(new URL('../docs/gpt-actions/openapi.production.communications.yaml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const canonical = operationIds(monolith);
const coreIds = operationIds(core);
const operationsIds = operationIds(operations);
const communicationsIds = operationIds(communications);
const combined = [...coreIds, ...operationsIds, ...communicationsIds];

assert.equal(canonical.length, 55, 'canonical GPT schema must keep exactly 55 operations');
assert.equal(coreIds.length, 25, 'core ChatGPT-import schema must contain exactly 25 operations');
assert.equal(operationsIds.length, 20, 'operations ChatGPT-import schema must contain exactly 20 operations');
assert.equal(communicationsIds.length, 10, 'communications ChatGPT-import schema must contain exactly 10 operations');
for (const [name, ids] of [['core', coreIds], ['operations', operationsIds], ['communications', communicationsIds]]) {
  assert.ok(ids.length < 30, `${name} ChatGPT-import schema must stay below the editor 30-operation limit`);
  assert.ok(ids.length <= 25, `${name} ChatGPT-import schema should preserve at least five operation slots of headroom`);
}
assert.equal(new Set(combined).size, 55, 'split schemas must not duplicate operation IDs');
assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 55-operation surface');

assert.match(core, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(operations, /url: https:\/\/gpt-operations\.vishartattoo\.com/);
assert.match(communications, /url: https:\/\/gpt-communications\.vishartattoo\.com/);
assert.doesNotMatch(core, /url: https:\/\/gpt-(?:operations|communications)\.vishartattoo\.com/);
assert.doesNotMatch(operations, /^\s*- url: https:\/\/gpt-(?:actions|communications)\.vishartattoo\.com$/m);
assert.doesNotMatch(communications, /^\s*- url: https:\/\/gpt-(?:actions|operations)\.vishartattoo\.com$/m);

for (const domain of ['gpt-actions', 'gpt-operations', 'gpt-communications']) {
  assert.match(wrangler, new RegExp(`pattern = "${domain}\\.vishartattoo\\.com", custom_domain = true`));
}
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 3,
  'production GPT Worker must expose exactly three custom domains for the three ChatGPT action sets');

for (const [name, schema] of [['core', core], ['operations', operations], ['communications', communications]]) {
  assert.match(schema, /^openapi: 3\.1\.0$/m, `${name} schema must use OpenAPI 3.1`);
  assert.match(schema, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
  assert.match(schema, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
  assert.doesNotMatch(schema, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);
  assert.doesNotMatch(schema, /\bartist_id\b|oauth_client_id|integration_key|service_role|SUPABASE_SECRET_KEY|sb_secret_|storage_path|sha256|signed_url/i,
    `${name} schema must not expose routing, credentials or private Storage internals`);
  assert.doesNotMatch(
    schema,
    /schema:\s*\{type: object, additionalProperties: false\}\}/,
    `${name} ChatGPT-import schema must not contain an object request schema without properties`,
  );
}

const noPayloadOperations = [
  'completeFollowUp',
  'cancelFollowUp',
  'cancelAvailability',
  'cancelPaymentRequest',
  'ensureWhatsAppConversation',
  'approveEmailDraft',
];
for (const operationId of noPayloadOperations) {
  const schema = coreIds.includes(operationId) ? core
    : operationsIds.includes(operationId) ? operations
      : communications;
  assert.match(
    schema,
    new RegExp(`operationId: ${operationId}[\\s\\S]{0,500}?properties: \\{\\}`),
    `${operationId} must expose explicit empty properties for ChatGPT schema compatibility`,
  );
}

for (const id of ['listEnquiries', 'updateClient', 'updateProjectDeposit']) assert.ok(coreIds.includes(id));
assert.ok(!coreIds.includes('getProjectFinance'));

for (const id of ['listAppointments', 'recordManualPayment', 'getProjectFinance', 'listActivity']) assert.ok(operationsIds.includes(id));
for (const id of ['getWhatsAppConversation', 'ensureWhatsAppConversation', 'listWhatsAppMessages', 'sendWhatsAppMessage',
  'listEmailMessages', 'createEmailDraft', 'approveEmailDraft', 'searchEmailHistory', 'getEmailThread', 'createGmailReplyDraft']) {
  assert.ok(communicationsIds.includes(id), `${id} must live in Communications`);
  assert.ok(!operationsIds.includes(id), `${id} must not remain in Operations`);
  assert.ok(!coreIds.includes(id), `${id} must not appear in Core`);
}

console.log('GPT OpenAPI split tests passed: 25 core + 20 operations + 10 communications, three domains, exact 55-operation coverage and five-slot minimum headroom.');
