import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../.github/workflows/gpt-production-bootstrap.yml', import.meta.url), 'utf8');
const activate = readFileSync(new URL('../.github/workflows/gpt-production-activate.yml', import.meta.url), 'utf8');
const openapi = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/crm/gpt-actions-production-runbook.md', import.meta.url), 'utf8');
const instructions = readFileSync(new URL('../docs/gpt-actions/instructions.v2.md', import.meta.url), 'utf8');
const onboardingSkill = readFileSync(new URL('../.agents/skills/vishar-gpt-production-onboarding/SKILL.md', import.meta.url), 'utf8');
const v2Spec = readFileSync(new URL('../specs/unified-gpt-v2/spec.md', import.meta.url), 'utf8');

function count(text, value) {
  return text.split(value).length - 1;
}

assert.match(config, /^name = "vishar-gpt-actions-production"$/m);
assert.match(config, /^main = "workers\/gpt-actions-production-full\.js"$/m);
assert.match(config, /^workers_dev = false$/m);
assert.match(config, /^preview_urls = false$/m);
assert.match(config, /pattern = "gpt-actions\.vishartattoo\.com", custom_domain = true/);
assert.match(config, /pattern = "gpt-operations\.vishartattoo\.com", custom_domain = true/);
assert.match(config, /name = "GPT_RATE_LIMIT"/);
assert.match(config, /GPT_ACTIONS_ENABLED = "false"/);
assert.match(config, /GPT_OAUTH_RELAY_ENABLED = "false"/);
assert.match(config, /SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"/);
assert.doesNotMatch(config, /GPT_OAUTH_BRIDGE_SECRET|gwaliusblwrzisrwnsvs|service_role|SUPABASE_SECRET|sb_secret_/);

// Historical operator workflows remain pinned to their original rollout branches.
// Unified GPT v2 must not reuse them by moving an old release ref; the current
// runbook and onboarding skill state that boundary explicitly.
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
  'historical activation workflow must never create or mutate GPT bindings');

assert.match(openapi, /^openapi: 3\.1\.0$/m);
assert.match(openapi, /^  version: 2\.1\.0-production$/m);
assert.match(openapi, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(openapi, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
assert.match(openapi, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
assert.doesNotMatch(openapi, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);

// /v1/context is the single reviewed exception: it selects which artist the
// signed-in CRM user is currently working as, and the database re-checks that
// user's membership before honouring it. No CRM action may name an artist.
const openapiWithoutContext = openapi.replace(/^ {2}\/v1\/context:\n(?: {3,}.*\n|\n(?= {3,}\S))*/m, '');
assert.ok(openapi.includes('/v1/context:') && !openapiWithoutContext.includes('/v1/context:'),
  'the artist-context carve-out must actually remove the /v1/context path before the ban is applied');
assert.doesNotMatch(openapiWithoutContext, /\bartist_id\b/i,
  'no CRM action may name an artist outside /v1/context');
assert.doesNotMatch(openapi, /oauth_client_id|integration_key|service_role|SUPABASE_SECRET_KEY|sb_secret_|storage_path|sha256|signed_url/i,
  'production GPT schema must not expose routing, credentials or private Storage internals');
assert.doesNotMatch(openapi, /submitted_email|submitted_phone|submitted_instagram|submitted_travelling_from/,
  'production GPT schema must not expose duplicate raw enquiry contact snapshots');
assert.doesNotMatch(openapi, /#\/components\/parameters\//,
  'ChatGPT path parameters must remain inlined in the production schema');

const expectedOperations = [
  'listClients', 'searchAppointmentClients', 'getClient', 'updateClient',
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
  'createEmailDraft', 'approveEmailDraft', 'searchEmailHistory', 'getEmailThread',
  'createGmailReplyDraft', 'listEnquiryFiles', 'listProjectFiles', 'listActivity',
  'getArtistContext', 'selectArtistContext',
];
const consequentialReads = new Set([
  'listClients', 'searchAppointmentClients', 'getClient', 'listEnquiries', 'getEnquiry',
  'getEnquiryFull', 'listArtistStaff', 'listProjects', 'getProject',
  'getProjectFinance', 'listInternalNotes', 'listFollowUps', 'listAppointments',
  'checkAppointmentConflicts', 'getAppointment', 'getAppointmentFull',
  'listAvailability', 'listPaymentRequests', 'getWhatsAppConversation',
  'listWhatsAppMessages', 'listEmailMessages', 'searchEmailHistory', 'getEmailThread',
  'listEnquiryFiles', 'listProjectFiles', 'listActivity', 'getArtistContext',
]);

const operationIds = [...openapi.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
assert.deepEqual(operationIds.sort(), [...expectedOperations].sort());
assert.equal(operationIds.length, 57, 'full production GPT contract must expose exactly 57 named operations');
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
assert.match(openapi, /operationId: createGmailReplyDraft[\s\S]*?draft/);
assert.match(openapi, /operationId: listEnquiryFiles[\s\S]*?Does not expose Storage paths/);

// Unified GPT v2 target identity is now part of the repository contract.
assert.match(runbook, /one profile-bound Vishar GPT/i);
assert.match(runbook, /vishar-unified-gpt/);
assert.match(runbook, /binding_mode = profile/);
assert.match(runbook, /artist_id = null/);
assert.match(runbook, /OAuth client identifies the \*\*application\*\*, not an Artist/i);
assert.match(runbook, /legacy.*rollback/i);
assert.match(runbook, /vladimir-gpt-actions/);
assert.match(runbook, /kristina-gpt-actions/);
assert.match(runbook, /instructions\.v2\.md/);
assert.match(runbook, /historical operator workflows/i);
assert.match(runbook, /not the Unified GPT v2 activation procedure/i);
assert.match(runbook, /fresh readback/i);
assert.match(runbook, /fixed Worker callback/i);
assert.match(runbook, /S256 PKCE/i);
assert.match(runbook, /can_manage_crm/);
assert.match(runbook, /can_manage_finance/);
assert.match(runbook, /can_manage_communications/);
assert.doesNotMatch(runbook, /Each private GPT has its own confidential Supabase OAuth client/i,
  'production runbook must not return to one OAuth client per Artist as the target model');
assert.doesNotMatch(runbook, /Required production rows:\s*[\s\S]{0,250}vladimir-gpt-actions[\s\S]{0,250}kristina-gpt-actions/i,
  'legacy Artist clients must not be documented as the required target production set');

// Model instructions must handle ambiguity, confirmations and transport uncertainty
// without pretending to be an authorization boundary.
assert.match(instructions, /getArtistContext/);
assert.match(instructions, /selectArtistContext/);
assert.match(instructions, /Never invent, guess or reuse an Artist identifier/i);
assert.match(instructions, /Read before write/i);
assert.match(instructions, /Manual payment recording/i);
assert.match(instructions, /Outbound client message/i);
assert.match(instructions, /Email approval/i);
assert.match(instructions, /ambiguous timeout or transport failure/i);
assert.match(instructions, /re-read the authoritative CRM state/i);
assert.match(instructions, /Notification\/Template Studio/);
assert.match(instructions, /Web Research/);
assert.doesNotMatch(instructions, /service[_ -]?role key|sb_secret_[A-Za-z0-9]+/i);

// Agent/operator guidance must encode the same architecture instead of reviving
// the historical per-Artist production skill.
assert.match(onboardingSkill, /profile-bound/);
assert.match(onboardingSkill, /OAuth client id identifies the application, never an Artist/i);
assert.match(onboardingSkill, /Keep them active while unified GPT is being activated and accepted/i);
assert.match(onboardingSkill, /historical evidence, not as the v2 activation path/i);
assert.match(onboardingSkill, /Do not weaken S256 PKCE/);

// The durable feature spec keeps future features on this same identity boundary.
assert.match(v2Spec, /one Vishar CRM GPT/i);
assert.match(v2Spec, /Future Notification\/Template and Web Research actions MUST reuse the same profile\/context\/capability boundary/);
assert.match(v2Spec, /MUST NOT disable or mutate the two legacy artist-bound clients in the same step/);

console.log('GPT production config tests passed: unified profile-bound target, production-only OAuth edge, 57 bounded CRM actions, explicit Artist context, legacy rollback, and v2 model/operator guidance.');