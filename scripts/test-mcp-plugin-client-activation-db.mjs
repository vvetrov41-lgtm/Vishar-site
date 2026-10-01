// Disposable CI PostgreSQL only. Never accepts a hosted project or URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { CLIENT, CALLBACK, CEILINGS, inspectSql, activateSql } from './activate-mcp-plugin-client.mjs';
assert.equal(process.env.PGHOST, '127.0.0.1');
assert.equal(process.env.PGDATABASE, 'plugin_config_test');
const run = sql => execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const state = () => JSON.parse(run(inspectSql()));
run(`create schema auth; create schema crm_private;
create table auth.oauth_clients (id uuid primary key, client_type text, redirect_uris text,
 grant_types text, token_endpoint_auth_method text, deleted_at timestamptz);
create table crm_private.gpt_action_clients (id uuid primary key, artist_id uuid, binding_mode text,
 integration_key text unique, display_name text, oauth_client_id text unique, is_active boolean,
 ${Object.keys(CEILINGS).map(c => `${c} boolean`).join(', ')}, updated_at timestamptz default now());
create table public.activity_log (event_type text, actor_kind text, metadata jsonb);
insert into auth.oauth_clients values ('${CLIENT}', 'public', '${CALLBACK}',
 'authorization_code,refresh_token', 'none', null);
insert into crm_private.gpt_action_clients (id, binding_mode, integration_key, is_active,
 ${Object.keys(CEILINGS).join(', ')}) values ('11111111-1111-4111-8111-111111111111',
 'artist', 'legacy', true, ${Object.values(CEILINGS).join(', ')});`);
const before = state();
run(activateSql(before, 'b'.repeat(40)));
const after = state();
assert.equal(after.legacy_fingerprint, before.legacy_fingerprint);
assert.equal(after.plugin.binding_mode, 'profile');
assert.equal(after.plugin.artist_id, null);
assert.equal(after.plugin.oauth_client_id, CLIENT);
assert.equal(after.plugin.can_manage_automations, false);
assert.equal(run('select count(*) from public.activity_log'), '1');
run(activateSql(after, 'b'.repeat(40)));
assert.equal(run('select count(*) from public.activity_log'), '1', 'idempotent retry audit');
assert.equal(state().legacy_fingerprint, before.legacy_fingerprint);
run("update crm_private.gpt_action_clients set display_name='operator change' where integration_key='legacy'");
assert.throws(() => run(activateSql(after, 'b'.repeat(40))), 'stale legacy snapshot denied');
assert.equal(run('select count(*) from public.activity_log'), '1');
const fresh = state();
run(`update auth.oauth_clients set redirect_uris='https://other.example' where id='${CLIENT}'`);
assert.throws(() => run(activateSql(fresh, 'b'.repeat(40))), 'changed OAuth client denied');
assert.equal(run('select count(*) from public.activity_log'), '1');
console.log('Disposable database: activation, legacy preservation, profile binding, disabled ceilings, idempotency and both drift denials passed.');
