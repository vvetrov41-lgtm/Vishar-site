import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monolith = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const core = readFileSync(new URL('../docs/gpt-actions/openapi.production.core.yaml', import.meta.url), 'utf8');
const operations = readFileSync(new URL('../docs/gpt-actions/openapi.production.operations.yaml', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');

function operationIds(text) {
  return [...text.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
}

const canonical = operationIds(monolith);
const coreIds = operationIds(core);
const operationIdsSplit = operationIds(operations);
const combined = [...coreIds, ...operationIdsSplit];

assert.equal(canonical.length, 57, 'canonical GPT schema must keep exactly 57 operations');
assert.equal(coreIds.length, 28, 'core ChatGPT-import schema must contain exactly 28 operations');
assert.equal(operationIdsSplit.length, 29, 'operations ChatGPT-import schema must contain exactly 29 operations');
assert.ok(coreIds.length <= 30, 'core ChatGPT-import schema must stay at or below the editor 30-operation limit');
assert.ok(operationIdsSplit.length <= 30, 'operations ChatGPT-import schema must stay at or below the editor 30-operation limit');
assert.equal(new Set(combined).size, 57, 'split schemas must not duplicate operation IDs');
assert.deepEqual([...combined].sort(), [...canonical].sort(), 'split schemas must cover the exact canonical 57-operation surface');

assert.match(core, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(operations, /url: https:\/\/gpt-operations\.vishartattoo\.com/);
assert.doesNotMatch(core, /url: https:\/\/gpt-operations\.vishartattoo\.com/);
assert.doesNotMatch(operations, /^\s*- url: https:\/\/gpt-actions\.vishartattoo\.com$/m);
assert.match(wrangler, /pattern = "gpt-actions\.vishartattoo\.com", custom_domain = true/);
assert.match(wrangler, /pattern = "gpt-operations\.vishartattoo\.com", custom_domain = true/);
assert.equal((wrangler.match(/custom_domain = true/g) || []).length, 2,
  'production GPT Worker must expose exactly two custom domains for the two ChatGPT action sets');

// /v1/context is the single reviewed exception to the artist_id ban. It is a
// selector for which artist the signed-in CRM user is currently working as,
// re-checked against that user's memberships in the database, and it is the
// only place the string may appear. Every CRM action must still be unable to
// name an artist, so the ban is applied to the schema with that one path
// removed rather than relaxed.
function withoutContextPath(schema) {
  return schema.replace(/^ {2}\/v1\/context:\n(?: {3,}.*\n|\n(?= {3,}\S))*/m, '');
}

for (const [name, schema] of [['core', core], ['operations', operations]]) {
  assert.match(schema, /^openapi: 3\.1\.0$/m, `${name} schema must use OpenAPI 3.1`);
  assert.match(schema, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
  assert.match(schema, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
  assert.doesNotMatch(schema, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);
  assert.doesNotMatch(withoutContextPath(schema), /\bartist_id\b/i,
    `${name} schema must not let a CRM action name an artist outside /v1/context`);
  assert.doesNotMatch(schema, /oauth_client_id|integration_key|service_role|SUPABASE_SECRET_KEY|sb_secret_|storage_path|sha256|signed_url/i,
    `${name} schema must not expose routing, credentials or private Storage internals`);
  assert.doesNotMatch(
    schema,
    /schema:\s*\{type: object, additionalProperties: false\}\}/,
    `${name} ChatGPT-import schema must not contain an object request schema without properties`,
  );
  assert.doesNotMatch(schema, /fixed OAuth artist binding|artist is fixed by the OAuth client binding/i,
    `${name} import copy must not teach the unified GPT that OAuth client identity selects an Artist`);
  assert.match(schema, /server-owned active Artist context/,
    `${name} import copy must describe the unified GPT server-owned Artist context`);
}

assert.match(core, /operationId: createManualEnquiry[\s\S]{0,200}?summary: Create a manual enquiry in the active GPT artist context/);
assert.match(operations, /operationId: scheduleAppointment[\s\S]{0,200}?summary: Create an appointment in the active GPT artist context/);

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
assert.ok(operationIdsSplit.includes('searchEmailHistory'));
assert.ok(operationIdsSplit.includes('getEmailThread'));
assert.ok(operationIdsSplit.includes('createGmailReplyDraft'));
assert.ok(!coreIds.includes('searchEmailHistory'));
assert.ok(!coreIds.includes('getEmailThread'));
assert.ok(!coreIds.includes('createGmailReplyDraft'));

// The artist context lives in Core, because Core is the schema every Vishar GPT
// imports; an operations-only GPT would otherwise have no way to say who it is
// working as.
assert.ok(coreIds.includes('getArtistContext'), 'the artist context read belongs to the core schema');
assert.ok(coreIds.includes('selectArtistContext'), 'the artist context switch belongs to the core schema');
assert.ok(!operationIdsSplit.includes('getArtistContext'));
assert.ok(!operationIdsSplit.includes('selectArtistContext'));

// Switching whose CRM the model operates on is a confirmed action, and reading
// the available artists is not.
assert.match(core, /operationId: getArtistContext[\s\S]{0,700}?x-openai-isConsequential: false/);
assert.match(core, /operationId: selectArtistContext[\s\S]{0,700}?x-openai-isConsequential: true/);

// The selector takes an artist and nothing else.
assert.match(
  core,
  /operationId: selectArtistContext[\s\S]*?additionalProperties: false\n\s+required: \[artist_id\]\n\s+properties: \{artist_id: \{type: string, format: uuid\}\}/,
  'selectArtistContext must accept exactly one artist id and no other field',
);

console.log('GPT OpenAPI split tests passed: 28 core + 29 operations, distinct action domains, exact 57-operation coverage, artist_id confined to /v1/context and ChatGPT-compatible object schemas.');
