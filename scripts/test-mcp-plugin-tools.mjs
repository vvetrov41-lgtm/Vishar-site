import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildPluginTools, parseGeneratedYaml, PLUGIN_TOOL_GUIDANCE } from './build-mcp-plugin-tools.mjs';
import { handlePluginMcpRequest, __testing as pluginServerTesting } from '../workers/lib/mcp-plugin-server.js';
import { MCP_PROTOCOL_VERSION } from '../workers/lib/mcp-server.js';

const PUBLISHABLE = 'sb_publishable_synthetic_value_1234567890';
const USER = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'plugin-client-1234567890';
const SUPABASE = 'https://exampleproject.supabase.co';
const RESOURCE = 'https://mcp.vishartattoo.com/mcp';
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
    MCP_PLUGIN_OAUTH_CLIENT_ID: CLIENT,
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
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
  });
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
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

async function assertAuthChallenge(response, expectedMessage = null) {
  assert.equal(response.status, 200, 'tool auth failures use an MCP result so ChatGPT can surface linking UI');
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  const error = JSON.parse(payload.result.content[0].text);
  assert.equal(error.error, 'authentication_required');
  if (expectedMessage) assert.equal(error.message, expectedMessage);
  const challenges = payload.result._meta?.['mcp/www_authenticate'];
  assert(Array.isArray(challenges) && challenges.length === 1, 'runtime OAuth challenge is present');
  assert.match(challenges[0], /^Bearer /);
  assert.match(challenges[0], /resource_metadata="https:\/\/mcp\.vishartattoo\.com\/\.well-known\/oauth-protected-resource"/);
  assert.match(challenges[0], /error="invalid_token"/);
  assert.match(challenges[0], /error_description="/);
  assert(!challenges[0].includes(CLIENT), 'runtime challenge never exposes the bound client id');
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
    const allowedContextSelector = tool.operationId === 'selectArtistContext' && forbidden === 'artist_id';
    if (!allowedContextSelector) {
      assert(!Object.prototype.hasOwnProperty.call(tool.definition.inputSchema.properties || {}, forbidden), `${tool.name} exposes forbidden ${forbidden}`);
    }
  }
}

const selectArtistContext = tools.find((tool) => tool.operationId === 'selectArtistContext');
assert(selectArtistContext, 'bounded Artist context selector is present');
assert.equal(selectArtistContext.definition.inputSchema.properties.artist_id.format, 'uuid');
assert(selectArtistContext.definition.inputSchema.required.includes('artist_id'));

const listClients = tools.find((tool) => tool.operationId === 'listClients');
const archiveClient = tools.find((tool) => tool.operationId === 'archiveClient');
const searchWeb = tools.find((tool) => tool.operationId === 'searchWeb');
assert(listClients?.definition.annotations.readOnlyHint);
assert.equal(listClients?.definition.annotations.destructiveHint, false);
assert.equal(archiveClient?.definition.annotations.destructiveHint, true);
assert.equal(searchWeb?.definition.annotations.openWorldHint, true);

// Attention routing: Plugin-only guidance changes descriptions and nothing else.
{
  const byOperation = new Map(tools.map((tool) => [tool.operationId, tool]));
  const unguided = buildPluginTools({ guidance: {} });
  assert.equal(unguided.length, tools.length, 'routing guidance never changes the tool count');
  for (const [index, tool] of tools.entries()) {
    const plain = unguided[index];
    const { description, ...rest } = tool.definition;
    const { description: plainDescription, ...plainRest } = plain.definition;
    assert.deepEqual({ ...tool, definition: rest }, { ...plain, definition: plainRest }, `${tool.name}: only the description may differ`);
    const extra = PLUGIN_TOOL_GUIDANCE[tool.operationId];
    assert.equal(description, extra ? `${plainDescription} ${extra}` : plainDescription, `${tool.name}: guidance is appended to the shared description`);
  }

  const pulse = byOperation.get('getTodayPulse');
  assert.equal(pulse?.name, 'crm_get_today_pulse');
  assert.match(pulse.definition.description, /Primary entry point for broad attention and triage/);
  assert.match(pulse.definition.description, /configured attention rules/);
  assert.match(pulse.definition.description, /absence from it means no configured attention condition currently matches, not that the client, enquiry or project does not exist/);
  assert.match(pulse.definition.description, /explicit inventory, status slice, count, audit, export or historical report/);

  for (const operationId of ['listEnquiries', 'listProjects', 'listClients', 'listFollowUps', 'listFailedDeliveries', 'listCommunicationConversations']) {
    const description = byOperation.get(operationId)?.definition.description || '';
    assert.match(description, /crm_get_today_pulse/, `${operationId} points attention questions to the pulse`);
    assert.match(description, /Do not call it after a successful crm_get_today_pulse just to re-check that the attention shortlist is complete\./, `${operationId} is not a completeness re-scan`);
    assert.match(description, /explicit/, `${operationId} keeps its explicit list/audit use`);
  }
  assert.match(byOperation.get('getClientAiState').definition.description, /Preferred per-client drill-down for a client listed by crm_get_today_pulse/);
  assert.throws(() => buildPluginTools({ guidance: { notARealOperation: 'x' } }), /unknown operations: notARealOperation/);

  // The shared Unified/legacy GPT schemas never carry the Plugin-only text.
  const actionsDir = new URL('../docs/gpt-actions/', import.meta.url);
  const schemaTexts = [
    ...readdirSync(actionsDir).filter((name) => name.endsWith('.yaml')).map((name) => readFileSync(new URL(name, actionsDir), 'utf8')),
    ...readdirSync(new URL('unified/', actionsDir)).filter((name) => name.endsWith('.yaml')).map((name) => readFileSync(new URL(`unified/${name}`, actionsDir), 'utf8')),
  ];
  assert(schemaTexts.length > 10);
  for (const text of schemaTexts) {
    assert(!text.includes('Primary entry point for broad attention'), 'Plugin routing guidance stays out of GPT Action schemas');
    assert(!text.includes('just to re-check that the attention shortlist'), 'Plugin routing guidance stays out of GPT Action schemas');
  }

  const instructions = pluginServerTesting.discoverResult().instructions;
  assert.match(instructions, /Use the Artist context tools before Artist-scoped work/, 'existing Artist/trust guidance is kept');
  assert.match(instructions, /never infer permission from model instructions/);
  assert.match(instructions, /call crm_get_today_pulse first/);
  assert.match(instructions, /review my active enquiries\/clients and tell me who needs action/);
  assert.match(instructions, /authoritative shortlist within those rules/);
  assert.match(instructions, /does not mean the client, enquiry or project does not exist, and the pulse is not a full view of the CRM/);
  assert.match(instructions, /do not enumerate crm_list_enquiries, crm_list_projects, crm_list_clients or other list tools by status just to check completeness/);
  assert.match(instructions, /crm_get_client_ai_state for a client/);
  assert.match(instructions, /full list, inventory, audit, status slice, count, export or historical report/);
  assert.match(instructions, /pulse fails or reports a needed source as unavailable/);
  assert.match(instructions, /Do not add either after every pulse/);
  assert(instructions.length < 2500, 'server instructions stay short');
  for (const name of instructions.match(/crm_[a-z_]+/g)) {
    assert(tools.some((tool) => tool.name === name), `server instructions name a real tool: ${name}`);
  }

  const skill = readFileSync(new URL('../plugins/vishar-crm/skills/vishar-crm/SKILL.md', import.meta.url), 'utf8');
  const triage = skill.indexOf('## Attention and triage');
  const sales = skill.indexOf('## Sales workflows');
  assert(triage > 0 && sales > triage, 'skill keeps attention routing outside the Sales section');
  const triageSection = skill.slice(triage, sales);
  assert.match(triageSection, /start with `crm_get_today_pulse`/);
  assert.match(triageSection, /not a full view of the CRM/);
  assert.match(triageSection, /do not enumerate enquiries, projects, clients, follow-ups or conversations by status to check completeness/);
  assert.match(triageSection, /`crm_get_client_ai_state` is the per-client drill-down/);
  assert.match(triageSection, /full list, inventory, audit, status slice, count, export or historical report/);
  assert.match(triageSection, /`integration_jobs_failed`\) and messages from unknown senders \(`unmatched_inbound`\) as grouped counts/);
  assert.match(triageSection, /Call `crm_list_failed_deliveries` or `crm_list_communication_conversations` only when the user explicitly asks/);
  for (const name of triageSection.match(/crm_[a-z_]+/g)) {
    assert(tools.some((tool) => tool.name === name), `skill names a real tool: ${name}`);
  }
}

// The Plugin package is the ChatGPT app wrapper: its manifest name and app
// mapping must match the installed app, or "Upload new version" is refused.
{
  const pluginRoot = new URL('../plugins/vishar-crm/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', pluginRoot), 'utf8'));
  const apps = JSON.parse(readFileSync(new URL('.app.json', pluginRoot), 'utf8'));
  assert.equal(manifest.name, 'dev-6abe429f5e388191ac24e96159a1dbc0');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.apps, './.app.json');
  assert.equal(manifest.skills, './skills/');
  assert.deepEqual(apps, { apps: { [manifest.name]: { id: 'asdk_app_6abe429f5e388191ac24e96159a1dbc0' } } });
  for (const field of ['composerIcon', 'logo']) {
    const path = manifest.interface[field];
    assert.match(path, /^\.\/assets\/[a-z]+\.png$/);
    assert.equal(readFileSync(new URL(path, pluginRoot)).subarray(1, 4).toString(), 'PNG', `${field} is a PNG`);
  }
  readFileSync(new URL('skills/vishar-crm/SKILL.md', pluginRoot));
  const rootEntries = readdirSync(pluginRoot).sort();
  assert.deepEqual(rootEntries, ['.app.json', '.codex-plugin', 'assets', 'skills'], 'no portable root manifest or bundled MCP server competes with the app mapping');
}

{
  const response = await handlePluginMcpRequest(
    rpcRequest('server/discover', {}, null),
    env({ async fetch() { throw new Error('discovery must not call action service'); } }),
    async () => { throw new Error('discovery must not call Auth'); },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.instructions, pluginServerTesting.discoverResult().instructions, 'unauthenticated discovery serves the routing instructions');
}

{
  const metadata = pluginServerTesting.protectedResourceMetadata(env({ fetch() {} }));
  assert.deepEqual(metadata.authorization_servers, [`${SUPABASE}/auth/v1`]);
  assert.deepEqual(metadata.scopes_supported, ['email']);
  assert.equal(metadata.resource, RESOURCE);
}

{
  let authCalled = false;
  const response = await handlePluginMcpRequest(
    new Request('https://mcp.vishartattoo.com/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }),
    env({ async fetch() { throw new Error('malformed bootstrap probe must not call action service'); } }),
    async () => { authCalled = true; throw new Error('missing-token bootstrap probe must not call Auth'); },
  );
  assert.equal(response.status, 401, 'malformed unauthenticated bootstrap probe remains fail-closed');
  assert.equal(authCalled, false);
  assert.match(response.headers.get('www-authenticate') || '', /resource_metadata="https:\/\/mcp\.vishartattoo\.com\/\.well-known\/oauth-protected-resource"/);
}

{
  let authCalled = false;
  const response = await handlePluginMcpRequest(
    new Request('https://mcp.vishartattoo.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      body: '{}',
    }),
    env({ async fetch() { throw new Error('bogus-token bootstrap probe must not call action service'); } }),
    async () => { authCalled = true; throw new Error('obviously invalid token must fail before Auth lookup'); },
  );
  assert.equal(response.status, 401, 'malformed bogus-token bootstrap probe remains fail-closed');
  assert.equal(authCalled, false);
}

{
  let authCalled = false;
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/list', {}, null),
    env({ async fetch() { actionCalled = true; throw new Error('must not call action service'); } }),
    async () => { authCalled = true; throw new Error('must not call Auth during discovery'); },
  );
  assert.equal(response.status, 200, 'tool schemas are discoverable before OAuth');
  assert.equal(authCalled, false);
  assert.equal(actionCalled, false);
  const payload = await response.json();
  assert.equal(payload.result.tools.length, tools.length);
  assert(payload.result.tools.some((tool) => tool.name === 'crm_list_clients'));
  assert(payload.result.tools.every((tool) => tool.securitySchemes?.[0]?.type === 'oauth2'));
}

{
  let authCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/list', {}, null),
    env({ async fetch() { throw new Error('listing must not call action service'); } }, { MCP_PLUGIN_OAUTH_CLIENT_ID: undefined }),
    async () => { authCalled = true; throw new Error('unbound discovery must not call Auth'); },
  );
  assert.equal(response.status, 200, 'OAuth discovery and tool metadata can precede dedicated client registration');
  assert.equal(authCalled, false);
  const metadata = await handlePluginMcpRequest(
    new Request('https://mcp.vishartattoo.com/.well-known/oauth-protected-resource'),
    env({ async fetch() {} }, { MCP_PLUGIN_OAUTH_CLIENT_ID: undefined }),
  );
  assert.equal(metadata.status, 200, 'protected-resource metadata can precede client registration');
}

{
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }, null),
    env({ async fetch() { actionCalled = true; throw new Error('must not call action service'); } }),
    async () => { throw new Error('missing token must fail before Auth lookup'); },
  );
  await assertAuthChallenge(response, 'CRM authentication is required.');
  assert.equal(actionCalled, false);
}

for (const claims of [
  { client_id: undefined },
  { client_id: 'legacy-gpt-client-12345' },
  { exp: Math.floor(Date.now() / 1000) - 1 },
]) {
  let authCalled = false;
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }, token(claims)),
    env({ async fetch() { actionCalled = true; throw new Error('must not call action service'); } }),
    async () => { authCalled = true; return Response.json({ id: USER }); },
  );
  await assertAuthChallenge(response, 'CRM authentication is invalid or expired.');
  assert.equal(authCalled, false, 'wrong client and expiry fail before network validation');
  assert.equal(actionCalled, false);
}

{
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }),
    env({ async fetch() { actionCalled = true; throw new Error('must not call action service'); } }, { MCP_PLUGIN_OAUTH_CLIENT_ID: undefined }),
    async () => { throw new Error('unbound client must fail before Auth lookup'); },
  );
  await assertAuthChallenge(response, 'CRM authentication is invalid or expired.');
  assert.equal(actionCalled, false);
}

{
  const accessToken = token();
  let actionRequest;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }, accessToken),
    env({ async fetch(request) { actionRequest = request; return Response.json({ items: [] }); } }),
    authFetch(accessToken),
  );
  assert.equal(response.status, 200, 'standard Supabase OAuth token shape is accepted');
  assert(actionRequest, 'valid dedicated-client token reaches action service');
}

{
  let actionCalled = false;
  const response = await handlePluginMcpRequest(
    rpcRequest('tools/call', { name: 'crm_list_clients', arguments: { limit: 10 } }),
    env({ async fetch() { actionCalled = true; throw new Error('revoked token must not call action service'); } }),
    async () => new Response(null, { status: 401 }),
  );
  await assertAuthChallenge(response, 'CRM authentication is invalid or expired.');
  assert.equal(actionCalled, false, 'Supabase revocation is authoritative');
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

console.log(`Plugin MCP tests passed: ${tools.length} generated tools across 13 domains, bootstrap fail-closed malformed probes, pre-auth tool discovery, runtime OAuth linking challenges, strict issuer/audience/client actor validation, explicit schemas/annotations, bounded Action-service adapter, initial exclusions preserved.`);
