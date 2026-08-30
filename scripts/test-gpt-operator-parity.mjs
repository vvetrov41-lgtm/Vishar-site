import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPERATOR_PARITY, PARITY_METADATA } from '../docs/gpt-actions/operator-parity.mjs';

const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const inventorySource = readFileSync(new URL('../docs/gpt-actions/operator-parity.mjs', import.meta.url), 'utf8');

const operationIds = (text) => [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
const imported = [...operationIds(core), ...operationIds(operations)];
const available = OPERATOR_PARITY.filter((row) => row.gpt.status === 'available');
const availableIds = available.map((row) => row.gpt.operationId);

assert.equal(PARITY_METADATA.hardImportedSchemaOperationLimit, 30);
assert.equal(PARITY_METADATA.targetImportedSchemaOperationLimit, 25);
assert.equal(PARITY_METADATA.invariants.missingCoverageIsGap, true);
assert.equal(PARITY_METADATA.invariants.arbitrarySqlOrRpcProxyAllowed, false);
assert.equal(PARITY_METADATA.invariants.providerCredentialsModelSelectable, false);

assert.equal(OPERATOR_PARITY.length, 154, 'inventory changes must be deliberate and accompanied by test updates');
assert.equal(new Set(OPERATOR_PARITY.map((row) => row.key)).size, OPERATOR_PARITY.length, 'operator parity keys must be unique');
assert.equal(new Set(imported).size, imported.length, 'current imported GPT operationIds must be globally unique');
assert.equal(new Set(availableIds).size, availableIds.length, 'available inventory operationIds must be globally unique');
assert.equal(available.length, 57, 'current production GPT surface must still contain exactly 57 available operations');
assert.deepEqual([...availableIds].sort(), [...imported].sort(), 'every imported GPT operation must appear exactly once as available in the parity inventory');

const expectedStatuses = new Map([
  ['available', 57],
  ['gap', 72],
  ['planned', 19],
  ['ui_only', 6],
]);
for (const [status, expected] of expectedStatuses) {
  assert.equal(OPERATOR_PARITY.filter((row) => row.gpt.status === status).length, expected, `unexpected ${status} inventory count`);
}

const expectedDomainCounts = new Map([
  ['CRM Core', 21],
  ['Project Workflow', 9],
  ['Scheduling', 18],
  ['Finance', 15],
  ['Communications', 13],
  ['Notifications', 14],
  ['Automations', 14],
  ['Integrations', 23],
  ['Admin', 11],
  ['Research', 16],
]);
for (const actionDomain of PARITY_METADATA.actionDomains) {
  const count = OPERATOR_PARITY.filter((row) => row.actionDomain === actionDomain).length;
  assert.equal(count, expectedDomainCounts.get(actionDomain), `unexpected inventory size for ${actionDomain}`);
  assert.ok(count <= PARITY_METADATA.targetImportedSchemaOperationLimit,
    `${actionDomain} exceeds the sustainable <=${PARITY_METADATA.targetImportedSchemaOperationLimit} Action-domain target`);
}

const availableDomainCounts = new Map([
  ['CRM Core', 19],
  ['Project Workflow', 5],
  ['Scheduling', 12],
  ['Finance', 7],
  ['Communications', 10],
  ['Notifications', 4],
  ['Automations', 0],
  ['Integrations', 0],
  ['Admin', 0],
  ['Research', 0],
]);
for (const [actionDomain, expected] of availableDomainCounts) {
  assert.equal(available.filter((row) => row.actionDomain === actionDomain).length, expected,
    `current 57-operation classification drifted for ${actionDomain}`);
}

const representedCapabilityDomains = new Set(OPERATOR_PARITY.map((row) => row.capabilityDomain));
for (const domain of PARITY_METADATA.productionCapabilityDomains) {
  assert.ok(representedCapabilityDomains.has(domain), `production capability domain ${domain} is missing from operator parity inventory`);
}

for (const row of OPERATOR_PARITY) {
  assert.ok(PARITY_METADATA.actionDomains.includes(row.actionDomain), `${row.key} uses an unknown Action domain`);
  assert.ok(['read', 'write', 'provider_send', 'money', 'permission'].includes(row.consequence), `${row.key} has an unknown consequence class`);
  assert.ok(['available', 'gap', 'planned', 'ui_only'].includes(row.gpt.status), `${row.key} has an unknown GPT status`);
  assert.ok(['candidate', 'planned', 'ui_only'].includes(row.mcp), `${row.key} has an unknown MCP status`);

  if (row.gpt.status === 'available') {
    assert.ok(row.gpt.operationId, `${row.key} is available but has no operationId`);
    assert.ok(row.serverContracts.length > 0, `${row.key} is available but has no bounded server contract`);
  } else {
    assert.equal(row.gpt.operationId, null, `${row.key} is not available and must not advertise an imported operationId`);
  }

  if (row.gpt.status === 'gap') {
    assert.ok(row.serverContracts.length > 0, `${row.key} is a gap only when a bounded existing server contract is known`);
  }

  if (row.gpt.status === 'ui_only') {
    assert.ok(['provider_handoff', 'device_local'].includes(row.ui), `${row.key} is UI-only without an unavoidable interactive boundary`);
    assert.ok(row.note, `${row.key} UI-only boundary must explain why`);
  }
}

const criticalGaps = [
  'projects.create',
  'projects.sessions.link',
  'projects.sessions.unlink',
  'monzo.reconciliation.list',
  'monzo.reconciliation.match',
  'monzo.reconciliation.confirm',
  'monzo.reconciliation.ignore',
  'booking_sources.list',
  'booking_sources.create',
  'integrations.status.list',
  'gmail.connect.start',
  'whatsapp.connect.start',
  'instagram.connect.start',
  'calendar.connection.configure',
  'telegram.link.begin',
  'templates.list',
  'templates.resolve_preview',
  'templates.upsert',
  'automation.rules.list',
  'automation.rules.create',
  'lifecycle.health.get',
  'team.memberships.list',
  'workspace.membership.upsert',
];
for (const key of criticalGaps) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} must remain explicit in the parity inventory`);
  assert.equal(row.gpt.status, 'gap', `${key} must remain an explicit GPT coverage gap until implemented`);
}

for (const key of [
  'instagram.messages.list',
  'instagram.reply.send',
  'research.deep_web_search',
  'research.project_reference.add',
  'research.saved_run.compare',
  'research.monitor.create',
]) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} planned capability must remain explicit`);
  assert.equal(row.gpt.status, 'planned');
}

for (const key of [
  'gmail.oauth.consent',
  'whatsapp.meta.consent',
  'instagram.meta.consent',
  'calendar.google.consent',
  'telegram.account.confirm',
  'files.device_upload',
]) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.key === key);
  assert.ok(row, `${key} deliberate UI-only boundary must remain explicit`);
  assert.equal(row.gpt.status, 'ui_only');
}

assert.doesNotMatch(inventorySource, /service[_ -]?role|sb_secret_|oauth_client_secret|access_token\s*[:=]/i,
  'operator parity inventory must never carry provider or database credentials');
assert.doesNotMatch(inventorySource, /executeSql|executeRpc|executeAnything|arbitrary provider proxy/i,
  'operator parity must stay semantic and bounded rather than introducing a generic execution escape hatch');

console.log('GPT operator parity tests passed: 154 classified operations, exact current 57-operation union, 10 sustainable Action domains, all production capability domains represented, explicit gaps/plans/UI-only boundaries.');
