import assert from 'node:assert/strict';
import { PLUGIN_MCP_TOOLS } from '../workers/lib/generated/mcp-plugin-tools.js';

const origin = 'https://mcp.vishartattoo.com';
const issuer = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co/auth/v1';
const version = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} };

async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return response.json();
}

async function rpc(method, params = {}, authorization) {
  return getJson(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'mcp-protocol-version': version, 'mcp-method': method,
      ...(params.name ? { 'mcp-name': params.name } : {}),
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }),
  });
}

const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`);
assert.equal(resource.resource, `${origin}/mcp`);
assert.deepEqual(resource.authorization_servers, [issuer]);
assert.ok(resource.scopes_supported.includes('email'));
console.log('PASS protected resource and exact production issuer');

const authorization = await getJson('https://vfjexhfdbrjmuxfdvbdx.supabase.co/.well-known/oauth-authorization-server/auth/v1');
assert.equal(authorization.issuer, issuer);
assert.ok(authorization.code_challenge_methods_supported.includes('S256'));
assert.ok(authorization.grant_types_supported.includes('refresh_token'));
console.log(JSON.stringify({ authorizationReadiness: {
  pkceS256: true,
  dcrAdvertised: Boolean(authorization.registration_endpoint),
  cimdAdvertised: authorization.client_id_metadata_document_supported === true,
  issuerIdentification: authorization.authorization_response_iss_parameter_supported === true,
} }));

const discovery = await rpc('server/discover');
assert.ok(discovery.result.supportedVersions.includes(version));
console.log('PASS MCP server discovery');

const listing = await rpc('tools/list');
assert.deepEqual(listing.result.tools, PLUGIN_MCP_TOOLS.map(entry => entry.definition));
assert.ok(listing.result.tools.length > 100, 'production serves the broad Plugin tool surface');
console.log(`PASS all ${listing.result.tools.length} production tool definitions and schemas match source`);

const readTool = PLUGIN_MCP_TOOLS.find(entry => entry.definition.annotations?.readOnlyHint === true);
assert.ok(readTool, 'a read-only tool is required for the denied probe');
for (const [label, bearer] of [['unauthenticated', undefined], ['malformed token', 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]) {
  const denied = await rpc('tools/call', { name: readTool.name, arguments: {} }, bearer);
  assert.equal(denied.result.isError, true);
  assert.equal(JSON.parse(denied.result.content[0].text).error, 'authentication_required');
  assert.ok(denied.result._meta['mcp/www_authenticate'].some(challenge => challenge.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource"`)));
  console.log(`PASS ${label} receives an MCP OAuth challenge and no CRM data`);
}

console.log('Read-only bootstrap acceptance passed. Authenticated capability acceptance remains pending.');
