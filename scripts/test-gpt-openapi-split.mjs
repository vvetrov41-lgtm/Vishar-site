import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monolith = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const communications = readFileSync(new URL('../docs/gpt-actions/openapi.production.communications.yaml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const rollout = readFileSync(new URL('../.github/workflows/gpt-production-three-action-surface-rollout.yml', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const canonical = operationIds(monolith);
const coreIds = operationIds(core);
const operationsIds = operationIds(operations);
const communicationsIds = operationIds(communications);
const combined = [...coreIds, ...operationsIds, ...communicationsIds];
const monzoIds = [
  'listMonzoReconciliationCandidates',
  'matchMonzoReconciliationCandidate',
  'ignoreMonzoReconciliationCandidate',
  'confirmMonzoReconciliationCandidate',
];

assert.equal(canonical.length, 62, 'canonical GPT schema must contain exactly 62 operations');
assert.equal(coreIds.length, 25, 'core ChatGPT-import schema must contain exactly 25 operations');
assert.equal(operationsIds.length, 25, 'operations ChatGPT-import schema must contain exactly 25 operations');
assert.equal(communicationsIds.length, 12, 'communications ChatGPT-import schema must contain exactly 12 operations');
for (const [name, ids] of [['core', coreIds], ['operations', operationsIds], ['communications', communicationsIds]]) {
  assert.ok(ids.length < 30, `${name} ChatGPT-import schema must stay below the editor 30-operation limit`);
  assert.ok(ids.length <= 25, `${name} ChatGPT-import schema should preserve at least five operation slots of headroom`);
}
assert.equal(new Set(combined).size, 62, 'split schemas must not duplicate operation IDs');
assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 62-operation surface');

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
    new RegExp(`operationId: ${operationId}\\n[\\s\\S]{0,500}?properties: \\{\\}`),
    `${operationId} must expose explicit empty properties for ChatGPT schema compatibility`,
  );
}

for (const id of ['listAccessibleArtists', 'getActiveArtist', 'setActiveArtist', 'listEnquiries', 'updateClient']) {
  assert.ok(coreIds.includes(id), `${id} must live in Core`);
}
assert.ok(!coreIds.includes('getProjectFinance'));

for (const id of ['listAppointments', 'recordManualPayment', 'getProjectFinance', 'updateProjectDeposit', 'listActivity', ...monzoIds]) assert.ok(operationsIds.includes(id));
for (const id of monzoIds) {
  assert.ok(!coreIds.includes(id), `${id} must not appear in Core`);
  assert.ok(!communicationsIds.includes(id), `${id} must not appear in Communications`);
}
for (const id of ['listInternalNotes', 'createInternalNote',
  'getWhatsAppConversation', 'ensureWhatsAppConversation', 'listWhatsAppMessages', 'sendWhatsAppMessage',
  'listEmailMessages', 'createEmailDraft', 'approveEmailDraft', 'searchEmailHistory', 'getEmailThread', 'createGmailReplyDraft']) {
  assert.ok(communicationsIds.includes(id), `${id} must live in Communications`);
  assert.ok(!operationsIds.includes(id), `${id} must not remain in Operations`);
  assert.ok(!coreIds.includes(id), `${id} must not appear in Core`);
}

assert.match(rollout, /^name: GPT production three action surface rollout$/m);
assert.match(rollout, /release\/private-crm-rc69-gpt-three-action-surface/);
assert.match(rollout, /PRODUCT_BRANCH: agent\/gpt-three-action-surface/);
assert.match(rollout, /EXPECTED_PR: '364'/);
assert.match(rollout, /environment: crm-production/);
assert.match(rollout, /\.draft == true/);
for (const workflow of ['Static Validation', 'CRM and booking validation', 'Gmail production validation']) {
  assert.ok(rollout.includes(`'${workflow}'`), `rollout must gate on ${workflow}`);
}
for (const domain of ['gpt-actions.vishartattoo.com', 'gpt-operations.vishartattoo.com', 'gpt-communications.vishartattoo.com']) {
  assert.ok(rollout.includes(domain), `rollout must verify ${domain}`);
}
assert.match(rollout, /npm run test:gpt-production/);
assert.match(rollout, /npm run validate:gpt-actions/);
assert.match(rollout, /npm run check:gpt-production-bundle/);
assert.match(rollout, /npm run scan:secrets/);
assert.match(rollout, /wrangler deploy --config wrangler\.gpt-actions\.production\.toml/);
assert.doesNotMatch(rollout, /supabase db push|STAGING_SUPABASE|gwaliusblwrzisrwnsvs|service_role|SUPABASE_SECRET_KEY|sb_secret_/i,
  'three-action rollout must not mutate the database, target staging or carry privileged credentials');

console.log('GPT OpenAPI split tests passed: 25 core + 25 operations + 12 communications, three domains, exact 62-operation coverage and guarded rollout separation.');
