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
assert.match(config, /^main = "workers\/gpt-actions-production\.js"$/m);
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
assert.match(bootstrap, /OAuth clients created: no/);
assert.match(bootstrap, /GPT client database bindings changed: no/);

assert.match(activate, /PRODUCT_BRANCH: agent\/gpt-production-pkce-bridge/);
assert.match(activate, /release\/private-crm-rc28-gpt-pkce-bridge/);
assert.match(activate, /wrangler secret put GPT_OAUTH_BRIDGE_SECRET/);
assert.match(activate, /openssl rand -hex 32/);
assert.match(activate, /GPT_OAUTH_RELAY_ENABLED:true/);
assert.match(activate, /GPT_ACTIONS_ENABLED:true/);
assert.match(activate, /Supabase S256 PKCE: preserved through encrypted Worker bridge/);
assert.match(activate, /GPT client binding mutation: none/);
assert.doesNotMatch(activate, /configure_gpt_action_client|update\s+crm_private\.gpt_action_clients/i,
  'activation workflow must never create or mutate GPT bindings');

assert.match(openapi, /^openapi: 3\.1\.0$/m);
assert.match(openapi, /url: https:\/\/gpt-actions\.vishartattoo\.com/);
assert.match(openapi, /authorizationUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/authorize/);
assert.match(openapi, /tokenUrl: https:\/\/gpt-actions\.vishartattoo\.com\/oauth\/token/);
assert.doesNotMatch(openapi, /gpt-actions-staging|gwaliusblwrzisrwnsvs/);
assert.doesNotMatch(openapi, /artist_id|service_role|SUPABASE_SECRET_KEY|sb_secret_/);
assert.doesNotMatch(openapi, /#\/components\/parameters\//,
  'ChatGPT path parameters must remain inlined in the production schema');
assert.equal(count(openapi, '- name: appointment_id'), 3,
  'all three appointment path operations must inline appointment_id');
assert.equal(count(openapi, 'x-openai-isConsequential: true'), 3);
assert.equal(count(openapi, 'x-openai-isConsequential: false'), 4);
const operationIds = [...openapi.matchAll(/^\s+operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
assert.deepEqual(operationIds.sort(), [
  'cancelAppointment',
  'checkAppointmentConflicts',
  'getAppointment',
  'listAppointments',
  'rescheduleAppointment',
  'scheduleAppointment',
  'searchAppointmentClients',
].sort());

assert.match(runbook, /fresh live Supabase check/i,
  'runbook must require a fresh live binding check before action activation');
assert.match(runbook, /release\/private-crm-rc26-gpt-actions/);
assert.match(runbook, /release\/private-crm-rc27-gpt-actions-enable/);
assert.match(runbook, /release\/private-crm-rc28-gpt-pkce-bridge/);
assert.match(runbook, /fixed Worker callback/i);
assert.match(runbook, /S256 PKCE/i);
assert.match(runbook, /There is no GPT action for WhatsApp/);

console.log('GPT production config tests passed: inert tracked config, exact release operators, encrypted S256 PKCE bridge, production-only OAuth edge, inline OpenAPI and separate live binding gate.');
