// Read-only Meta diagnostics for the Vishar CRM MCP boundary.
//
// This module deliberately reads CRM-owned diagnostic state through the same
// human actor token and RLS boundary as the core MCP domain. It never calls
// Meta directly, never accepts provider credentials, and never exposes message
// bodies, attachments, external account labels or provider message IDs.

import { McpDomainError } from './mcp-domain.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_CHANNELS = new Set(['whatsapp', 'instagram']);
const MESSAGE_STATUSES = new Set(['received', 'queued', 'sent', 'delivered', 'read', 'failed']);
const FORBIDDEN_ARGUMENTS = new Set([
  'sql', 'query', 'rpc', 'table',
  'oauth_client_id', 'integration_key', 'access_token', 'refresh_token', 'client_secret', 'service_role',
  'configuration', 'external_account_label', 'body', 'attachments', 'provider_message_id', 'created_by',
]);

function objectOnly(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactArgs(value, allowed) {
  const args = objectOnly(value);
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_ARGUMENTS.has(key)) {
      throw new McpDomainError('forbidden_argument', `Argument ${key} is not accepted.`);
    }
    if (!allowed.includes(key)) {
      throw new McpDomainError('unexpected_argument', `Argument ${key} is not accepted.`);
    }
  }
  return args;
}

function requiredUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new McpDomainError('invalid_argument', `${name} must be a UUID.`);
  }
  return value;
}

function optionalEnum(value, name, allowed) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new McpDomainError('invalid_argument', `${name} has an unsupported value.`);
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

async function requireCapability(gateway, artistId, capability) {
  const rows = await gateway.rpc('list_capabilities', { p_artist_id: artistId });
  if (!Array.isArray(rows) || !rows.some((row) => row?.artist_id === artistId && row?.capability === capability)) {
    throw new McpDomainError('permission_denied', `The signed-in profile lacks ${capability} for that Artist.`, 403);
  }
}

export const META_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'crm_meta_integration_health_get',
    title: 'Get Meta integration health',
    description: 'Read CRM-side WhatsApp and Instagram connection health for one Artist. Requires manage_integrations. This does not expose Meta credentials or make provider calls.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { artist_id: { type: 'string', format: 'uuid' } },
      required: ['artist_id'],
    },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } } },
      required: ['items'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'crm_meta_message_status_list',
    title: 'List Meta message delivery status',
    description: 'List bounded WhatsApp and Instagram message delivery metadata for one Artist. Requires view_communications. Message bodies, attachments and provider message IDs are excluded.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artist_id: { type: 'string', format: 'uuid' },
        channel: { type: 'string', enum: [...META_CHANNELS] },
        status: { type: 'string', enum: [...MESSAGE_STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['artist_id'],
    },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } } },
      required: ['items'],
      additionalProperties: false,
    },
  }),
]);

export function metaToolDefinitions() {
  return META_TOOL_DEFINITIONS.map((tool) => structuredClone(tool));
}

export function metaToolByName(name) {
  return META_TOOL_DEFINITIONS.find((tool) => tool.name === name) || null;
}

export async function callMetaTool(gateway, name, rawArgs = {}) {
  if (name === 'crm_meta_integration_health_get') {
    const args = exactArgs(rawArgs, ['artist_id']);
    const artistId = requiredUuid(args.artist_id, 'artist_id');
    // artist_integrations RLS currently requires manage_integrations for actor reads.
    await requireCapability(gateway, artistId, 'manage_integrations');
    const rows = await gateway.select('artist_integrations', [
      ['select', 'id,artist_id,integration_type,provider,is_enabled,connected_at,last_success_at,last_error_at,last_error_category,updated_at'],
      ['artist_id', `eq.${artistId}`],
      ['integration_type', 'in.(whatsapp,instagram)'],
      ['order', 'integration_type.asc'],
    ]);
    return { items: Array.isArray(rows) ? rows : [] };
  }

  if (name === 'crm_meta_message_status_list') {
    const args = exactArgs(rawArgs, ['artist_id', 'channel', 'status', 'limit']);
    const artistId = requiredUuid(args.artist_id, 'artist_id');
    const channel = optionalEnum(args.channel, 'channel', META_CHANNELS);
    const status = optionalEnum(args.status, 'status', MESSAGE_STATUSES);
    const limit = boundedInteger(args.limit, 'limit', 25, 50);
    await requireCapability(gateway, artistId, 'view_communications');
    const params = [
      ['select', 'id,artist_id,conversation_id,channel,direction,origin,status,message_type,media_state,provider_timestamp,sent_at,delivered_at,read_at,failed_at,created_at,updated_at'],
      ['artist_id', `eq.${artistId}`],
      ['order', 'created_at.desc'],
      ['limit', String(limit)],
    ];
    if (channel) params.push(['channel', `eq.${channel}`]);
    if (status) params.push(['status', `eq.${status}`]);
    const rows = await gateway.select('communication_messages', params);
    return { items: Array.isArray(rows) ? rows : [] };
  }

  throw new McpDomainError('unknown_tool', `Unknown Meta MCP tool: ${name}`, 404);
}

export const __testing = Object.freeze({
  exactArgs,
  requiredUuid,
  optionalEnum,
  boundedInteger,
  requireCapability,
  META_CHANNELS,
  MESSAGE_STATUSES,
  FORBIDDEN_ARGUMENTS,
});
