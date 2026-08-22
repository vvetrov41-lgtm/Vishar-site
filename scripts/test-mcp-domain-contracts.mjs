import assert from 'node:assert/strict';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from '../workers/lib/mcp-server.js';
import { mcpToolDefinitions } from '../workers/lib/mcp-domain.js';

const TOKEN = 'header.payload.signature.with.sufficient.length';
const PUBLISHABLE = 'sb_publishable_synthetic_value_1234567890';
const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const ENQUIRY = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';

function env(overrides = {}) {
  return {
    MCP_ENABLED: 'true',
    MCP_GMAIL_TOOLS_ENABLED: 'false',
    SUPABASE_URL: 'https://exampleproject.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    ...overrides,
  };
}

function rpcBody(method, params = {}, id = 1, version = MCP_PROTOCOL_VERSION) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function request(method, params = {}, options = {}) {
  const version = options.version ?? MCP_PROTOCOL_VERSION;
  const body = rpcBody(method, params, options.id ?? 1, options.bodyVersion ?? version);
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'mcp-protocol-version': version,
    'mcp-method': options.methodHeader ?? method,
  });
  if (method === 'tools/call') headers.set('mcp-name', options.nameHeader ?? params.name ?? '');
  if (options.authorization === false) headers.delete('authorization');
  return new Request('https://mcp.example/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function body(response) {
  return response.json();
}

{
  const response = await handleMcpRequest(request('server/discover'), env({ MCP_ENABLED: 'false' }));
  assert.equal(response.status, 404, 'tracked config stays fail-closed until a separate rollout enables MCP');
}

{
  const response = await handleMcpRequest(request('server/discover', {}, { authorization: false }), env());
  assert.equal(response.status, 401);
  assert.equal((await body(response)).error, 'oauth_token_required');
  assert.match(response.headers.get('www-authenticate') || '', /Bearer/i);
}

{
  const response = await handleMcpRequest(request('server/discover', {}, { version: '2025-11-25' }), env());
  assert.equal(response.status, 400);
  const json = await body(response);
  assert.equal(json.error.code, -32022);
  assert.deepEqual(json.error.data.supported, [MCP_PROTOCOL_VERSION]);
}

{
  const response = await handleMcpRequest(request('tools/list', {}, { methodHeader: 'server/discover' }), env());
  assert.equal(response.status, 400);
  assert.equal((await body(response)).error.code, -32020);
}

{
  const response = await handleMcpRequest(request('server/discover'), env());
  assert.equal(response.status, 200);
  const json = await body(response);
  assert.equal(json.result.resultType, 'complete');
  assert.deepEqual(json.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
  assert.deepEqual(json.result.capabilities, { tools: {} });
  assert.equal(json.result.cacheScope, 'private');
}

{
  const response = await handleMcpRequest(request('tools/list'), env());
  assert.equal(response.status, 200);
  const json = await body(response);
  const names = json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, mcpToolDefinitions().map((tool) => tool.name));
  assert(names.includes('crm_list_artist_contexts'));
  assert(!names.some((name) => /send/i.test(name)), 'core MCP surface has no direct message-send tool');
  const serialized = JSON.stringify(json.result.tools);
  assert.doesNotMatch(serialized, /oauth_client_id|integration_key|access_token|refresh_token|client_secret|service_role|\bsql\b|\brpc\b/i);
}

{
  const service = {
    async fetch() { throw new Error('not called during tools/list'); },
  };
  const response = await handleMcpRequest(request('tools/list'), env({ MCP_GMAIL_TOOLS_ENABLED: 'true', GMAIL_SERVICE: service }));
  const json = await body(response);
  const names = json.result.tools.map((tool) => tool.name);
  assert(names.includes('crm_email_history_search'));
  assert(names.includes('crm_email_thread_get'));
  assert(names.includes('crm_email_reply_draft_create'));
  assert(!names.some((name) => /^crm_email_.*send/i.test(name)), 'Gmail MCP projection still exposes draft creation, never direct send');
}

{
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.apikey, PUBLISHABLE);
    if (String(url).endsWith('/rpc/list_accessible_artists')) {
      return Response.json([{ id: ARTIST, slug: 'vladimir', display_name: 'Vladimir', timezone: 'Europe/London', default_currency: 'GBP' }]);
    }
    if (String(url).endsWith('/rpc/list_capabilities')) {
      return Response.json([
        { artist_id: ARTIST, capability: 'view_enquiries' },
        { artist_id: ARTIST, capability: 'view_projects' },
      ]);
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  const response = await handleMcpRequest(
    request('tools/call', { name: 'crm_list_artist_contexts', arguments: {} }),
    env(),
    fetchImpl,
  );
  assert.equal(response.status, 200);
  const json = await body(response);
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.items[0].id, ARTIST);
  assert.deepEqual(json.result.structuredContent.items[0].capabilities, ['view_enquiries', 'view_projects']);
  assert.equal(calls.length, 2);
  assert(calls.every((call) => !String(call.init.headers.apikey).startsWith('sb_secret_')));
}

{
  let called = false;
  const response = await handleMcpRequest(
    request('tools/call', {
      name: 'crm_list_enquiries',
      arguments: { artist_id: ARTIST, sql: 'select * from secrets' },
    }),
    env(),
    async () => { called = true; throw new Error('must not call upstream'); },
  );
  const json = await body(response);
  assert.equal(response.status, 200);
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent.error, 'forbidden_argument');
  assert.equal(called, false, 'forbidden model arguments are rejected before any Data API call');
}

{
  const response = await handleMcpRequest(
    request('tools/call', { name: 'crm_list_enquiries', arguments: { artist_id: ARTIST } }, { nameHeader: 'crm_get_enquiry' }),
    env(),
  );
  assert.equal(response.status, 400);
  assert.equal((await body(response)).error.code, -32020);
}

{
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/rpc/list_capabilities')) return Response.json([]);
    throw new Error('table read must not happen without capability');
  };
  const response = await handleMcpRequest(
    request('tools/call', { name: 'crm_list_enquiries', arguments: { artist_id: ARTIST } }),
    env(),
    fetchImpl,
  );
  const json = await body(response);
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent.error, 'permission_denied');
  assert.equal(calls.length, 1, 'artist_id is a selector only; capability is checked before the scoped row read');
}

{
  let serviceRequest;
  const service = {
    async fetch(req) {
      serviceRequest = req;
      return Response.json({ enquiry_id: ENQUIRY, threads: [], untrusted_content: true });
    },
  };
  const response = await handleMcpRequest(
    request('tools/call', {
      name: 'crm_email_history_search',
      arguments: { enquiry_id: ENQUIRY, thread_limit: 3, message_limit: 10 },
    }),
    env({ MCP_GMAIL_TOOLS_ENABLED: 'true', GMAIL_SERVICE: service }),
  );
  const json = await body(response);
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.untrusted_content, true);
  const url = new URL(serviceRequest.url);
  assert.equal(url.hostname, 'gpt-operations.vishartattoo.com');
  assert.equal(url.pathname, `/v1/enquiries/${ENQUIRY}/gmail/history`);
  assert.equal(url.searchParams.get('thread_limit'), '3');
  assert.equal(url.searchParams.get('message_limit'), '10');
  assert.equal(serviceRequest.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(url.searchParams.has('artist_id'), false);
}

{
  let serviceRequest;
  const service = {
    async fetch(req) {
      serviceRequest = req;
      return Response.json({ draft_id: '33333333-3333-4333-8333-333333333333', status: 'draft' });
    },
  };
  const response = await handleMcpRequest(
    request('tools/call', {
      name: 'crm_email_reply_draft_create',
      arguments: { enquiry_id: ENQUIRY, thread_context_id: THREAD, body: 'Draft reply only' },
    }),
    env({ MCP_GMAIL_TOOLS_ENABLED: 'true', GMAIL_SERVICE: service }),
  );
  const json = await body(response);
  assert.equal(json.result.isError, false);
  assert.equal(serviceRequest.method, 'POST');
  assert.equal(new URL(serviceRequest.url).pathname, `/v1/enquiries/${ENQUIRY}/gmail/reply-drafts`);
  assert.deepEqual(await serviceRequest.json(), { thread_context_id: THREAD, body: 'Draft reply only' });
}

{
  const service = {
    async fetch() {
      return Response.json({ error: 'provider_secret_internal_detail' }, { status: 403 });
    },
  };
  const response = await handleMcpRequest(
    request('tools/call', {
      name: 'crm_email_thread_get',
      arguments: { enquiry_id: ENQUIRY, thread_context_id: THREAD },
    }),
    env({ MCP_GMAIL_TOOLS_ENABLED: 'true', GMAIL_SERVICE: service }),
  );
  const json = await body(response);
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent.error, 'permission_denied');
  assert.doesNotMatch(JSON.stringify(json), /provider_secret_internal_detail/);
}

console.log('MCP domain tests passed: stateless 2026-07-28 transport, auth wall, capability-scoped Artist selectors, bounded CRM/Gmail tools, no arbitrary DB/provider escape hatch.');
