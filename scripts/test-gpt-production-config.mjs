import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../wrangler.gpt-actions.production.toml', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../.github/workflows/gpt-production-bootstrap.yml', import.meta.url), 'utf8');
const activate = readFileSync(new URL('../.github/workflows/gpt-production-activate.yml', import.meta.url), 'utf8');
const workerRollout = readFileSync(new URL('../.github/workflows/gpt-production-worker-rollout.yml', import.meta.url), 'utf8');
const openapi = readFileSync(new URL('../docs/gpt-actions/openapi.production.yaml', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/crm/gpt-actions-production-runbook.md', import.meta.url), 'utf8');
const instructions = readFileSync(new URL('../docs/gpt-actions/instructions.v2.md', import.meta.url), 'utf8');
const onboardingSkill = readFileSync(new URL('../.agents/skills/vishar-gpt-production-onboarding/SKILL.md', import.meta.url), 'utf8');
const v2Spec = readFileSync(new URL('../specs/unified-gpt-v2/spec.md', import.meta.url), 'utf8');
const v2Plan = readFileSync(new URL('../specs/unified-gpt-v2/plan.md', import.meta.url), 'utf8');
const v2Tasks = readFileSync(new URL('../specs/unified-gpt-v2/tasks.md', import.meta.url), 'utf8');

function count(text, value) {
  return text.split(value).length - 1;
}

// Current production transport configuration remains tightly bounded. This is
// current-state validation, not a declaration that two Action domains are the
// final Unified GPT product architecture.
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

// The reusable production Worker rollout authorizes the intentional live config
// transition with its explicit preflight/readback boundary. Wrangler --strict
// cannot express that reviewed transition and must not be reintroduced on the
// real deploy command.
const workerPreflight = workerRollout.indexOf('Fresh read-only Cloudflare preflight');
const workerDeploy = workerRollout.indexOf('Deploy the GPT Worker from the approved canonical source');
const workerReadback = workerRollout.indexOf('Production readback and acceptance');
assert.ok(workerPreflight >= 0, 'GPT Worker rollout must have a fresh Cloudflare preflight');
assert.ok(workerDeploy > workerPreflight, 'GPT Worker deploy must happen after the Cloudflare preflight');
assert.ok(workerReadback > workerDeploy, 'GPT Worker readback must happen after deploy');
assert.doesNotMatch(workerRollout, /wrangler deploy[^\n]*--strict/,
  'real GPT Worker deploy must not use Wrangler --strict after the explicit fail-closed preflight');
assert.match(workerRollout, /WEB_RESEARCH_ENABLED:true/);
assert.match(workerRollout, /WEB_RESEARCH_SEARCH_ENABLED:true/);
assert.match(workerRollout, /WEB_RESEARCH_SCRAPE_ENABLED:true/);
assert.match(workerRollout, /FIRECRAWL_API_KEY/);
assert.match(workerRollout, /Unexpected GPT production rate-limit binding/);
assert.match(workerRollout, /Unexpected Gmail service binding/);
assert.match(workerRollout, /Unexpected production GPT domain topology/);

// Historical operator workflows remain pinned to their original rollout branches.
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

// Current canonical monolith is the exact 66-operation runtime contract.
assert.match(openapi, /^openapi: 3\.1\.0$/m);
assert.match(openapi, /^  version: 2\.1\.0-production$/m);
assert.match(openapi, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(openapi, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
assert.match(openapi, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
assert.doesNotMatch(openapi, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);

const openapiWithoutContext = openapi.replace(/^ {2}\/v1\/context:\n(?: {3,}.*\n|\n(?= {3,}\S))*/m, '');
assert.ok(openapi.includes('/v1/context:') && !openapiWithoutContext.includes('/v1/context:'),
  'the artist-context carve-out must actually remove /v1/context before the artist_id ban is applied');
assert.doesNotMatch(openapiWithoutContext, /\bartist_id\b/i,
  'no CRM business action may name an artist outside /v1/context');
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
  'listCommunicationConversations', 'getCommunicationConversation',
  'listCommunicationMessages', 'sendCommunicationReply',
  'markCommunicationConversationRead', 'setCommunicationConversationState',
  'linkCommunicationConversationClient', 'createClientFromCommunication',
  'createEnquiryFromCommunication',
];
const nonConsequential = new Set([
  'listClients', 'searchAppointmentClients', 'getClient', 'listEnquiries', 'getEnquiry',
  'getEnquiryFull', 'listArtistStaff', 'listProjects', 'getProject',
  'getProjectFinance', 'listInternalNotes', 'listFollowUps', 'listAppointments',
  'checkAppointmentConflicts', 'getAppointment', 'getAppointmentFull',
  'listAvailability', 'listPaymentRequests', 'getWhatsAppConversation',
  'listWhatsAppMessages', 'listEmailMessages', 'searchEmailHistory', 'getEmailThread',
  'listEnquiryFiles', 'listProjectFiles', 'listActivity', 'getArtistContext',
  'listCommunicationConversations', 'getCommunicationConversation',
  'listCommunicationMessages',
]);
const operationIds = [...openapi.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
assert.deepEqual(operationIds.sort(), [...expectedOperations].sort());
assert.equal(operationIds.length, 66, 'current canonical GPT runtime contract must expose exactly 66 named operations');
assert.equal(count(openapi, 'x-openai-isConsequential: false'), nonConsequential.size);
assert.equal(count(openapi, 'x-openai-isConsequential: true'), expectedOperations.length - nonConsequential.size);
for (const operationId of expectedOperations) {
  const expected = nonConsequential.has(operationId) ? 'false' : 'true';
  assert.match(openapi,
    new RegExp(`operationId: ${operationId}\\n(?:.*\\n){0,4}\\s+x-openai-isConsequential: ${expected}`),
    `${operationId} must have the correct consequential classification`);
}
assert.match(openapi, /operationId: recordManualPayment[\s\S]*?Confirm exact amount with the user/);
assert.match(openapi, /operationId: sendWhatsAppMessage[\s\S]*?explicitly requested the exact message/);
assert.match(openapi, /operationId: approveEmailDraft[\s\S]*?explicitly approves the draft content/);
assert.match(openapi, /operationId: createGmailReplyDraft[\s\S]*?draft/);
assert.match(openapi, /operationId: sendCommunicationReply[\s\S]*?explicitly requested the exact message/);

// Unified identity, rollback and OAuth invariants stay unchanged.
assert.match(runbook, /one profile-bound Vishar GPT/i);
assert.match(runbook, /vishar-unified-gpt/);
assert.match(runbook, /binding_mode = profile/);
assert.match(runbook, /artist_id = null/);
assert.match(runbook, /OAuth client identifies the \*\*application\*\*, not an Artist/i);
assert.match(runbook, /legacy.*rollback/i);
assert.match(runbook, /vladimir-gpt-actions/);
assert.match(runbook, /kristina-gpt-actions/);
assert.match(runbook, /historical operator workflows/i);
assert.match(runbook, /not the Unified GPT v2 activation procedure/i);
assert.match(runbook, /fresh readback/i);
assert.match(runbook, /fixed Worker callback/i);
assert.match(runbook, /S256 PKCE/i);
assert.doesNotMatch(runbook, /Each private GPT has its own confidential Supabase OAuth client/i,
  'production runbook must not return to one OAuth client per Artist as the target model');

// The operator docs must now distinguish the current two-schema transport from
// the full modular product target, so another rollout cannot mistake 28+29 for
// finished CRM coverage.
assert.match(runbook, /current deployed\/importable surface/i);
assert.match(runbook, /not the final Unified GPT product boundary/i);
assert.match(runbook, /Communications must return to a separate semantic domain/i);
assert.match(runbook, /operator-parity inventory/i);
assert.match(runbook, /hard repository ceiling: no imported schema above 30 operations/i);
assert.match(runbook, /target: keep each semantic domain at or below 25 operations/i);
assert.match(runbook, /Gmail/);
assert.match(runbook, /WhatsApp/);
assert.match(runbook, /Instagram/);
assert.match(runbook, /Google Calendar/);
assert.match(runbook, /Monzo/);
assert.match(runbook, /Telegram/);
assert.match(runbook, /Firecrawl \/ Web Research/);

// Model instructions handle ambiguity, confirmations and transport uncertainty
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

// Agent/operator guidance carries the same modular target.
assert.match(onboardingSkill, /profile-bound/);
assert.match(onboardingSkill, /OAuth client id identifies the application, never an Artist/i);
assert.match(onboardingSkill, /Keep them active while unified GPT is being activated and accepted/i);
assert.match(onboardingSkill, /historical evidence, not as the v2 activation path/i);
assert.match(onboardingSkill, /Do not weaken S256 PKCE/);
assert.match(onboardingSkill, /operator-parity inventory/i);
assert.match(onboardingSkill, /current Core \+ Operations pair is a deployed transport snapshot, not a permanent two-schema requirement/i);
assert.match(onboardingSkill, /CRM Core/);
assert.match(onboardingSkill, /Scheduling/);
assert.match(onboardingSkill, /Finance/);
assert.match(onboardingSkill, /Communications/);
assert.match(onboardingSkill, /Automation & Notifications/);
assert.match(onboardingSkill, /Integrations & Admin/);
assert.match(onboardingSkill, /Research/);

// Durable Spec Kit target is full operator parity, modular Actions and future
// transport-neutral MCP/App, while current 66 operations remain current-state evidence.
assert.match(v2Spec, /Product principle: operator parity/i);
assert.match(v2Spec, /full authorized CRM operator coverage/i);
assert.match(v2Spec, /Gmail/);
assert.match(v2Spec, /WhatsApp/);
assert.match(v2Spec, /Instagram/);
assert.match(v2Spec, /Google Calendar/);
assert.match(v2Spec, /Monzo/);
assert.match(v2Spec, /Telegram/);
assert.match(v2Spec, /Project Web References/);
assert.match(v2Spec, /persistent generic Research/i);
assert.match(v2Spec, /MUST maintain an explicit operator-parity matrix/i);
assert.match(v2Spec, /MUST NOT disable or mutate the two legacy artist-bound clients in the same step/);
assert.match(v2Plan, /restore Communications as a separate schema/i);
assert.match(v2Plan, /Target import size: <=25 operations/i);
assert.match(v2Plan, /future Vishar MCP\/App/i);
assert.match(v2Tasks, /Build canonical operator-parity inventory/i);
assert.match(v2Tasks, /Restore a dedicated Communications import schema/i);
assert.match(v2Tasks, /Web Research and Project Web References/i);
assert.match(v2Tasks, /Transport-neutral MCP\/App surface/i);

console.log('GPT production config tests passed: current 66-operation transport remains bounded while Unified GPT target is profile-bound, modular, parity-driven, provider-isolated and rollback-safe.');