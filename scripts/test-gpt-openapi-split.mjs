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
const importedBySchema = [coreIds, operationsIds, communicationsIds];
const combined = importedBySchema.flat();

assert.equal(canonical.length, 66, 'canonical GPT schema must keep exactly 66 operations');
assert.equal(coreIds.length, 28, 'Core currently contains 28 operations and still needs the next repartition step');
assert.equal(operationsIds.length, 19, 'Operations must contain exactly 19 non-communications operations after extraction');
assert.equal(communicationsIds.length, 19, 'Communications must contain the ten provider-thread operations plus the nine unified inbox operations');
for (const [name, ids] of [['core', coreIds], ['operations', operationsIds], ['communications', communicationsIds]]) {
  assert.ok(ids.length <= 30, `${name} ChatGPT-import schema must stay at or below the editor 30-operation hard limit`);
}
assert.ok(coreIds.length > 25, 'Core should remain explicitly visible as the next <=25 repartition target');
assert.ok(operationsIds.length <= 25);
assert.ok(communicationsIds.length <= 25);
assert.equal(new Set(combined).size, 66, 'split schemas must not duplicate operation IDs');
assert.deepEqual([...combined].sort(), [...canonical].sort(), 'three split schemas must cover the exact canonical 66-operation surface');

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
  'production GPT Worker must expose exactly three custom domains for the three current ChatGPT Action sets');

// /v1/context is the single reviewed exception to the artist_id ban. It is a
// server-authorized selector, never ordinary business routing input.
function withoutContextPath(schema) {
  return schema.replace(/^ {2}\/v1\/context:\n(?: {3,}.*\n|\n(?= {3,}\S))*/m, '');
}

for (const [name, schema] of [['core', core], ['operations', operations], ['communications', communications]]) {
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

const noPayloadOperations = [
  'markCommunicationConversationRead',
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
for (const id of ['listAppointments', 'recordManualPayment', 'listActivity']) assert.ok(operationsIds.includes(id));

const communicationIds = [
  'listCommunicationConversations',
  'getCommunicationConversation',
  'listCommunicationMessages',
  'sendCommunicationReply',
  'markCommunicationConversationRead',
  'setCommunicationConversationState',
  'linkCommunicationConversationClient',
  'createClientFromCommunication',
  'createEnquiryFromCommunication',
  'getWhatsAppConversation',
  'ensureWhatsAppConversation',
  'listWhatsAppMessages',
  'sendWhatsAppMessage',
  'searchEmailHistory',
  'getEmailThread',
  'createGmailReplyDraft',
  'listEmailMessages',
  'createEmailDraft',
  'approveEmailDraft',
];
for (const id of communicationIds) {
  assert.ok(communicationsIds.includes(id), `${id} must live in Communications`);
  assert.ok(!operationsIds.includes(id), `${id} must not remain in the Operations import`);
  assert.ok(!coreIds.includes(id), `${id} must not appear in Core`);
}

// The Artist context lives in Core because it is the shared selector for the
// one Unified GPT. Other schemas reuse the authenticated server-owned context.
assert.ok(coreIds.includes('getArtistContext'), 'the artist context read belongs to Core');
assert.ok(coreIds.includes('selectArtistContext'), 'the artist context switch belongs to Core');
assert.ok(!operationsIds.includes('getArtistContext'));
assert.ok(!operationsIds.includes('selectArtistContext'));
assert.ok(!communicationsIds.includes('getArtistContext'));
assert.ok(!communicationsIds.includes('selectArtistContext'));
assert.match(core, /operationId: getArtistContext[\s\S]{0,700}?x-openai-isConsequential: false/);
assert.match(core, /operationId: selectArtistContext[\s\S]{0,700}?x-openai-isConsequential: true/);
assert.match(
  core,
  /operationId: selectArtistContext[\s\S]*?additionalProperties: false\n\s+required: \[artist_id\]\n\s+properties: \{artist_id: \{type: string, format: uuid\}\}/,
  'selectArtistContext must accept exactly one artist id and no other field',
);

assert.match(communications, /operationId: sendWhatsAppMessage[\s\S]*?explicitly requested the exact message/);
assert.match(communications, /operationId: approveEmailDraft[\s\S]*?explicitly approves the draft content/);
assert.match(communications, /operationId: createGmailReplyDraft[\s\S]*?draft state only/);
assert.match(communications, /operationId: sendCommunicationReply[\s\S]*?explicitly requested the exact message/);
assert.match(communications, /operationId: listCommunicationMessages[\s\S]*?untrusted third-party content/,
  'the unified inbox read must teach that inbound message content is untrusted');
// The inbox routes name a conversation. The channel, provider account and
// destination stay server-side, exactly as the WhatsApp routes already do.
assert.doesNotMatch(communications, /name: (?:channel|provider|integration|account)_(?:id|key)\b/,
  'no inbox operation may accept a provider account or routing selector');

console.log('GPT OpenAPI split tests passed: 28 Core + 19 Operations + 19 Communications, exact 66-operation coverage, shared OAuth/context and safe migration headroom.');
