#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __testing, handleMcpRequest, MCP_PROTOCOL_VERSION } from '../workers/lib/mcp-server.js';

const DORMANT = fs.readFileSync('wrangler.mcp.toml', 'utf8');
const PRODUCTION = fs.readFileSync('wrangler.mcp.production.toml', 'utf8');
const HOST = 'mcp.vishartattoo.com';
const SUPABASE_URL = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const TOKEN = 'a'.repeat(48);

let passes = 0;
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function env(overrides = {}) {
  return {
    VISHAR_ENVIRONMENT: 'production',
    MCP_PUBLIC_HOST: HOST,
    MCP_ENABLED: 'true',
    MCP_META_TOOLS_ENABLED: 'true',
    MCP_GMAIL_TOOLS_ENABLED: 'false',
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'x'.repeat(24),
    ...overrides,
  };
}

function rpc(method, params = {}, { token = TOKEN, name = null } = {}) {
  const headers = {
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (name) headers['mcp-name'] = name;
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      ...params,
    },
  };
  return new Request(`https://${HOST}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

await test('tracked production config keeps every activation flag fail-closed', async () => {
  for (const flag of ['MCP_ENABLED', 'MCP_GMAIL_TOOLS_ENABLED', 'MCP_META_TOOLS_ENABLED']) {
    assert.match(PRODUCTION, new RegExp(`^${flag} = "false"$`, 'm'), `${flag} must ship disabled`);
    assert.match(DORMANT, new RegExp(`^${flag} = "false"$`, 'm'), `${flag} must stay disabled in the dormant config`);
  }
  assert.match(PRODUCTION, /workers_dev = false/);
  assert.match(PRODUCTION, /preview_urls = false/);
});

await test('production carries exactly one custom domain and a per-actor rate limit', async () => {
  assert.equal((PRODUCTION.match(/custom_domain = true/g) || []).length, 1);
  assert.match(PRODUCTION, /pattern = "mcp\.vishartattoo\.com", custom_domain = true/);
  assert.match(PRODUCTION, /name = "MCP_RATE_LIMIT"/);
  assert.match(PRODUCTION, /simple = \{ limit = 60, period = 60 \}/);
  assert.ok(!DORMANT.includes('custom_domain'), 'the dormant config must stay routeless');
});

await test('no privileged credential is referenced by either config', async () => {
  for (const config of [DORMANT, PRODUCTION]) {
    for (const forbidden of ['SERVICE_ROLE', 'SECRET_KEY', 'service_role', 'ACCESS_TOKEN', 'CLIENT_SECRET']) {
      assert.ok(!config.includes(forbidden), `${forbidden} must never appear in MCP config`);
    }
  }
  assert.match(PRODUCTION, /SUPABASE_URL = "https:\/\/vfjexhfdbrjmuxfdvbdx\.supabase\.co"/);
});

await test('protected-resource metadata points at the CRM authorization server', async () => {
  const response = await handleMcpRequest(
    new Request(`https://${HOST}/.well-known/oauth-protected-resource`),
    env(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resource, `https://${HOST}/mcp`);
  assert.deepEqual(body.authorization_servers, [SUPABASE_URL]);
  assert.deepEqual(body.bearer_methods_supported, ['header']);
  assert.deepEqual(body.scopes_supported, ['crm.read']);
});

await test('the resource identifier ignores client-supplied Host headers', async () => {
  const response = await handleMcpRequest(
    new Request('https://attacker.example/.well-known/oauth-protected-resource', {
      headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
    }),
    env(),
  );
  const body = await response.json();
  assert.equal(body.resource, `https://${HOST}/mcp`, 'the resource must come from deployment config only');
  assert.equal(__testing.resourceIdentifier({ MCP_PUBLIC_HOST: 'not a host' }), null);
  assert.equal(__testing.resourceIdentifier({}), null);
});

await test('an unauthenticated call returns an RFC 9728 challenge', async () => {
  const response = await handleMcpRequest(rpc('tools/list', {}, { token: null }), env());
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.vishartattoo\.com\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenge, /error="invalid_token"/);
});

await test('discovery and MCP stay fail-closed while MCP_ENABLED is false', async () => {
  for (const path of ['/.well-known/oauth-protected-resource', '/mcp']) {
    const request = path === '/mcp'
      ? rpc('tools/list')
      : new Request(`https://${HOST}${path}`);
    const response = await handleMcpRequest(request, env({ MCP_ENABLED: 'false' }));
    assert.equal(response.status, 404, `${path} must be invisible while MCP is disabled`);
  }
});

await test('the rate limit key is a hash, never the raw actor token', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  await __testing.enforceRateLimit({ MCP_RATE_LIMIT: limiter }, TOKEN);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^mcp:[0-9a-f]{32}$/);
  assert.ok(!keys[0].includes(TOKEN), 'the raw bearer must never become a rate-limit key');
});

await test('an exhausted rate limit fails closed before any CRM read', async () => {
  let upstream = 0;
  const response = await handleMcpRequest(
    rpc('tools/list'),
    env({ MCP_RATE_LIMIT: { limit: async () => ({ success: false }) } }),
    async () => { upstream += 1; return new Response('[]'); },
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'rate_limited');
  assert.equal(upstream, 0, 'no CRM call may happen once rate limited');
});

await test('activated Meta tools are read-only and expose no write surface', async () => {
  const response = await handleMcpRequest(rpc('tools/list'), env());
  const { result } = await response.json();
  const names = result.tools.map((tool) => tool.name);
  assert.ok(names.includes('crm_meta_integration_health_get'));
  assert.ok(names.includes('crm_meta_message_status_list'));
  for (const name of names) {
    assert.ok(
      !/(send|create|update|delete|reply|retry|draft|write|disconnect|rotate)/.test(name),
      `MCP must expose no write tool, found ${name}`,
    );
  }
});

await test('Meta tools disappear when their own flag is off', async () => {
  const response = await handleMcpRequest(rpc('tools/list'), env({ MCP_META_TOOLS_ENABLED: 'false' }));
  const { result } = await response.json();
  const names = result.tools.map((tool) => tool.name);
  assert.ok(!names.some((name) => name.startsWith('crm_meta_')));
});

await test('Gmail MCP stays off unless separately enabled', async () => {
  const response = await handleMcpRequest(rpc('tools/list'), env());
  const { result } = await response.json();
  assert.ok(!result.tools.some((tool) => tool.name.startsWith('crm_email_')));
  assert.match(PRODUCTION, /^MCP_GMAIL_TOOLS_ENABLED = "false"$/m);
});

console.log(`\nMCP production config: ${passes} passed, ${failures} failed.`);
if (failures) process.exit(1);
console.log('MCP production config tests passed: fail-closed flags, single custom domain, hashed per-actor rate limit, RFC 9728 boundary and read-only Meta tools.');
