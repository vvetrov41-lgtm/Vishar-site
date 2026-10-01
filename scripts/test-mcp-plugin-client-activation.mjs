import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENT, CALLBACK, PROJECT, CEILINGS, inspectSql, validateState, activateSql, query } from './activate-mcp-plugin-client.mjs';

const state = { client: { id: CLIENT, client_type: 'public', deleted: false,
  redirect_uris: CALLBACK, grant_types: 'authorization_code,refresh_token', token_endpoint_auth_method: 'none' },
  legacy_fingerprint: 'a'.repeat(32), legacy_ceilings: { ...CEILINGS }, plugin: null };
let checks = 0;
assert.equal(validateState(state), state); checks++;
for (const patch of [
  { client: { ...state.client, id: 'other' } },
  { client: { ...state.client, deleted: true } },
  { client: { ...state.client, client_type: 'confidential' } },
  { client: { ...state.client, token_endpoint_auth_method: 'client_secret_basic' } },
  { client: { ...state.client, redirect_uris: CALLBACK + ',https://other.example/' } },
  { client: { ...state.client, grant_types: 'implicit' } },
  { legacy_ceilings: { ...CEILINGS, can_manage_automations: true } },
  { legacy_fingerprint: "';delete from public.clients;--" },
  { plugin: { binding_mode: 'artist' } },
]) { assert.throws(() => validateState({ ...state, ...patch })); checks++; }
assert.throws(() => activateSql(state, "';bad")); checks++;
const sql = activateSql(state, 'b'.repeat(40));
assert.match(sql, /lock table crm_private\.gpt_action_clients/); checks++;
assert.match(sql, /Legacy client config changed after preflight/); checks++;
assert.match(sql, /Existing Plugin binding differs; refusing overwrite/); checks++;
assert.match(sql, /gpt\.plugin_client_activated/); checks++;
assert.match(sql, /'profile', 'vishar-crm-plugin'/); checks++;
assert.doesNotMatch(sql, /\b(?:update|delete|alter|create|drop|grant|revoke)\s/i); checks++;
assert.doesNotMatch(inspectSql(), /client_secret|access_token|refresh_token_hash|public\.(clients|appointments|payments|deposits)/); checks++;
const env = { SUPABASE_PROJECT_REF: PROJECT, SUPABASE_URL: `https://${PROJECT}.supabase.co`, SUPABASE_ACCESS_TOKEN: 'synthetic' };
let calls = 0;
const fetcher = async (url, options) => {
  calls++;
  assert.equal(url, `https://api.supabase.com/v1/projects/${PROJECT}/database/query`);
  assert.equal(options.redirect, 'error');
  return Response.json([{ state }]);
};
await query(inspectSql(), env, fetcher); checks++;
await query(inspectSql(), env, async () => Response.json([{ state }], { status: 201 })); checks++;
for (const status of [401, 403, 429, 500]) {
  await assert.rejects(query(inspectSql(), env, async () => new Response('private provider response', { status })), error => !error.message.includes('private')); checks++;
}
for (const patch of [{ SUPABASE_PROJECT_REF: 'staging' }, { SUPABASE_URL: 'https://other.example' }, { SUPABASE_ACCESS_TOKEN: '' }]) {
  await assert.rejects(query(inspectSql(), { ...env, ...patch }, fetcher)); checks++;
}
assert.equal(calls, 1); checks++;
await assert.rejects(query(inspectSql(), env, async () => new Response('private provider response', { status: 403 })), error => !error.message.includes('private')); checks++;
const workflow = readFileSync('.github/workflows/mcp-plugin-production-activation.yml', 'utf8');
assert.ok(workflow.indexOf('plan "$RUNNER_TEMP/plugin-client-plan.json"') < workflow.indexOf('Re-check canonical immediately before mutation')); checks++;
assert.ok(workflow.indexOf('apply "$RUNNER_TEMP/plugin-client-plan.json"') > workflow.indexOf('Production readback and live closed-access probe')); checks++;
assert.match(workflow, /Database config: dedicated profile binding; legacy rows unchanged/); checks++;
console.log(`Plugin client activation: ${checks} checks passed.`);
