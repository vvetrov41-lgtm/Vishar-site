import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPERATOR_PARITY, PARITY_METADATA } from '../docs/gpt-actions/operator-parity.mjs';

const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const inventorySource = readFileSync(new URL('../docs/gpt-actions/operator-parity.mjs', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const importedBySchema = [operationIds(core), operationIds(operations)];
const imported = importedBySchema.flat();
const available = OPERATOR_PARITY.filter((row) => row.gpt.status === 'available');
const availableIds = available.map((row) => row.gpt.operationId);

assert.equal(PARITY_METADATA.schemaVersion, 2);
assert.equal(PARITY_METADATA.hardImportedSchemaOperationLimit, 30);
assert.equal(PARITY_METADATA.targetImportedSchemaOperationLimit, 25);
assert.equal(PARITY_METADATA.invariants.missingCoverageIsGap, true);
assert.equal(PARITY_METADATA.invariants.arbitrarySqlOrRpcProxyAllowed, false);
assert.equal(PARITY_METADATA.invariants.providerCredentialsModelSelectable, false);
assert.equal(PARITY_METADATA.invariants.providerConsentRemainsHuman, true);

assert.equal(
  imported.length,
  PARITY_METADATA.baselineImportedOperationCount,
  'production GPT transport changed: update the parity inventory deliberately',
);
assert.equal(new Set(imported).size, imported.length, 'current imported GPT operationIds must be globally unique');
assert.equal(new Set(OPERATOR_PARITY.map((row) => row.key)).size, OPERATOR_PARITY.length, 'operator parity keys must be unique');
assert.equal(new Set(availableIds).size, availableIds.length, 'available parity operationIds must be globally unique');
assert.equal(available.length, imported.length, 'every current production GPT operation must have exactly one available parity row');
assert.deepEqual([...availableIds].sort(), [...imported].sort(), 'available parity rows must exactly equal the imported production GPT union');

for (const schemaIds of importedBySchema) {
  assert.ok(
    schemaIds.length <= PARITY_METADATA.hardImportedSchemaOperationLimit,
    `an imported schema exceeds the hard ${PARITY_METADATA.hardImportedSchemaOperationLimit}-operation limit`,
  );
}

for (const actionDomain of PARITY_METADATA.actionDomains) {
  const rows = OPERATOR_PARITY.filter((row) => row.actionDomain === actionDomain);
  assert.ok(rows.length > 0, `${actionDomain} has no parity rows`);
  assert.ok(
    rows.length <= PARITY_METADATA.targetImportedSchemaOperationLimit,
    `${actionDomain} has ${rows.length} operations and exceeds the sustainable <=${PARITY_METADATA.targetImportedSchemaOperationLimit} target`,
  );
}

const representedCapabilityDomains = new Set(OPERATOR_PARITY.map((row) => row.capabilityDomain));
for (const domain of PARITY_METADATA.productionCapabilityDomains) {
  assert.ok(representedCapabilityDomains.has(domain), `production capability domain ${domain} is missing`);
}

const allowedConsequences = new Set(['read', 'write', 'provider_send', 'money', 'permission']);
const allowedStatuses = new Set(['available', 'gap', 'planned', 'ui_only']);
const allowedMcp = new Set(['candidate', 'planned', 'ui_only']);

for (const row of OPERATOR_PARITY) {
  assert.ok(PARITY_METADATA.actionDomains.includes(row.actionDomain), `${row.key} uses an unknown Action domain`);
  assert.ok(allowedConsequences.has(row.consequence), `${row.key} has an unknown consequence class`);
  assert.ok(allowedStatuses.has(row.gpt.status), `${row.key} has an unknown GPT status`);
  assert.ok(allowedMcp.has(row.mcp), `${row.key} has an unknown MCP status`);

  if (row.gpt.status === 'available') {
    assert.equal(typeof row.gpt.operationId, 'string', `${row.key} is available but has no operationId`);
    assert.ok(row.serverContracts.length > 0, `${row.key} is available but has no bounded contract evidence`);
  } else {
    assert.equal(row.gpt.operationId, null, `${row.key} is not available and must not advertise an imported operationId`);
  }

  if (row.gpt.status === 'gap') {
    assert.ok(row.serverContracts.length > 0, `${row.key} is a gap without an existing bounded contract`);
  }

  if (row.gpt.status === 'planned') {
    assert.equal(row.ui, 'not_yet', `${row.key} is planned but not marked not_yet`);
    assert.ok(row.note, `${row.key} planned boundary must explain what remains`);
  }

  if (row.gpt.status === 'ui_only') {
    assert.ok(['provider_handoff', 'device_local'].includes(row.ui), `${row.key} is UI-only without a concrete interaction boundary`);
    assert.ok(row.note, `${row.key} UI-only boundary must explain why`);
  }
}

const criticalGaps = [
  'finance.project.deposit_policy.configure',
  'finance.project.deposit.request',
  'finance.project.deposit.confirm_manual',
  'payments.session_deposit.request_grouped',
  'monzo.reconciliation.list',
  'monzo.reconciliation.match',
  'monzo.reconciliation.confirm',
  'monzo.reconciliation.ignore',
  'communications.conversations.list',
  'communications.reply.send',
  'booking_sources.create',
  'templates.upsert',
  'automation.rules.create',
  'team.invite',
  'workspace.create',
];

for (const key of criticalGaps) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} must remain explicit in the parity inventory`);
  assert.equal(row.gpt.status, 'gap', `${key} must remain a gap until implemented`);
}

for (const key of [
  'projects.create',
  'projects.sessions.link',
  'projects.sessions.unlink',
  'availability.day_overrides.list',
  'availability.day_overrides.upsert',
  'availability.day_overrides.delete',
]) {
  assert.equal(OPERATOR_PARITY.some((row) => row.key === key), false, `${key} is a stale/false operator-parity entry`);
}

for (const key of ['availability.list', 'availability.create', 'availability.update', 'availability.cancel']) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} must exist`);
  assert.equal(row.gpt.status, 'available');
  assert.ok(
    row.serverContracts.some((contract) => contract.includes('availability_block')),
    `${key} must map to the current time-off block contract, not old weekly-rule semantics`,
  );
}

for (const key of [
  'research.deep_web_search',
  'research.project_reference.add',
  'research.saved_run.compare',
  'research.monitor.create',
]) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} must remain explicit`);
  assert.equal(row.gpt.status, 'planned');
}

for (const key of [
  'files.device_upload',
  'whatsapp.embedded_signup',
  'instagram.meta_consent',
  'calendar.google_consent',
  'monzo.oauth_consent',
  'telegram.account_confirm',
  'gpt.oauth.consent',
]) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} deliberate human boundary must remain explicit`);
  assert.equal(row.gpt.status, 'ui_only');
}

assert.doesNotMatch(
  inventorySource,
  /service[_ -]?role|sb_secret_|oauth_client_secret|access_token\s*[:=]|refresh_token\s*[:=]/i,
  'operator parity inventory must never carry database or provider credentials',
);
assert.doesNotMatch(
  inventorySource,
  /executeSql|executeRpc|executeAnything|\/v1\/execute\b/i,
  'operator parity must remain semantic and bounded, not introduce a generic execution escape hatch',
);

const statusCounts = Object.fromEntries(
  [...new Set(OPERATOR_PARITY.map((row) => row.gpt.status))]
    .sort()
    .map((status) => [status, OPERATOR_PARITY.filter((row) => row.gpt.status === status).length]),
);
const domainCounts = Object.fromEntries(
  PARITY_METADATA.actionDomains.map((domain) => [domain, OPERATOR_PARITY.filter((row) => row.actionDomain === domain).length]),
);

console.log(
  `GPT operator parity passed: ${OPERATOR_PARITY.length} classified actions, `
  + `${imported.length} exact current production operations, `
  + `${PARITY_METADATA.actionDomains.length} sustainable semantic domains.`,
);
console.log('Status counts:', statusCounts);
console.log('Domain counts:', domainCounts);
