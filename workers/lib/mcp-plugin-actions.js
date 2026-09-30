import { PLUGIN_MCP_TOOLS } from './generated/mcp-plugin-tools.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const FORBIDDEN_ARGUMENTS = new Set([
  'artist_id', 'workspace_id', 'oauth_client_id', 'integration_key', 'sql', 'rpc', 'table',
  'access_token', 'refresh_token', 'client_secret', 'service_role', 'api_token', 'authorization',
]);

export class McpPluginActionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'McpPluginActionError';
    this.code = code;
    this.status = status;
  }
}

const BY_NAME = new Map(PLUGIN_MCP_TOOLS.map((entry) => [entry.name, entry]));

export function pluginMcpToolDefinitions() {
  return PLUGIN_MCP_TOOLS.map((entry) => entry.definition);
}

export function pluginMcpToolByName(name) {
  return BY_NAME.get(name) || null;
}

function safeBearer(request) {
  const value = request.headers.get('authorization') || '';
  return /^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(value) ? value : null;
}

function buildActionRequest(entry, args, request) {
  const authorization = safeBearer(request);
  if (!authorization) throw new McpPluginActionError('authentication_required', 'CRM authentication is required.', 401);
  const accepted = new Set([
    ...entry.pathParams,
    ...entry.queryParams,
    ...entry.bodyParams,
  ]);
  for (const name of Object.keys(args)) {
    if (FORBIDDEN_ARGUMENTS.has(name)) throw new McpPluginActionError('forbidden_argument', `Argument ${name} is not accepted.`);
    if (!accepted.has(name)) throw new McpPluginActionError('unexpected_argument', `Argument ${name} is not accepted.`);
  }

  let pathname = entry.path;
  for (const name of entry.pathParams) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) throw new McpPluginActionError('invalid_argument', `${name} is required.`);
    pathname = pathname.replace(`{${name}}`, encodeURIComponent(String(args[name])));
  }
  if (/\{[a-z_]+\}/i.test(pathname)) throw new McpPluginActionError('invalid_argument', 'A path argument is missing.');

  const url = new URL(`https://${entry.host}${pathname}`);
  for (const name of entry.queryParams) {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined && args[name] !== null) {
      const value = args[name];
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(name, String(item)));
      else url.searchParams.set(name, String(value));
    }
  }

  const headers = new Headers({ authorization, accept: 'application/json' });
  const init = { method: entry.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(entry.method)) {
    const body = {};
    for (const name of entry.bodyParams) {
      if (Object.prototype.hasOwnProperty.call(args, name)) body[name] = args[name];
    }
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function safeError(status, payload) {
  if (status === 401) return new McpPluginActionError('authentication_required', 'CRM authentication is required.', 401);
  if (status === 403) return new McpPluginActionError('permission_denied', 'The signed-in CRM profile is not permitted to perform this action.', 403);
  if (status === 404) return new McpPluginActionError('not_found', 'The requested CRM resource or capability is not available.', 404);
  if (status === 409) return new McpPluginActionError('conflict', 'The CRM record changed or the requested action conflicts with current state.', 409);
  if (status === 429) return new McpPluginActionError('rate_limited', 'The CRM action rate limit was reached.', 429);
  if (status >= 400 && status < 500) {
    const code = typeof payload?.error === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(payload.error)
      ? payload.error
      : 'invalid_request';
    const message = typeof payload?.message === 'string' && payload.message.length <= 400
      ? payload.message
      : 'The CRM rejected the requested action.';
    return new McpPluginActionError(code, message, status);
  }
  return new McpPluginActionError('upstream_unavailable', 'The CRM action service is temporarily unavailable.', 502);
}

export async function callPluginMcpTool(entry, args, request, env) {
  if (!entry || !entry.definition) throw new McpPluginActionError('unknown_tool', 'Unknown Vishar CRM tool.', 404);
  if (!env?.GPT_ACTIONS_SERVICE || typeof env.GPT_ACTIONS_SERVICE.fetch !== 'function') {
    throw new McpPluginActionError('action_service_unavailable', 'The CRM action service is not configured.', 503);
  }

  const upstreamRequest = buildActionRequest(entry, args, request);
  let upstream;
  try {
    upstream = await env.GPT_ACTIONS_SERVICE.fetch(upstreamRequest);
  } catch {
    throw new McpPluginActionError('action_service_unavailable', 'The CRM action service is temporarily unavailable.', 502);
  }

  const text = await upstream.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new McpPluginActionError('response_too_large', 'The CRM response exceeded the Plugin MCP limit.', 502);
  }
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new McpPluginActionError('invalid_upstream_response', 'The CRM action service returned an invalid response.', 502); }
  }
  if (!upstream.ok) throw safeError(upstream.status, payload);
  return payload;
}

export const __testing = Object.freeze({ buildActionRequest, safeError, FORBIDDEN_ARGUMENTS });
