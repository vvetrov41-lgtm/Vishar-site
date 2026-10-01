import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'vfjexhfdbrjmuxfdvbdx';
export const CLIENT = '3b5c6da9-cac4-4720-ad47-5188136a5534';
export const CALLBACK = 'https://chatgpt.com/connector/oauth/Zp0oAlOEMkKx';
export const KEY = 'vishar-crm-plugin';
const ID = 'c4444444-4444-4444-8444-444444444444';
// Preserve the enabled legacy ceilings. These remain ceilings, never grants:
// profile/workspace/Artist membership and each RPC capability are authoritative.
export const CEILINGS = Object.freeze({
  can_read_appointments: true, can_manage_appointments: true,
  can_read_enquiries: true, can_manage_crm: true, can_manage_finance: true,
  can_manage_communications: true, can_use_web_research: true,
  can_use_cloudflare_control: true, can_manage_automations: false,
  can_manage_integrations: false, can_administer_workspace: false,
});
const columns = Object.keys(CEILINGS);
const expected = { id: ID, artist_id: null, binding_mode: 'profile',
  integration_key: KEY, display_name: 'Vishar CRM Plugin', oauth_client_id: CLIENT,
  is_active: true, ...CEILINGS };
const projection = Object.keys(expected).join(', ');
const snapshot = `select md5(coalesce(jsonb_agg(to_jsonb(c) order by c.id)::text, '[]'))
  from crm_private.gpt_action_clients c where c.integration_key <> '${KEY}'`;
const expectedSql = `'${JSON.stringify(expected)}'::jsonb`;

export function inspectSql() {
  return `select jsonb_build_object(
    'client', (select jsonb_build_object('id', id, 'client_type', client_type,
      'redirect_uris', redirect_uris, 'grant_types', grant_types,
      'token_endpoint_auth_method', token_endpoint_auth_method, 'deleted', deleted_at is not null)
      from auth.oauth_clients where id = '${CLIENT}'::uuid),
    'legacy_fingerprint', (${snapshot}),
    'legacy_ceilings', (select jsonb_build_object(${columns.map(c => `'${c}', bool_or(${c})`).join(', ')})
      from crm_private.gpt_action_clients where is_active and binding_mode = 'artist'),
    'plugin', (select to_jsonb(p) from (select ${projection}
      from crm_private.gpt_action_clients where integration_key = '${KEY}') p)
  ) as state;`;
}

export function validateState(state) {
  assert.equal(state?.client?.id, CLIENT, 'reviewed OAuth client must exist');
  assert.equal(state.client.deleted, false, 'OAuth client must not be deleted');
  assert.equal(state.client.client_type, 'public');
  assert.equal(state.client.token_endpoint_auth_method, 'none');
  assert.equal(state.client.redirect_uris, CALLBACK, 'exact callback required');
  assert.deepEqual(state.client.grant_types.split(',').sort(), ['authorization_code', 'refresh_token']);
  assert.match(state.legacy_fingerprint, /^[a-f0-9]{32}$/);
  assert.deepEqual(state.legacy_ceilings, CEILINGS, 'legacy ceilings drifted; refuse expansion');
  if (state.plugin !== null) assert.deepEqual(state.plugin, expected, 'existing Plugin config differs; never overwrite');
  return state;
}

export function activateSql(state, sha) {
  validateState(state);
  assert.match(sha, /^[a-f0-9]{40}$/);
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';
lock table crm_private.gpt_action_clients in share row exclusive mode;
do $activation$
declare v_plugin jsonb;
begin
  if (${snapshot}) <> '${state.legacy_fingerprint}' then
    raise exception 'Legacy client config changed after preflight';
  end if;
  if not exists (select 1 from auth.oauth_clients where id = '${CLIENT}'::uuid
    and deleted_at is null and client_type = 'public' and token_endpoint_auth_method = 'none'
    and redirect_uris = '${CALLBACK}' and grant_types = 'authorization_code,refresh_token') then
    raise exception 'Reviewed OAuth client drifted after preflight';
  end if;
  select to_jsonb(p) into v_plugin from (select ${projection}
    from crm_private.gpt_action_clients where integration_key = '${KEY}') p;
  if v_plugin is not null and v_plugin <> ${expectedSql} then
    raise exception 'Existing Plugin binding differs; refusing overwrite';
  end if;
  if v_plugin is null then
    insert into crm_private.gpt_action_clients (${projection}) values (
      '${ID}', null, 'profile', '${KEY}', 'Vishar CRM Plugin', '${CLIENT}', true,
      ${Object.values(CEILINGS).join(', ')});
    insert into public.activity_log (event_type, actor_kind, metadata) values (
      'gpt.plugin_client_activated', 'system', jsonb_build_object(
        'integration', '${KEY}', 'binding_mode', 'profile', 'source_sha', '${sha}'));
  end if;
  if (${snapshot}) <> '${state.legacy_fingerprint}' then
    raise exception 'Legacy client configuration unexpectedly changed';
  end if;
end;
$activation$;
commit;
${inspectSql()}`;
}

export async function query(sql, env, fetcher = fetch) {
  assert.equal(env.SUPABASE_PROJECT_REF, PROJECT);
  assert.equal(env.SUPABASE_URL, `https://${PROJECT}.supabase.co`);
  assert.ok(env.SUPABASE_ACCESS_TOKEN, 'configured management credential required');
  const response = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  // Do not echo provider errors, headers, SQL or credential-bearing responses.
  assert.equal(response.status, 200, `Supabase config operation failed (HTTP ${response.status})`);
  const result = await response.json();
  assert.equal(result.length, 1, 'exactly one safe state row required');
  return validateState(result[0].state);
}

async function main() {
  const [mode, planPath] = process.argv.slice(2);
  assert.ok(['plan', 'apply', 'verify'].includes(mode));
  assert.match(process.env.APPROVED_SHA || '', /^[a-f0-9]{40}$/);
  if (mode === 'plan') {
    assert.ok(planPath, 'plan path required');
    const state = await query(inspectSql(), process.env);
    writeFileSync(planPath, JSON.stringify(state), { mode: 0o600 });
    console.log('PASS exact public OAuth client, callback and unchanged legacy capability ceilings');
  } else if (mode === 'apply') {
    assert.ok(planPath, 'reviewed plan path required');
    const state = JSON.parse(readFileSync(planPath, 'utf8'));
    const after = await query(activateSql(state, process.env.APPROVED_SHA), process.env);
    assert.deepEqual(after.plugin, expected);
    assert.equal(after.legacy_fingerprint, state.legacy_fingerprint);
    console.log('PASS dedicated profile binding activated; all legacy client rows unchanged');
  } else {
    const after = await query(inspectSql(), process.env);
    assert.deepEqual(after.plugin, expected);
    console.log('PASS production Plugin binding and bounded ceilings read back');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Plugin config preflight/apply/readback failed; refusing further changes.'); process.exitCode = 1; });
}
