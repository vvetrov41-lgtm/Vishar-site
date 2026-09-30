import assert from 'node:assert/strict';
import { buildPluginTools, parseGeneratedYaml } from './build-mcp-plugin-tools.mjs';
import { handlePluginMcpRequest, __testing as pluginServerTesting } from '../workers/lib/mcp-plugin-server.js';
import { MCP_PROTOCOL_VERSION } from '../workers/lib/mcp-server.js';

const PUBLISHABLE = 'sb_publishable_synthetic_value_1234567890';
const USER = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'plugin-client-1234567890';
const SUPABASE = 'https://exampleproject.supabase.co';
const FORBIDDEN = [
  'artist_id', 'workspace_id', 'oauth_client_id', 'integration_key', 'sql', 'rpc', 'table',
  'access_token', 'refresh_token', 'client_secret', 'service_role', 'api_token', 'authorization',
];
const EXCLUDED = new Set([
  'deleteMyAccount', 'transferWorkspaceOwnership', 'setSelfServiceSignup',
  'getSelfServiceSignupPolicy', 'getControlPlaneAccess', 'inviteStaffMember', 'inviteArtist',
]);

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', exp: now + 3600,
    sub: USER, client_id: CLIENT, ...overrides,
  })}.synthetic-signature`;
}

function env(actionService, overrides = {}) {
  return {
    MCP_ENABLED: 'true',
    MCP_PLUGIN_TOOLS_ENABLED: 'true',
    MCP_PUBLIC_HOST: 'mcp.vishartattoo.com',
    SUPABASE_URL: SUPABASE,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    GPT_ACTIONS_SERVICE: actionService,
    ...overrides,
  };
}

function rpcRequest(method, params = {}, accessToken = token()) {
  const body = {
    jsonrpc: '2.0', id: 1, method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
  });
  if (method === 'tools/call') headers.set('mcp-name', params.name || '');
  return new Request('https://mcp.vishartattoo.com/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

function authFetch(expectedToken = null) {
  return async (url, init = {}) => {
    assert.equal(String(url), `${SUPABASE}/auth/v1/user`);
    assert.equal(init.headers.apikey, PUBLISHABLE);
    if (expectedToken) assert.equal(init.headers.authorization, `Bearer ${expectedToken}`);
    return Response.json({ id: USER });
  };
}

{
  const parsed = parseGeneratedYaml(`openapi: 3.1.0\nservers:\n  - url: https://gpt-actions.vishartattoo.com\n    description: edge\npaths:\n  /v1/example/{id}:\n    post:\n      operationId: updateExample\n      parameters:\n        - {name: id, in: path, required: true, schema: {type: string, format: uuid}}\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [name]\n              properties:\n                name: {type: string, maxLength: 10}\n`);
  assert.equal(parsed.servers[0].url, 'https://gpt-actions.vishartattoo.com');
  assert.equal(parsed.paths['/v1/example/{id}'].post.operationId, 'updateExample');
  assert.equal(parsed.paths['/v1/example/{id}'].post.requestBody.content['application/json'].schema.properties.name.maxLength, 10);
}

const tools = buildPluginTools();
assert(tools.length > 100, `expected a broad unified tool surface, got ${tools.length}`);
assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'MCP tool names are unique');
assert.equal(new Set(tools.map((tool) => tool.operationId)).size, tools.length, 'operation IDs are unique');
assert.equal(new Set(tools.map((tool) => tool.domain)).size, 13, 'all 13 Unified domains are represented');

for (const tool of tools) {
  assert(!EXCLUDED.has(tool.operationId), `${tool.operationId} must stay outside initial Plugin MCP`);
  assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
  assert.equal(tool.definition.inputSchema.type, 'object');
  assert.equal(tool.definition.inputSchema.additionalProperties, false);
  assert.equal(tool.definition.securitySchemes[0].type, 'oauth2');
  assert.deepEqual(tool.definition.securitySchemes[0].scopes, ['email']);
  for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
    assert.equal(typeof tool.definition.annotations[key], 'boolean', `${tool.name}.${key} must be explicit`);
  }
  for (const forbidden of FORBIDDEN) {
    assert(!Object.prototype.hasOwnProperty.call(tool.definition.inputSchema.properties || {}, forbidden), `${tool.name} exposes forbidden ${forbidden}`);
  }
}

const listClients = tools.find((tool) => tool.operationId === 'listClients');
const archiveClient = tools.find((tool) => tool.operationId === 'archiveClient');
const searchWeb = tools.find((tool) => tool.operationId === 'searchWeb');
assert(listClients?.definition.annotations.readOnlyHint);
assert.equal(listClients?.definition.annotations.destructiveHint, false);
assert.equal(archiveClient?.definition.annotations.destructiveHint, true);
assert.equal(searchWeb?.definition.annotations.openWorldHint, true);

{
  const metadata = pluginServerTesting.protectedResourceMetadata(env({ fetch() {} }));
  assert.deepEqual(metadata.authorization_servers, [`${SUPABASE}/auth/v1`]);
  assert.deepEqual(metadata.scopes_supported, ['email']);
  assert.equal(metadata.resource, 'https://mcp.vishartattoo.com/mcp');
}

{
  const invalid = token({ client_id: undefined });
  let authCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/list', {}, invalid),
    env({ async fetch() { throw new Error('must not call action service'); } }),
    async () => { authCalled = true; return Response.json({ id: USER }); },
  );
  assert.equal(response.status, 401);
  assert.equal(authCalled, false, 'obviously invalid OAuth claims fail before network validation');
}

{
  const actionService = { async fetch() { throw new Error('must not call action service during tools/list'); } };
  const response = await handlePluginMcpRequest(rpcRequest('tools/list'), env(actionService), authFetch());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.tools.length, tools.length);
  assert(payload.result.tools.some((tool) => tool.name === 'crm_list_clients'));
  assert(!payload.result.tools.some((tool) => tool.name === 'crm_invite_staff_member'));
}

{
  let actionRequest;
  const accessToken = token();
  const actionService = {
    async fetch(request) {
      actionRequest = request;
      return Response.json({ items: [] });
    },
  };
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }, accessToken),
    env(actionService),
    authFetch(accessToken),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, false);
  assert.equal(payload.result.structuredContent, undefined, 'Plugin tools return content-only until exact output schemas are declared');
  assert.equal(new URL(actionRequest.url).hostname, 'gpt-actions.vishartattoo.com');
  assert.equal(new URL(actionRequest.url).pathname, '/v1/clients');
  assert.equal(new URL(actionRequest.url).searchParams.get('limit'), '10');
  assert.equal(actionRequest.headers.get('authorization'), `Bearer ${accessToken}`);
}

{
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { artist_id: USER } }),
    env({ async fetch() { actionCalled = true; return Response.json({}); } }),
    authFetch(),
  );
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.equal(JSON.parse(payload.result.content[0].text).error, 'unexpected_argument');
  assert.equal(actionCalled, false);
}

console.log(`Plugin MCP tests passed: ${tools.length} generated tools across 13 domains, OAuth actor validation, explicit schemas/annotations, bounded Action-service adapter, initial exclusions preserved.`);
