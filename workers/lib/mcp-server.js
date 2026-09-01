import {
  McpDomainError,
  createMcpCrmDomain,
  createSupabaseActorGateway,
  mcpToolDefinitions,
} from './mcp-domain.js';
import {
  GMAIL_TOOL_DEFINITIONS,
  gmailToolByName,
  toMcpToolDefinitions as gmailMcpToolDefinitions,
} from './gmail-tool-contract.js';
import {
  callMetaTool,
  metaToolByName,
  metaToolDefinitions,
} from './mcp-meta-domain.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MCP_PATH = '/mcp';
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'mcp-protocol-version': MCP_PROTOCOL_VERSION,
});
const SERVER_META = Object.freeze({
  name: 'vishar-crm',
  version: '1.0.0',
});

function response(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function rpcError(id, code, message, data = undefined, status = 200) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return response(status, { jsonrpc: '2.0', id: id ?? null, error });
}

function rpcResult(id, result, status = 200) {
  return response(status, { jsonrpc: '2.0', id, result });
}

function configured(env) {
  return env?.MCP_ENABLED === 'true'
    && typeof env?.SUPABASE_URL === 'string'
    && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(env.SUPABASE_URL)
    && typeof env?.SUPABASE_PUBLISHABLE_KEY === 'string'
    && env.SUPABASE_PUBLISHABLE_KEY.length >= 20;
}

function bearer(request) {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/.exec(value);
  return match?.[1] || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('unsupported_media_type');
  const declared = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('parse_error'); }
  if (!isObject(parsed)) throw new Error('invalid_request');
  return parsed;
}

function exactObject(value, allowed) {
  if (!isObject(value)) return [];
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function validateMeta(params) {
  if (!isObject(params)) throw new Error('invalid_params');
  const meta = params._meta;
  if (!isObject(meta)) throw new Error('invalid_meta');
  if (meta['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_VERSION) {
    const error = new Error('unsupported_protocol');
    error.requested = meta['io.modelcontextprotocol/protocolVersion'] ?? null;
    throw error;
  }
  if (!isObject(meta['io.modelcontextprotocol/clientCapabilities'])) throw new Error('invalid_client_capabilities');
  return meta;
}

function validateEnvelope(request, body) {
  if (body.jsonrpc !== '2.0' || (!['string', 'number'].includes(typeof body.id)) || typeof body.method !== 'string') {
    throw new Error('invalid_request');
  }
  const unexpected = exactObject(body, ['jsonrpc', 'id', 'method', 'params']);
  if (unexpected.length) throw new Error('invalid_request');

  const headerVersion = request.headers.get('mcp-protocol-version');
  if (headerVersion !== MCP_PROTOCOL_VERSION) {
    const error = new Error('unsupported_protocol');
    error.requested = headerVersion;
    throw error;
  }

  const methodHeader = request.headers.get('mcp-method');
  if (methodHeader !== body.method) throw new Error('method_header_mismatch');
  validateMeta(body.params);

  if (body.method === 'tools/call') {
    const bodyName = isObject(body.params) ? body.params.name : null;
    if (typeof bodyName !== 'string' || request.headers.get('mcp-name') !== bodyName) {
      throw new Error('tool_header_mismatch');
    }
  }
}

function gmailEnabled(env) {
  return env?.MCP_GMAIL_TOOLS_ENABLED === 'true'
    && env?.GMAIL_SERVICE
    && typeof env.GMAIL_SERVICE.fetch === 'function';
}

function metaEnabled(env) {
  return env?.MCP_META_TOOLS_ENABLED === 'true';
}

function toolDefinitions(env) {
  const tools = mcpToolDefinitions();
  if (gmailEnabled(env)) tools.push(...gmailMcpToolDefinitions());
  if (metaEnabled(env)) tools.push(...metaToolDefinitions());
  return tools;
}

function toolByName(env, name) {
  const core = mcpToolDefinitions().find((tool) => tool.name === name);
  if (core) return { kind: 'core', definition: core };
  if (gmailEnabled(env)) {
    const definition = gmailToolByName(name);
    if (definition) return { kind: 'gmail', definition };
  }
  if (metaEnabled(env)) {
    const definition = metaToolByName(name);
    if (definition) return { kind: 'meta', definition };
  }
  return null;
}

function validateSchemaValue(schema, value, path) {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new McpDomainError('invalid_argument', `${path} must be a string.`);
    if (schema.minLength != null && value.length < schema.minLength) throw new McpDomainError('invalid_argument', `${path} is too short.`);
    if (schema.maxLength != null && value.length > schema.maxLength) throw new McpDomainError('invalid_argument', `${path} is too long.`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) throw new McpDomainError('invalid_argument', `${path} has an invalid format.`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new McpDomainError('invalid_argument', `${path} has an unsupported value.`);
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new McpDomainError('invalid_argument', `${path} must be an integer.`);
    if (schema.minimum != null && value < schema.minimum) throw new McpDomainError('invalid_argument', `${path} is below the allowed range.`);
    if (schema.maximum != null && value > schema.maximum) throw new McpDomainError('invalid_argument', `${path} exceeds the allowed range.`);
  }
}

function validateToolArguments(definition, raw) {
  const args = raw == null ? {} : raw;
  if (!isObject(args)) throw new McpDomainError('invalid_argument', 'Tool arguments must be an object.');
  const schema = definition.inputSchema || { type: 'object', properties: {}, required: [] };
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const forbidden of ['sql', 'query', 'rpc', 'table', 'oauth_client_id', 'integration_key', 'access_token', 'refresh_token', 'client_secret', 'service_role', 'configuration', 'external_account_label', 'body', 'attachments', 'provider_message_id', 'created_by']) {
    if (Object.prototype.hasOwnProperty.call(args, forbidden)) {
      throw new McpDomainError('forbidden_argument', `Argument ${forbidden} is not accepted.`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new McpDomainError('unexpected_argument', `Argument ${key} is not accepted.`);
    }
    validateSchemaValue(properties[key], args[key], key);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) throw new McpDomainError('invalid_argument', `${key} is required.`);
  }
  return args;
}

function safeToolError(error) {
  if (error instanceof McpDomainError) return { error: error.code, message: error.message };
  return { error: 'tool_failed', message: 'The CRM tool could not complete the request.' };
}

function toolResult(value, isError = false) {
  const structuredContent = value == null ? {} : value;
  const text = JSON.stringify(structuredContent);
  return {
    resultType: 'complete',
    content: [{ type: 'text', text }],
    structuredContent,
    isError,
    _meta: {
      'io.modelcontextprotocol/serverInfo': SERVER_META,
    },
  };
}

async function callGmailTool(definition, args, request, env) {
  const enquiryId = args.enquiry_id;
  let url;
  let init;
  if (definition.name === 'crm_email_history_search') {
    url = new URL(`https://gpt-operations.vishartattoo.com/v1/enquiries/${enquiryId}/gmail/history`);
    if (args.thread_limit != null) url.searchParams.set('thread_limit', String(args.thread_limit));
    if (args.message_limit != null) url.searchParams.set('message_limit', String(args.message_limit));
    init = { method: 'GET' };
  } else if (definition.name === 'crm_email_thread_get') {
    url = new URL(`https://gpt-operations.vishartattoo.com/v1/enquiries/${enquiryId}/gmail/threads/${args.thread_context_id}`);
    init = { method: 'GET' };
  } else if (definition.name === 'crm_email_reply_draft_create') {
    url = new URL(`https://gpt-operations.vishartattoo.com/v1/enquiries/${enquiryId}/gmail/reply-drafts`);
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread_context_id: args.thread_context_id, body: args.body }),
    };
  } else {
    throw new McpDomainError('unknown_tool', 'Unknown Gmail tool.', 404);
  }

  const headers = new Headers(init.headers || {});
  headers.set('authorization', request.headers.get('authorization'));
  headers.set('accept', 'application/json');
  const upstream = await env.GMAIL_SERVICE.fetch(new Request(url, { ...init, headers }));
  const text = await upstream.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new McpDomainError('response_too_large', 'The Gmail response exceeded the MCP limit.', 502);
  }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* safe fallback below */ }
  if (!upstream.ok || parsed == null) {
    const error = typeof parsed?.error === 'string' ? parsed.error : 'gmail_unavailable';
    if (upstream.status === 401) throw new McpDomainError('authentication_required', 'CRM authentication is required.', 401);
    if (upstream.status === 403) throw new McpDomainError('permission_denied', 'The signed-in profile cannot use Gmail for that enquiry.', 403);
    if (upstream.status === 409 && error === 'gmail_reconnect_required') throw new McpDomainError('gmail_reconnect_required', 'The Artist Gmail integration must be reconnected.', 409);
    throw new McpDomainError('gmail_unavailable', 'The Gmail tool is temporarily unavailable.', 502);
  }
  return parsed;
}

function discoverResult() {
  return {
    resultType: 'complete',
    supportedVersions: [MCP_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    instructions: 'Use crm_list_artist_contexts before Artist-scoped CRM calls. Artist identifiers are selectors only; every tool re-checks the signed-in profile capability in the CRM.',
    ttlMs: 300000,
    cacheScope: 'private',
    _meta: {
      'io.modelcontextprotocol/serverInfo': SERVER_META,
    },
  };
}

async function dispatch(request, env, body, token, fetchImpl) {
  if (body.method === 'server/discover') {
    const unexpected = exactObject(body.params, ['_meta']);
    if (unexpected.length) return rpcError(body.id, -32602, 'Invalid params.', undefined, 400);
    return rpcResult(body.id, discoverResult());
  }

  if (body.method === 'tools/list') {
    const unexpected = exactObject(body.params, ['_meta', 'cursor']);
    if (unexpected.length || (body.params.cursor != null && body.params.cursor !== '')) {
      return rpcError(body.id, -32602, 'Invalid params.', undefined, 400);
    }
    return rpcResult(body.id, {
      resultType: 'complete',
      tools: toolDefinitions(env),
      ttlMs: 300000,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_META },
    });
  }

  if (body.method === 'tools/call') {
    const unexpected = exactObject(body.params, ['_meta', 'name', 'arguments']);
    if (unexpected.length || typeof body.params.name !== 'string') {
      return rpcError(body.id, -32602, 'Invalid params.', undefined, 400);
    }
    const tool = toolByName(env, body.params.name);
    if (!tool) return rpcError(body.id, -32602, 'Unknown tool.', undefined, 400);
    try {
      const args = validateToolArguments(tool.definition, body.params.arguments || {});
      if (tool.kind === 'gmail') {
        return rpcResult(body.id, toolResult(await callGmailTool(tool.definition, args, request, env)));
      }
      const gateway = createSupabaseActorGateway({
        supabaseUrl: env.SUPABASE_URL,
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
        actorAccessToken: token,
        fetchImpl,
      });
      if (tool.kind === 'meta') {
        return rpcResult(body.id, toolResult(await callMetaTool(gateway, body.params.name, args)));
      }
      const domain = createMcpCrmDomain(gateway);
      return rpcResult(body.id, toolResult(await domain.callTool(body.params.name, args)));
    } catch (error) {
      return rpcResult(body.id, toolResult(safeToolError(error), true));
    }
  }

  return rpcError(body.id, -32601, 'Method not found.');
}

export async function handleMcpRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, '') !== MCP_PATH || request.method !== 'POST') {
    return response(404, { error: 'not_found' });
  }
  if (!configured(env)) return response(404, { error: 'not_found' });

  const token = bearer(request);
  if (!token) {
    return response(401, { error: 'oauth_token_required' }, { 'www-authenticate': 'Bearer' });
  }

  let body;
  try {
    body = await readJson(request);
    validateEnvelope(request, body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_request';
    if (reason === 'body_too_large') return response(413, { error: reason });
    if (reason === 'unsupported_media_type') return response(415, { error: reason });
    if (reason === 'parse_error') return rpcError(null, -32700, 'Parse error.', undefined, 400);
    if (reason === 'unsupported_protocol') {
      return rpcError(body?.id ?? null, -32022, 'Unsupported MCP protocol version.', {
        supported: [MCP_PROTOCOL_VERSION],
        requested: error.requested ?? null,
      }, 400);
    }
    if (reason === 'method_header_mismatch' || reason === 'tool_header_mismatch') {
      return rpcError(body?.id ?? null, -32020, 'MCP request headers do not match the JSON-RPC request.', undefined, 400);
    }
    if (reason === 'invalid_meta' || reason === 'invalid_client_capabilities') {
      return rpcError(body?.id ?? null, -32602, 'Invalid MCP metadata.', undefined, 400);
    }
    return rpcError(body?.id ?? null, -32600, 'Invalid Request.', undefined, 400);
  }

  return dispatch(request, env, body, token, fetchImpl);
}

export const __testing = Object.freeze({
  configured,
  bearer,
  readJson,
  validateEnvelope,
  validateToolArguments,
  gmailEnabled,
  metaEnabled,
  toolDefinitions,
  toolByName,
  callGmailTool,
  discoverResult,
});
