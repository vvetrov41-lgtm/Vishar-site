import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPERATOR_PARITY,
  OWNER_EXTENSIONS,
  PARITY_METADATA,
  paritySummary,
} from '../docs/gpt-actions/operator-parity.current.mjs';
import { DOMAIN_OPERATIONS } from '../workers/lib/gpt-domain-operations.js';
import { buildProjections } from './build-gpt-unified-openapi.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), 'utf8');

function walk(dir, predicate, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) walk(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

// ---------------------------------------------------------------- metadata
assert.equal(PARITY_METADATA.schemaVersion, 3);
assert.equal(PARITY_METADATA.hardImportedSchemaOperationLimit, 30);
assert.equal(PARITY_METADATA.targetImportedSchemaOperationLimit, 25);
assert.deepEqual([...PARITY_METADATA.statuses], ['available', 'implement_now', 'ui_only']);
assert.equal(PARITY_METADATA.invariants.missingCoverageIsImplementNow, true);
assert.equal(PARITY_METADATA.invariants.arbitrarySqlOrRpcProxyAllowed, false);
assert.equal(PARITY_METADATA.invariants.providerCredentialsModelSelectable, false);
assert.equal(PARITY_METADATA.invariants.providerConsentRemainsHuman, true);

const domains = Object.keys(PARITY_METADATA.actionDomains);
const hosts = Object.values(PARITY_METADATA.actionDomains);
assert.equal(new Set(hosts).size, hosts.length, 'every Action domain needs its own host for the GPT editor');
for (const host of hosts) assert.match(host, /^gpt-[a-z]+\.vishartattoo\.com$/);

// ------------------------------------------------------------- row shape
const keys = OPERATOR_PARITY.map((row) => row.key);
assert.equal(new Set(keys).size, keys.length, 'parity keys must be unique');

const exposedIds = [
  ...OPERATOR_PARITY.filter((row) => row.gpt.status !== 'ui_only').map((row) => row.gpt.operationId),
  ...OWNER_EXTENSIONS.map((entry) => entry.operationId),
];
assert.equal(new Set(exposedIds).size, exposedIds.length, 'operationIds must be globally unique');

for (const row of OPERATOR_PARITY) {
  assert.ok(domains.includes(row.actionDomain), `${row.key} uses an unknown Action domain`);
  assert.ok(PARITY_METADATA.statuses.includes(row.gpt.status), `${row.key} has an unknown status`);
  assert.ok(PARITY_METADATA.consequences.includes(row.consequence), `${row.key} has an unknown consequence`);
  if (row.gpt.status === 'ui_only') {
    assert.equal(row.gpt.operationId, null);
    assert.ok(['provider_handoff', 'device_local', 'pre_profile'].includes(row.ui), `${row.key} UI-only needs a concrete kind`);
    assert.ok(row.note && row.note.length > 40, `${row.key} UI-only must explain the unavoidable human step`);
  } else {
    assert.match(row.gpt.operationId, /^[a-z][A-Za-z0-9]+$/, `${row.key} needs an operationId`);
    assert.ok(row.serverContracts.length > 0, `${row.key} needs bounded server-contract evidence`);
  }
}

// ------------------------------------------- domain capacity (<= 25 target)
const domainCounts = Object.fromEntries(domains.map((domain) => [domain, 0]));
for (const row of OPERATOR_PARITY) if (row.gpt.status !== 'ui_only') domainCounts[row.actionDomain] += 1;
for (const entry of OWNER_EXTENSIONS) domainCounts[entry.actionDomain] += 1;
for (const [domain, count] of Object.entries(domainCounts)) {
  assert.ok(count > 0, `${domain} has no operations`);
  assert.ok(count <= PARITY_METADATA.targetImportedSchemaOperationLimit,
    `${domain} has ${count} operations and exceeds the <=${PARITY_METADATA.targetImportedSchemaOperationLimit} target`);
}

// --------------------------------- server contracts exist at this revision
const migrations = walk('supabase/migrations', (path) => path.endsWith('.sql')).map(read).join('\n');
const definedFunctions = new Set(
  [...migrations.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi)].map((match) => match[1]),
);
const contractFunctions = new Set();
for (const row of OPERATOR_PARITY) {
  for (const contract of row.serverContracts) {
    const match = /^public\.([a-z0-9_]+)$/.exec(contract);
    if (!match) continue;
    contractFunctions.add(match[1]);
    assert.ok(definedFunctions.has(match[1]), `${row.key} cites public.${match[1]}, which no migration defines`);
  }
}

// ------------------------- drift: every CRM RPC is classified exactly once
const crmSources = walk('admin/src', (path) => /\.(ts|tsx)$/.test(path) && !/(\.test\.|\/test\/)/.test(path));
const crmRpcs = new Set();
for (const path of crmSources) {
  for (const match of read(path).matchAll(/\.rpc(?:<[^>]*>)?\(\s*['"]([a-z0-9_]+)['"]/g)) crmRpcs.add(match[1]);
}
assert.ok(crmRpcs.size > 100, 'CRM RPC scan found too few calls; the scanner is broken');

const nonOperator = PARITY_METADATA.nonOperatorUiRpcs;
const workerSteps = PARITY_METADATA.workerStepRpcs;
const unclassified = [...crmRpcs].filter((name) => !contractFunctions.has(name) && !(name in nonOperator) && !(name in workerSteps));
assert.deepEqual(unclassified, [], `CRM calls RPCs the parity inventory does not classify: ${unclassified.join(', ')}`);

for (const name of PARITY_METADATA.retiredFromCrmUi) {
  assert.equal(crmRpcs.has(name), false, `${name} is back in the CRM UI: classify it in the parity inventory`);
  assert.equal(contractFunctions.has(name), false, `${name} is retired from the CRM UI and must not be counted as parity`);
}
for (const name of Object.keys(nonOperator)) {
  assert.ok(crmRpcs.has(name), `${name} is listed as a non-operator CRM RPC but the CRM no longer calls it`);
}

// ------------------ drift: CRM-called Worker endpoints stay classified too
const workerEndpoints = [
  ['workers/team-admin.js', '/v1/staff/invite', 'team.invite'],
  ['workers/team-admin.js', '/v1/artist/invite', 'team.artist_invite'],
  ['admin/src/lib/email-api.ts', '/v1/operator/clients/', 'email.client_history.search'],
  ['admin/src/lib/email-api.ts', '/v1/operator/artists/', 'email.inbox.list'],
  ['admin/src/lib/instagram-connections-api.ts', '/v1/connections/status', 'instagram.connection.status'],
  ['admin/src/lib/instagram-connections-api.ts', '/v1/connections/start', 'instagram.connection.start'],
  ['admin/src/lib/instagram-connections-api.ts', '/v1/connections/disconnect', 'instagram.disconnect'],
  ['admin/functions/api/whatsapp/embedded-signup/provision.js', '', 'whatsapp.embedded_signup'],
  ['admin/functions/api/whatsapp/existing-account/provision.js', '', 'whatsapp.existing_account.system_user_token'],
  ['admin/functions/api/whatsapp/meta-review/template.js', '', 'whatsapp.meta_review.template'],
];
for (const [path, marker, key] of workerEndpoints) {
  assert.ok(read(path).includes(marker), `${path} no longer carries ${marker}; re-check ${key}`);
  assert.ok(OPERATOR_PARITY.some((row) => row.key === key), `${key} must stay classified`);
}
const pagesFunctions = walk('admin/functions', (path) => path.endsWith('.js'));
assert.equal(pagesFunctions.length, 3, 'a new CRM Pages function appeared: classify it in the parity inventory');

// ------ available rows equal legacy imports plus the unified domain registry
const legacySchemas = ['core', 'operations', 'communications', 'cloudflare']
  .map((name) => operationIds(read(`docs/gpt-actions/openapi.production.${name}.yaml`)));
const imported = legacySchemas.flat();
assert.equal(new Set(imported).size, imported.length, 'imported operationIds must be globally unique');
const registryIds = DOMAIN_OPERATIONS.map((entry) => entry.id);
for (const id of registryIds) assert.ok(!imported.includes(id), `${id} is both legacy and registry`);
const availableIds = [
  ...OPERATOR_PARITY.filter((row) => row.gpt.status === 'available').map((row) => row.gpt.operationId),
  ...OWNER_EXTENSIONS.map((entry) => entry.operationId),
];
assert.deepEqual([...availableIds].sort(), [...imported, ...registryIds].sort(),
  'available parity rows must equal exactly the legacy imports plus the implemented registry operations');
for (const entry of DOMAIN_OPERATIONS) {
  const row = OPERATOR_PARITY.find((candidate) => candidate.gpt.operationId === entry.id);
  assert.equal(row.actionDomain, entry.domain, `${entry.id} registry domain must match parity`);
  assert.ok(definedFunctions.has(entry.rpc), `${entry.id} routes to public.${entry.rpc}, which no migration defines`);
  const writes = row.consequence !== 'read';
  assert.equal(entry.consequential, writes, `${entry.id} consequential flag must match its parity consequence`);
}

// ------------------------------------- unified OpenAPI projections are exact
const projections = buildProjections();
for (const projection of projections) {
  const expectedIds = [
    ...OPERATOR_PARITY.filter((row) => row.actionDomain === projection.domain && row.gpt.status === 'available').map((row) => row.gpt.operationId),
    ...OWNER_EXTENSIONS.filter((entry) => entry.actionDomain === projection.domain).map((entry) => entry.operationId),
  ];
  assert.deepEqual([...projection.operationIds].sort(), [...expectedIds].sort(), `${projection.domain} projection equals its available rows`);
  assert.ok(projection.operationIds.length <= PARITY_METADATA.targetImportedSchemaOperationLimit);
  if (projection.operationIds.length === 0) continue;
  const committed = read(`docs/gpt-actions/unified/openapi.${projection.slug}.yaml`);
  assert.equal(committed, projection.text, `docs/gpt-actions/unified/openapi.${projection.slug}.yaml is stale; run node scripts/build-gpt-unified-openapi.mjs`);
  assert.ok(committed.includes(`- url: https://${projection.host}`), `${projection.domain} must serve from ${projection.host}`);
  assert.match(committed, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/, 'one OAuth application for every domain');
  const withoutContext = committed.replace(/\n  \/v1\/context:[\s\S]*?(?=\n  \/v1\/|\ncomponents:)/, '');
  assert.doesNotMatch(withoutContext, /\bartist_id: \{type|name: artist_id|required: \[artist_id/, `${projection.domain} accepts artist_id outside /v1/context`);
}
const projected = projections.flatMap((projection) => projection.operationIds);
assert.equal(new Set(projected).size, projected.length, 'an operation is projected into exactly one domain');

// ------------------------------------------ UI-only is only the human step
const uiOnly = OPERATOR_PARITY.filter((row) => row.gpt.status === 'ui_only').map((row) => row.key).sort();
assert.deepEqual(uiOnly, [
  'calendar.connection.disconnect',
  'calendar.google_consent',
  'files.device_upload',
  'gpt.oauth.consent',
  'instagram.meta_consent',
  'monzo.oauth_consent',
  'signup.tenant.bootstrap',
  'telegram.account_confirm',
  'whatsapp.embedded_signup',
  'whatsapp.existing_account.system_user_token',
  'whatsapp.meta_review.template',
]);

const inventorySource = read('docs/gpt-actions/operator-parity.current.mjs');
assert.doesNotMatch(inventorySource, /service[_ -]?role|sb_secret_|oauth_client_secret|access_token\s*[:=]|refresh_token\s*[:=]/i,
  'the inventory must never carry credentials');
assert.doesNotMatch(inventorySource, /executeSql|executeRpc|executeAnything|\/v1\/execute\b/i,
  'parity must stay semantic, never a generic execution escape hatch');

const summary = paritySummary();
console.log(
  `GPT operator parity passed: ${summary.total} CRM operator actions `
  + `(available ${summary.available}, implement_now ${summary.implement_now}, ui_only ${summary.ui_only}); `
  + `${crmRpcs.size} CRM RPCs classified; owner extensions ${OWNER_EXTENSIONS.length}.`,
);
console.log('Domain counts:', domainCounts);
