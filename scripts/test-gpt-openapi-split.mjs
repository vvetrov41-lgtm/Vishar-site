import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monolith = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const canonical = operationIds(monolith);
const coreIds = operationIds(core);
const operationIdsSplit = operationIds(operations);
const combined = [...coreIds, ...operationIdsSplit];

assert.equal(canonical.length, 52, 'canonical GPT schema must keep exactly 52 operations');
assert.equal(coreIds.length, 26, 'core ChatGPT-import schema must contain exactly 26 operations');
assert.equal(operationIdsSplit.length, 26, 'operations ChatGPT-import schema must contain exactly 26 operations');
assert.ok(coreIds.length <= 30, 'core ChatGPT-import schema must stay at or below the editor 30-operation limit');
assert.ok(operationIdsSplit.length <= 30, 'operations ChatGPT-import schema must stay at or below the editor 30-operation limit');
assert.equal(new Set(combined).size, 52, 'split schemas must not duplicate operation IDs');
assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 52-operation surface');

assert.match(core, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(operations, /url: https:\/\/gpt-operations\.vishartattoo\.com/);
assert.doesNotMatch(core, /url: https:\/\/gpt-operations\.vishartattoo\.com/);
assert.doesNotMatch(operations, /^\s*- url: https:\/\/gpt-actions\.vishartattoo\.com$/m);

for (const [name, schema] of [['core', core], ['operations', operations]]) {
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
  const schema = coreIds.includes(operationId) ? core : operations;
  assert.match(
    schema,
    new RegExp(`operationId: ${operationId}[\\s\\S]{0,500}?properties: \\{\\}`),
    `${operationId} must expose explicit empty properties for ChatGPT schema compatibility`,
  );
}

assert.ok(coreIds.includes('listEnquiries'));
assert.ok(coreIds.includes('updateClient'));
assert.ok(coreIds.includes('updateProjectDeposit'));
assert.ok(operationIdsSplit.includes('listAppointments'));
assert.ok(operationIdsSplit.includes('recordManualPayment'));
assert.ok(operationIdsSplit.includes('sendWhatsAppMessage'));
assert.ok(operationIdsSplit.includes('approveEmailDraft'));

console.log('GPT OpenAPI split tests passed: 26 core + 26 operations, distinct action domains, exact 52-operation coverage and ChatGPT-compatible object schemas.');
