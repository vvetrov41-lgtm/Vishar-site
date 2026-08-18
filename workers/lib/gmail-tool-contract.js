// Transport-neutral CRM Gmail tool contract.
//
// This module deliberately knows nothing about OpenAI Actions, MCP transports,
// OAuth tokens, Google account routing or artist identifiers. HTTP/OpenAPI and
// a future MCP adapter can map these same bounded tool definitions onto the
// existing CRM/Gmail service boundary without changing domain semantics.

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export const GMAIL_TOOL_CONTRACT_VERSION = '1.0.0';

const definitions = [
  {
    name: 'crm_email_history_search',
    operationId: 'searchEmailHistory',
    description: 'Search the bound CRM client email history for one authorised enquiry.',
    capability: 'communications',
    http: { method: 'GET', route: 'history' },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enquiry_id: { type: 'string', pattern: UUID_PATTERN },
        thread_limit: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        message_limit: { type: 'integer', minimum: 1, maximum: 30, default: 20 },
      },
      required: ['enquiry_id'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    requiresExplicitSendApproval: false,
  },
  {
    name: 'crm_email_thread_get',
    operationId: 'getEmailThread',
    description: 'Read one previously authorised CRM email thread by opaque thread context.',
    capability: 'communications',
    http: { method: 'GET', route: 'thread' },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enquiry_id: { type: 'string', pattern: UUID_PATTERN },
        thread_context_id: { type: 'string', pattern: UUID_PATTERN },
      },
      required: ['enquiry_id', 'thread_context_id'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    requiresExplicitSendApproval: false,
  },
  {
    name: 'crm_email_reply_draft_create',
    operationId: 'createGmailReplyDraft',
    description: 'Create a CRM draft reply for an authorised Gmail thread. This never sends the message.',
    capability: 'communications',
    http: { method: 'POST', route: 'reply_draft' },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enquiry_id: { type: 'string', pattern: UUID_PATTERN },
        thread_context_id: { type: 'string', pattern: UUID_PATTERN },
        body: { type: 'string', minLength: 1, maxLength: 8000 },
      },
      required: ['enquiry_id', 'thread_context_id', 'body'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    requiresExplicitSendApproval: true,
  },
];

export const GMAIL_TOOL_DEFINITIONS = Object.freeze(definitions.map((definition) => Object.freeze(definition)));

export function gmailToolByOperationId(operationId) {
  return GMAIL_TOOL_DEFINITIONS.find((definition) => definition.operationId === operationId) || null;
}

export function gmailToolByName(name) {
  return GMAIL_TOOL_DEFINITIONS.find((definition) => definition.name === name) || null;
}

export function toMcpToolDefinitions() {
  return GMAIL_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
  }));
}

export function matchGmailHttpActionPath(pathname) {
  if (typeof pathname !== 'string') return null;

  let match = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/history\/?$/i.exec(pathname);
  if (match) return { operationId: 'searchEmailHistory', enquiryId: match[1], threadContextId: null };

  match = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/threads\/([0-9a-f-]{36})\/?$/i.exec(pathname);
  if (match) return { operationId: 'getEmailThread', enquiryId: match[1], threadContextId: match[2] };

  match = /^\/v1\/enquiries\/([0-9a-f-]{36})\/gmail\/reply-drafts\/?$/i.exec(pathname);
  if (match) return { operationId: 'createGmailReplyDraft', enquiryId: match[1], threadContextId: null };

  return null;
}

export function isGmailHttpActionPath(pathname) {
  return Boolean(matchGmailHttpActionPath(pathname));
}