import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../.github/workflows/gpt-production-bootstrap.yml', import.meta.url), 'utf8');
const activate = readFileSync(new URL('../.github/workflows/gpt-production-activate.yml', import.meta.url), 'utf8');
const openapi = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/crm/gpt-actions-production-runbook.md', import.meta.url), 'utf8');

function count(text, value) {
  return text.split(value).length - 1;
}

assert.match(config, /^name = "vishar-gpt-actions-production"$/m);
assert.match(config, /^main = "workers\/gpt-actions-production-full\.js"$/m);
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /pattern = "gpt-actions\.vishartattoo\.com", custom_domain = true/);
assert.match(config, /name = "GPT_RATE_LIMIT"/);
assert.match(config, /GPT_ACTIONS_ENABLED = "false"/);
assert.match(config, /GPT_OAUTH_RELAY_ENABLED = "false"/);
assert.match(config, /SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"/);
assert.doesNotMatch(config, /GPT_OAUTH_BRIDGE_SECRET|gwaliusblwrzisrwnsvs|service_role|SUPABASE_SECRET|sb_secret_/);

for (const workflow of [bootstrap, activate]) {
  assert.match(workflow, /environment: crm-production/);
  assert.match(workflow, /git ls-remote origin "refs\/heads\/\$PRODUCT_BRANCH"/);
  assert.match(workflow, /CRM_PRODUCTION_SUPABASE_URL/);
  assert.match(workflow, /CRM_PRODUCTION_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(workflow, /CRM_PRODUCTION_CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /npm run scan:secrets/);
  assert.match(workflow, /gpt-actions\.vishartattoo\.com/);
  assert.doesNotMatch(workflow, /pull_request|refs\/pull\/|STAGING_SUPABASE_DB_PASSWORD|gwaliusblwrzisrwnsvs/);
}

assert.match(bootstrap, /PRODUCT_BRANCH: agent\/gpt-production-actions/);
assert.match(bootstrap, /release\/private-crm-rc26-gpt-actions/);
assert.match(bootstrap, /oauth_server_enabled:true/);
assert.match(bootstrap, /oauth_server_allow_dynamic_registration:false/);
assert.match(bootstrap, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.match(bootstrap, /GPT_ACTIONS_ENABLED:false/);

assert.match(activate, /PRODUCT_BRANCH: agent\/gpt-production-pkce-bridge/);
assert.match(activate, /release\/private-crm-rc28-gpt-pkce-bridge/);
assert.match(activate, /wrangler secret put GPT_OAUTH_BRIDGE_SECRET/);
assert.match(activate, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.match(activate, /GPT_ACTIONS_ENABLED:true/);
assert.doesNotMatch(activate, /configure_gpt_action_client|update\s+crm_private\.gpt_action_clients/i,
  'activation workflow must never create or mutate GPT bindings');

assert.match(openapi, /^openapi: 3\.1\.0$/m);
assert.match(openapi, /^  version: 2\.0\.0-production$/m);
assert.match(openapi, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(openapi, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
assert.match(openapi, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
assert.doesNotMatch(openapi, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);
assert.doesNotMatch(openapi, /\bartist_id\b|oauth_client_id|integration_key|service_role|SUPABASE_SECRET_KEY|sb_secret_|storage_path|sha256|signed_url/i,
  'production GPT schema must not expose routing, credentials or private Storage internals');
assert.doesNotMatch(openapi, /submitted_email|submitted_phone|submitted_instagram|submitted_travelling_from/,
  'production GPT schema must not expose duplicate raw enquiry contact snapshots');
assert.doesNotMatch(openapi, /#\/components\/parameters\//,
  'ChatGPT path parameters must remain inlined in the production schema');

const expectedOperations = [
  'searchAppointmentClients', 'getClient', 'updateClient',
  'listEnquiries', 'createManualEnquiry', 'getEnquiry', 'updateEnquiry',
  'getEnquiryFull', 'setEnquiryStatus', 'listArtistStaff', 'assignEnquiry',
  'convertEnquiryToProject', 'listProjects', 'getProject', 'updateProject',
  'setProjectStatus', 'getProjectFinance', 'updateProjectEstimate',
  'updateProjectDeposit', 'listInternalNotes', 'createInternalNote',
  'listFollowUps', 'createFollowUp', 'completeFollowUp', 'cancelFollowUp',
  'listAppointments', 'scheduleAppointment', 'checkAppointmentConflicts',
  'getAppointment', 'getAppointmentFull', 'rescheduleAppointment',
  'cancelAppointment', 'setAppointmentStatus', 'listAvailability',
  'createAvailability', 'updateAvailability', 'cancelAvailability',
  'listPaymentRequests', 'requestSessionDeposit', 'cancelPaymentRequest',
  'recordManualPayment', 'getWhatsAppConversation', 'ensureWhatsAppConversation',
  'listWhatsAppMessages', 'sendWhatsAppMessage', 'listEmailMessages',
  'createEmailDraft', 'approveEmailDraft', 'listEnquiryFiles',
  'listProjectFiles', 'listActivity',
];
const consequentialReads = new Set([
  'searchAppointmentClients', 'getClient', 'listEnquiries', 'getEnquiry',
  'getEnquiryFull', 'listArtistStaff', 'listProjects', 'getProject',
  'getProjectFinance', 'listInternalNotes', 'listFollowUps', 'listAppointments',
  'checkAppointmentConflicts', 'getAppointment', 'getAppointmentFull',
  'listAvailability', 'listPaymentRequests', 'getWhatsAppConversation',
  'listWhatsAppMessages', 'listEmailMessages', 'listEnquiryFiles',
  'listProjectFiles', 'listActivity',
]);

const operationIds = [...openapi.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
assert.deepEqual(operationIds.sort(), [...expectedOperations].sort());
assert.equal(operationIds.length, 51, 'full production GPT contract must expose exactly 51 named operations');
assert.equal(count(openapi, 'x-openai-isConsequential: false'), consequentialReads.size);
assert.equal(count(openapi, 'x-openai-isConsequential: true'), expectedOperations.length - consequentialReads.size);

for (const operationId of expectedOperations) {
  const expected = consequentialReads.has(operationId) ? 'false' : 'true';
  assert.match(
    openapi,
    new RegExp(`operationId: ${operationId}\\n(?:.*\\n){0,4}\\s+x-openai-isConsequential: ${expected}`),
    `${operationId} must have the correct consequential classification`,
  );
}

assert.match(openapi, /operationId: getEnquiryFull[\s\S]*?canonical client contact details/);
assert.match(openapi, /operationId: recordManualPayment[\s\S]*?Confirm exact amount with the user/);
assert.match(openapi, /operationId: sendWhatsAppMessage[\s\S]*?explicitly requested the exact message/);
assert.match(openapi, /operationId: approveEmailDraft[\s\S]*?explicitly approves the draft content/);
assert.match(openapi, /operationId: listEnquiryFiles[\s\S]*?Does not expose Storage paths/);

assert.match(runbook, /fresh live Supabase check/i,
  'runbook must require a fresh live binding check before action activation');
assert.match(runbook, /release\/private-crm-rc26-gpt-actions/);
assert.match(runbook, /release\/private-crm-rc28-gpt-pkce-bridge/);
assert.match(runbook, /fixed Worker callback/i);
assert.match(runbook, /S256 PKCE/i);
assert.match(runbook, /full management/i);
assert.match(runbook, /can_manage_crm/);
assert.match(runbook, /can_manage_finance/);
assert.match(runbook, /can_manage_communications/);

console.log('GPT production config tests passed: production-only OAuth edge and 51 fixed-artist operational CRM actions.');
