// Transport-neutral Vishar CRM MCP domain contracts.
//
// This module deliberately does not authenticate an HTTP request. Phase Q-R
// defines the domain boundary and MCP tool semantics; Phase S-T will bind a
// remote MCP resource to a profile-bound OAuth token with the correct audience.
// The domain client below can only use a human actor token against named RPCs
// and fixed, allow-listed Data API reads. No caller can choose a table, select
// list, RPC name, SQL expression or provider credential.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENQUIRY_STATUSES = new Set([
  'new', 'reviewing', 'waiting_for_client', 'accepted', 'declined',
  'quote_sent', 'deposit_requested', 'deposit_paid', 'converted', 'closed',
]);
const MAX_RESPONSE_BYTES = 256 * 1024;

export class McpDomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'McpDomainError';
    this.code = code;
    this.status = status;
  }
}

function objectOnly(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactArgs(value, allowed) {
  const args = objectOnly(value);
  for (const forbidden of ['sql', 'query', 'rpc', 'table', 'oauth_client_id', 'integration_key', 'access_token']) {
    if (Object.prototype.hasOwnProperty.call(args, forbidden)) {
      throw new McpDomainError('forbidden_argument', `Argument ${forbidden} is not accepted.`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new McpDomainError('unexpected_argument', `Argument ${key} is not accepted.`);
  }
  return args;
}

function requiredUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new McpDomainError('invalid_argument', `${name} must be a UUID.`);
  }
  return value;
}

function optionalStatus(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !ENQUIRY_STATUSES.has(value)) {
    throw new McpDomainError('invalid_argument', 'status is not a supported enquiry status.');
  }
  return value;
}

function boundedInteger(value, name, fallback, max) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new McpDomainError('invalid_argument', `${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function requiredTimestamp(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new McpDomainError('invalid_argument', `${name} must be an ISO date-time.`);
  }
  return value;
}

function safeUpstreamError(status, text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* safe fallback */ }
  const pgCode = typeof parsed?.code === 'string' ? parsed.code : '';
  if (status === 401) return new McpDomainError('authentication_required', 'CRM authentication is required.', 401);
  if (status === 403 || pgCode === '42501') {
    return new McpDomainError('permission_denied', 'The signed-in profile does not have permission for that Artist context.', 403);
  }
  if (pgCode === '23503') return new McpDomainError('record_not_found', 'The CRM record is unavailable.', 404);
  if (status >= 400 && status < 500) return new McpDomainError('invalid_request', 'The CRM rejected the bounded request.', 400);
  return new McpDomainError('crm_unavailable', 'The CRM could not complete the request.', 502);
}

async function readResponse(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new McpDomainError('response_too_large', 'The CRM response exceeded the MCP domain limit.', 502);
  }
  if (!response.ok) throw safeUpstreamError(response.status, text);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new McpDomainError('invalid_crm_response', 'The CRM returned an invalid response.', 502);
  }
}

export function createSupabaseActorGateway({ supabaseUrl, publishableKey, actorAccessToken, fetchImpl = fetch }) {
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl)) {
    throw new Error('invalid_supabase_url');
  }
  if (typeof publishableKey !== 'string' || publishableKey.length < 20) throw new Error('invalid_publishable_key');
  if (typeof actorAccessToken !== 'string' || actorAccessToken.length < 20) throw new Error('invalid_actor_token');

  const headers = Object.freeze({
    authorization: `Bearer ${actorAccessToken}`,
    apikey: publishableKey,
    accept: 'application/json',
  });

  return Object.freeze({
    async rpc(name, payload = {}) {
      // `name` is supplied only by the closed domain functions below. It is not
      // an MCP argument and is never copied from model input.
      const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // `manual`, never the `error` redirect mode: the Workers runtime rejects
        // that mode and throws before the subrequest is dispatched. A redirect
        // arrives here as a 3xx response and is refused as a non-ok status below.
        redirect: 'manual',
      });
      return readResponse(response);
    },

    async select(path, params) {
      // `path` and every SELECT expression are fixed below. Only already-
      // validated scalar values are interpolated through URLSearchParams.
      const url = new URL(`/rest/v1/${path}`, supabaseUrl);
      for (const [key, value] of params) url.searchParams.append(key, value);
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        // `manual`, never the `error` redirect mode: the Workers runtime rejects
        // that mode and throws before the subrequest is dispatched. A redirect
        // arrives here as a 3xx response and is refused as a non-ok status below.
        redirect: 'manual',
      });
      return readResponse(response);
    },
  });
}

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'crm_list_artist_contexts',
    title: 'List CRM Artist contexts',
    description: 'List Artists the signed-in CRM profile can access and the exact capabilities it has on each Artist. Use this before any Artist-scoped tool. Artist IDs returned here are selectors, not credentials.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } } },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'crm_list_enquiries',
    title: 'List enquiries',
    description: 'List safe operational enquiry metadata for one Artist. Requires view_enquiries on that exact Artist.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        artist_id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: [...ENQUIRY_STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['artist_id'],
    },
    outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: false },
  },
  {
    name: 'crm_get_enquiry',
    title: 'Get enquiry',
    description: 'Read one enquiry in one Artist context. The record must belong to the requested Artist and the signed-in profile must have view_enquiries there.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { artist_id: { type: 'string', format: 'uuid' }, enquiry_id: { type: 'string', format: 'uuid' } },
      required: ['artist_id', 'enquiry_id'],
    },
    outputSchema: { type: 'object', properties: { item: { type: ['object', 'null'] } }, required: ['item'], additionalProperties: false },
  },
  {
    name: 'crm_list_projects',
    title: 'List projects',
    description: 'List non-financial project data for one Artist. Requires view_projects on that exact Artist.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { artist_id: { type: 'string', format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['artist_id'],
    },
    outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: false },
  },
  {
    name: 'crm_list_appointments',
    title: 'List appointments',
    description: 'List operational appointment data for one Artist and time range. Requires view_sessions on that exact Artist; finance and provider credentials are excluded.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        artist_id: { type: 'string', format: 'uuid' },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['artist_id', 'from', 'to'],
    },
    outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: false },
  },
  {
    name: 'crm_list_automation_rules',
    title: 'List automation rules',
    description: 'List automation rules for one Artist through the Phase N named RPC. Requires view_automations on that exact Artist.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { artist_id: { type: 'string', format: 'uuid' } },
      required: ['artist_id'],
    },
    outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: false },
  },
]);

export function mcpToolDefinitions() {
  // Keep deterministic ordering for MCP list caching and prompt-cache stability.
  return TOOL_DEFINITIONS.map((tool) => structuredClone(tool));
}

async function requireCapability(gateway, artistId, capability) {
  const rows = await gateway.rpc('list_capabilities', { p_artist_id: artistId });
  if (!Array.isArray(rows) || !rows.some((row) => row?.artist_id === artistId && row?.capability === capability)) {
    throw new McpDomainError('permission_denied', `The signed-in profile lacks ${capability} for that Artist.`, 403);
  }
}

export function createMcpCrmDomain(gateway) {
  return Object.freeze({
    toolDefinitions: mcpToolDefinitions,

    async callTool(name, rawArgs = {}) {
      if (name === 'crm_list_artist_contexts') {
        exactArgs(rawArgs, []);
        const [artists, capabilities] = await Promise.all([
          gateway.rpc('list_accessible_artists', {}),
          gateway.rpc('list_capabilities', { p_artist_id: null }),
        ]);
        const caps = Array.isArray(capabilities) ? capabilities : [];
        const items = (Array.isArray(artists) ? artists : []).map((artist) => ({
          id: artist.id,
          slug: artist.slug,
          display_name: artist.display_name,
          timezone: artist.timezone,
          default_currency: artist.default_currency,
          capabilities: caps
            .filter((cap) => cap?.artist_id === artist.id)
            .map((cap) => cap.capability)
            .filter((cap) => typeof cap === 'string')
            .sort(),
        }));
        return { items };
      }

      if (name === 'crm_list_enquiries') {
        const args = exactArgs(rawArgs, ['artist_id', 'status', 'limit']);
        const artistId = requiredUuid(args.artist_id, 'artist_id');
        const status = optionalStatus(args.status);
        const limit = boundedInteger(args.limit, 'limit', 25, 50);
        await requireCapability(gateway, artistId, 'view_enquiries');
        const params = [
          ['select', 'id,artist_id,client_id,reference_number,status,intake_state,assigned_to,project_type,placement,approximate_size,cover_up,preferred_timing,source,created_at,last_action_at'],
          ['artist_id', `eq.${artistId}`],
          ['intake_state', 'eq.complete'],
          ['archived_at', 'is.null'],
          ['order', 'last_action_at.desc'],
          ['limit', String(limit)],
        ];
        if (status) params.push(['status', `eq.${status}`]);
        const rows = await gateway.select('enquiries', params);
        return { items: Array.isArray(rows) ? rows : [] };
      }

      if (name === 'crm_get_enquiry') {
        const args = exactArgs(rawArgs, ['artist_id', 'enquiry_id']);
        const artistId = requiredUuid(args.artist_id, 'artist_id');
        const enquiryId = requiredUuid(args.enquiry_id, 'enquiry_id');
        await requireCapability(gateway, artistId, 'view_enquiries');
        const rows = await gateway.select('enquiries', [
          ['select', 'id,artist_id,client_id,reference_number,status,intake_state,assigned_to,project_type,placement,approximate_size,cover_up,preferred_timing,idea,source,utm_source,created_at,last_action_at'],
          ['artist_id', `eq.${artistId}`],
          ['id', `eq.${enquiryId}`],
          ['intake_state', 'eq.complete'],
          ['archived_at', 'is.null'],
          ['limit', '1'],
        ]);
        return { item: Array.isArray(rows) && rows.length ? rows[0] : null };
      }

      if (name === 'crm_list_projects') {
        const args = exactArgs(rawArgs, ['artist_id', 'limit']);
        const artistId = requiredUuid(args.artist_id, 'artist_id');
        const limit = boundedInteger(args.limit, 'limit', 25, 50);
        await requireCapability(gateway, artistId, 'view_projects');
        const rows = await gateway.select('projects', [
          ['select', 'id,artist_id,client_id,enquiry_id,status,title,description,estimated_sessions,estimated_hours,deposit_status,created_at,updated_at'],
          ['artist_id', `eq.${artistId}`],
          ['archived_at', 'is.null'],
          ['order', 'updated_at.desc'],
          ['limit', String(limit)],
        ]);
        return { items: Array.isArray(rows) ? rows : [] };
      }

      if (name === 'crm_list_appointments') {
        const args = exactArgs(rawArgs, ['artist_id', 'from', 'to', 'limit']);
        const artistId = requiredUuid(args.artist_id, 'artist_id');
        const from = requiredTimestamp(args.from, 'from');
        const to = requiredTimestamp(args.to, 'to');
        if (Date.parse(to) <= Date.parse(from)) throw new McpDomainError('invalid_argument', 'to must be after from.');
        if (Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1000) {
          throw new McpDomainError('invalid_argument', 'The appointment range may not exceed 366 days.');
        }
        const limit = boundedInteger(args.limit, 'limit', 25, 50);
        await requireCapability(gateway, artistId, 'view_sessions');
        const rows = await gateway.select('sessions', [
          ['select', 'id,artist_id,project_id,client_id,enquiry_id,appointment_type,status,start_at,end_at,duration_hours,calendar_version,notes'],
          ['artist_id', `eq.${artistId}`],
          ['start_at', `lt.${to}`],
          ['end_at', `gt.${from}`],
          ['order', 'start_at.asc'],
          ['limit', String(limit)],
        ]);
        return { items: Array.isArray(rows) ? rows : [] };
      }

      if (name === 'crm_list_automation_rules') {
        const args = exactArgs(rawArgs, ['artist_id']);
        const artistId = requiredUuid(args.artist_id, 'artist_id');
        await requireCapability(gateway, artistId, 'view_automations');
        const rows = await gateway.rpc('list_automation_rules', { p_artist_id: artistId });
        return { items: Array.isArray(rows) ? rows : [] };
      }

      throw new McpDomainError('unknown_tool', `Unknown MCP tool: ${name}`, 404);
    },
  });
}

export const __testing = Object.freeze({
  exactArgs,
  requiredUuid,
  optionalStatus,
  boundedInteger,
  requiredTimestamp,
  requireCapability,
});
