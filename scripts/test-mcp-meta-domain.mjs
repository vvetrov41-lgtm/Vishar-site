#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  META_TOOL_DEFINITIONS,
  callMetaTool,
  metaToolByName,
} from '../workers/lib/mcp-meta-domain.js';
import { __testing as serverTesting } from '../workers/lib/mcp-server.js';

const ARTIST_ID = '11111111-2222-4333-8444-555555555555';

let passes = 0;
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function gatewayWithCapabilities(capabilities, rows = []) {
  const calls = [];
  return {
    calls,
    gateway: {
      async rpc(name, args) {
        calls.push({ kind: 'rpc', name, args });
        assert.equal(name, 'list_capabilities');
        return capabilities.map((capability) => ({ artist_id: ARTIST_ID, capability }));
      },
      async select(table, params) {
        calls.push({ kind: 'select', table, params });
        return rows;
      },
    },
  };
}

await test('Meta tools stay hidden unless their dedicated flag is enabled', async () => {
  const disabled = serverTesting.toolDefinitions({ MCP_META_TOOLS_ENABLED: 'false' });
  assert.ok(!disabled.some((tool) => tool.name.startsWith('crm_meta_')));
  assert.equal(serverTesting.toolByName({ MCP_META_TOOLS_ENABLED: 'false' }, 'crm_meta_integration_health_get'), null);

  const enabled = serverTesting.toolDefinitions({ MCP_META_TOOLS_ENABLED: 'true' });
  const names = enabled.filter((tool) => tool.name.startsWith('crm_meta_')).map((tool) => tool.name).sort();
  assert.deepEqual(names, ['crm_meta_integration_health_get', 'crm_meta_message_status_list']);
  assert.equal(serverTesting.toolByName({ MCP_META_TOOLS_ENABLED: 'true' }, 'crm_meta_message_status_list')?.kind, 'meta');
});

await test('Meta tool contract is read-only and bounded', async () => {
  assert.equal(META_TOOL_DEFINITIONS.length, 2);
  assert.ok(metaToolByName('crm_meta_integration_health_get'));
  assert.ok(metaToolByName('crm_meta_message_status_list'));
  assert.equal(metaToolByName('crm_meta_send_message'), null);

  for (const tool of META_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema;
    assert.equal(schema.additionalProperties, false);
    for (const forbidden of ['body', 'attachments', 'provider_message_id', 'integration_key', 'access_token', 'configuration']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(schema.properties || {}, forbidden), `${tool.name} exposes ${forbidden}`);
    }
  }
});

await test('integration health requires manage_integrations and selects only safe columns', async () => {
  const { gateway, calls } = gatewayWithCapabilities(['manage_integrations'], [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    artist_id: ARTIST_ID,
    integration_type: 'whatsapp',
    provider: 'meta',
    is_enabled: true,
    connected_at: null,
    last_success_at: '2026-09-01T06:00:00Z',
    last_error_at: null,
    last_error_category: 'none',
    updated_at: '2026-09-01T06:00:00Z',
  }]);

  const result = await callMetaTool(gateway, 'crm_meta_integration_health_get', { artist_id: ARTIST_ID });
  assert.equal(result.items.length, 1);
  assert.equal(calls[0].kind, 'rpc');
  assert.deepEqual(calls[0].args, { p_artist_id: ARTIST_ID });
  assert.equal(calls[1].kind, 'select');
  assert.equal(calls[1].table, 'artist_integrations');
  const select = calls[1].params.find(([key]) => key === 'select')?.[1] || '';
  for (const forbidden of ['integration_key', 'configuration', 'external_account_label']) {
    assert.ok(!select.includes(forbidden), `integration health selected ${forbidden}`);
  }
  assert.ok(calls[1].params.some(([key, value]) => key === 'integration_type' && value === 'in.(whatsapp,instagram)'));
});

await test('integration health fails closed before table read without manage_integrations', async () => {
  const { gateway, calls } = gatewayWithCapabilities(['view_integrations']);
  await assert.rejects(
    () => callMetaTool(gateway, 'crm_meta_integration_health_get', { artist_id: ARTIST_ID }),
    (error) => error?.code === 'permission_denied'
  );
  assert.equal(calls.filter((call) => call.kind === 'select').length, 0);
});

await test('message status requires view_communications and excludes message/provider payload fields', async () => {
  const { gateway, calls } = gatewayWithCapabilities(['view_communications'], [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    artist_id: ARTIST_ID,
    conversation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    channel: 'whatsapp',
    direction: 'outbound',
    origin: 'crm',
    status: 'delivered',
    message_type: 'text',
    media_state: null,
    provider_timestamp: '2026-09-01T06:00:00Z',
    sent_at: '2026-09-01T06:00:00Z',
    delivered_at: '2026-09-01T06:00:05Z',
    read_at: null,
    failed_at: null,
    created_at: '2026-09-01T06:00:00Z',
    updated_at: '2026-09-01T06:00:05Z',
  }]);

  const result = await callMetaTool(gateway, 'crm_meta_message_status_list', {
    artist_id: ARTIST_ID,
    channel: 'whatsapp',
    status: 'delivered',
    limit: 7,
  });
  assert.equal(result.items.length, 1);
  const read = calls.find((call) => call.kind === 'select');
  assert.equal(read.table, 'communication_messages');
  const select = read.params.find(([key]) => key === 'select')?.[1] || '';
  for (const forbidden of ['body', 'attachments', 'provider_message_id', 'created_by']) {
    assert.ok(!select.includes(forbidden), `message status selected ${forbidden}`);
  }
  assert.ok(read.params.some(([key, value]) => key === 'channel' && value === 'eq.whatsapp'));
  assert.ok(read.params.some(([key, value]) => key === 'status' && value === 'eq.delivered'));
  assert.ok(read.params.some(([key, value]) => key === 'limit' && value === '7'));
});

await test('message status fails closed without view_communications', async () => {
  const { gateway, calls } = gatewayWithCapabilities(['manage_integrations']);
  await assert.rejects(
    () => callMetaTool(gateway, 'crm_meta_message_status_list', { artist_id: ARTIST_ID }),
    (error) => error?.code === 'permission_denied'
  );
  assert.equal(calls.filter((call) => call.kind === 'select').length, 0);
});

await test('Meta tools reject credential, content and unbounded arguments before any upstream call', async () => {
  for (const args of [
    { artist_id: ARTIST_ID, integration_key: 'secret' },
    { artist_id: ARTIST_ID, body: 'client text' },
    { artist_id: ARTIST_ID, provider_message_id: 'wamid.x' },
    { artist_id: ARTIST_ID, limit: 51 },
    { artist_id: ARTIST_ID, channel: 'telegram' },
  ]) {
    const { gateway, calls } = gatewayWithCapabilities(['manage_integrations', 'view_communications']);
    await assert.rejects(
      () => callMetaTool(gateway, args.limit || args.channel ? 'crm_meta_message_status_list' : 'crm_meta_integration_health_get', args),
      (error) => ['forbidden_argument', 'unexpected_argument', 'invalid_argument'].includes(error?.code)
    );
    assert.equal(calls.length, 0);
  }
});

if (failures > 0) {
  console.error(`\n${failures} failed, ${passes} passed`);
  process.exit(1);
}
console.log(`\n${passes} passed`);
