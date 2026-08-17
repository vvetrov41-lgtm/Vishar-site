import assert from 'node:assert/strict';
import {
  GMAIL_TOOL_CONTRACT_VERSION,
  GMAIL_TOOL_DEFINITIONS,
  gmailToolByName,
  gmailToolByOperationId,
  isGmailHttpActionPath,
  matchGmailHttpActionPath,
  toMcpToolDefinitions,
} from '../workers/lib/gmail-tool-contract.js';

assert.equal(GMAIL_TOOL_CONTRACT_VERSION, '1.0.0');
assert.equal(GMAIL_TOOL_DEFINITIONS.length, 3, 'Gmail MCP-ready contract must expose exactly three bounded tools');

const expected = new Map([
  ['crm_email_history_search', ['searchEmailHistory', true, false]],
  ['crm_email_thread_get', ['getEmailThread', true, false]],
  ['crm_email_reply_draft_create', ['createGmailReplyDraft', false, true]],
]);

for (const definition of GMAIL_TOOL_DEFINITIONS) {
  const contract = expected.get(definition.name);
  assert.ok(contract, `unexpected Gmail tool ${definition.name}`);
  assert.equal(definition.operationId, contract[0]);
  assert.equal(definition.capability, 'communications');
  assert.equal(definition.annotations.readOnlyHint, contract[1]);
  assert.equal(definition.requiresExplicitSendApproval, contract[2]);
  assert.equal(definition.annotations.destructiveHint, false);
  assert.equal(definition.annotations.openWorldHint, false);
  assert.equal(definition.inputSchema.type, 'object');
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.ok(gmailToolByName(definition.name));
  assert.ok(gmailToolByOperationId(definition.operationId));
}

const serialized = JSON.stringify(GMAIL_TOOL_DEFINITIONS);
assert.doesNotMatch(
  serialized,
  /artist_id|mailbox_email|provider|integration_key|access_token|refresh_token|client_secret|service_role|google_oauth/i,
  'transport-neutral tool contract must not expose artist routing or provider credentials',
);
assert.doesNotMatch(serialized, /\bsend(?:email|message)?\b/i,
  'MCP-ready Gmail surface must not introduce a direct send tool',
);

const mcpTools = toMcpToolDefinitions();
assert.deepEqual(
  mcpTools.map((tool) => tool.name).sort(),
  [...expected.keys()].sort(),
  'MCP adapter projection must preserve the bounded tool inventory',
);
for (const tool of mcpTools) {
  assert.ok(tool.description);
  assert.ok(tool.inputSchema);
  assert.ok(tool.annotations);
  assert.equal(Object.hasOwn(tool, 'operationId'), false, 'MCP projection does not leak HTTP/OpenAPI transport metadata');
}

assert.deepEqual(
  matchGmailHttpActionPath('/v1/enquiries/11111111-1111-4111-8111-111111111111/gmail/history'),
  { operationId: 'searchEmailHistory', enquiryId: '11111111-1111-4111-8111-111111111111', threadContextId: null },
);
assert.deepEqual(
  matchGmailHttpActionPath('/v1/enquiries/11111111-1111-4111-8111-111111111111/gmail/threads/22222222-2222-4222-8222-222222222222'),
  {
    operationId: 'getEmailThread',
    enquiryId: '11111111-1111-4111-8111-111111111111',
    threadContextId: '22222222-2222-4222-8222-222222222222',
  },
);
assert.deepEqual(
  matchGmailHttpActionPath('/v1/enquiries/11111111-1111-4111-8111-111111111111/gmail/reply-drafts'),
  { operationId: 'createGmailReplyDraft', enquiryId: '11111111-1111-4111-8111-111111111111', threadContextId: null },
);
assert.equal(isGmailHttpActionPath('/v1/enquiries/not-a-uuid/gmail/history'), false);
assert.equal(isGmailHttpActionPath('/mcp'), false, 'MCP readiness must not silently publish an MCP endpoint');

console.log('Gmail MCP-ready contract tests passed: 3 bounded transport-neutral tools with no direct send or routing secrets.');