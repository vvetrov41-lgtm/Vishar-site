import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from './gmail-metadata-snapshot.js';

test('Gmail metadata refresh stays bounded and times provider calls out', () => {
  assert.equal(__testing.METADATA_CONCURRENCY, 5);
  assert.equal(__testing.PROVIDER_TIMEOUT_MS, 5000);
  assert.equal(__testing.SNAPSHOT_WINDOW_DAYS, 30);
});

test('snapshot keeps only matched known clients and the newest metadata', () => {
  const refreshedAt = '2026-09-18T00:00:00.000Z';
  const rows = __testing.latestKnownRows(
    '11111111-1111-4111-8111-111111111111',
    [
      { email: 'known@example.com', subject: 'older', timestamp: '2026-09-17T10:00:00.000Z', direction: 'inbound' },
      { email: 'unknown@example.com', subject: 'unknown', timestamp: '2026-09-17T11:00:00.000Z', direction: 'inbound' },
      { email: 'known@example.com', subject: 'newer', timestamp: '2026-09-17T12:00:00.000Z', direction: 'outbound' },
    ],
    [{
      client_id: '22222222-2222-4222-8222-222222222222',
      client_email: 'known@example.com',
      full_name: 'Known Client',
    }],
    refreshedAt,
  );
  assert.deepEqual(rows, [{
    artist_id: '11111111-1111-4111-8111-111111111111',
    client_id: '22222222-2222-4222-8222-222222222222',
    subject: 'newer',
    last_message_at: '2026-09-17T12:00:00.000Z',
    direction: 'outbound',
    refreshed_at: refreshedAt,
  }]);
});

test('metadata parser never returns provider ids or bodies', () => {
  const row = __testing.metadataCorrespondent({
    id: 'provider-secret-id',
    internalDate: String(Date.parse('2026-09-17T12:00:00.000Z')),
    payload: {
      body: { data: 'secret-body' },
      headers: [
        { name: 'From', value: 'Client <client@example.com>' },
        { name: 'To', value: 'Artist <artist@example.com>' },
        { name: 'Subject', value: 'Hello' },
      ],
    },
  }, 'artist@example.com');
  assert.deepEqual(row, {
    email: 'client@example.com',
    subject: 'Hello',
    timestamp: '2026-09-17T12:00:00.000Z',
    direction: 'inbound',
  });
  assert.equal('id' in row, false);
  assert.equal('body' in row, false);
});

const ENV = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_only_value',
};
const ARTIST = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('mailboxes are listed through the backend RPC, never the integrations table', async () => {
  const calls = [];
  const rows = await __testing.listEnabledMailboxes(ENV, async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return jsonResponse([
      { artist_id: ARTIST, integration_key: 'google_gmail_vladimir', external_account_label: 'studio@example.com' },
      { artist_id: 'not-a-uuid', integration_key: 'x', external_account_label: 'x@example.com' },
    ]);
  });
  assert.deepEqual(calls, [{
    url: 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/service_list_gmail_mailboxes',
    method: 'POST',
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artist_id, ARTIST);
});

test('history evidence is direction and time only, strictly between mailbox and client', () => {
  const at = Date.parse('2026-07-01T09:30:00.000Z');
  const message = (from, to) => ({
    id: 'provider-id',
    internalDate: String(at),
    payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: 'secret' }] },
  });
  assert.deepEqual(
    __testing.historyEvidence(message('Client <client@example.com>', 'studio@example.com'), 'studio@example.com', 'client@example.com'),
    { direction: 'inbound', last_message_at: '2026-07-01T09:30:00.000Z' },
  );
  assert.deepEqual(
    __testing.historyEvidence(message('studio@example.com', 'Client <CLIENT@example.com>'), 'studio@example.com', 'client@example.com'),
    { direction: 'outbound', last_message_at: '2026-07-01T09:30:00.000Z' },
  );
  assert.equal(
    __testing.historyEvidence(message('someone@example.com', 'studio@example.com'), 'studio@example.com', 'client@example.com'),
    null,
    'a message from someone else is not this client\'s conversation',
  );
});

test('history backfill records the newest message, or a checked miss, and sends nothing', async () => {
  const recorded = [];
  const gmailPaths = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/rpc/service_list_gmail_history_candidates')) {
      return jsonResponse([
        { client_id: CLIENT, client_email: 'client@example.com' },
        { client_id: '33333333-3333-4333-8333-333333333333', client_email: 'quiet@example.com' },
      ]);
    }
    if (href.includes('/rpc/service_record_gmail_client_history')) {
      recorded.push(JSON.parse(init.body));
      return jsonResponse(null);
    }
    if (href.startsWith('https://gmail.googleapis.com/')) {
      assert.equal(init.method, 'GET', 'the provider is only ever read');
      gmailPaths.push(href);
      if (href.includes('/messages?')) {
        const query = new URL(href).searchParams.get('q');
        return jsonResponse(query.includes('client@example.com') ? { messages: [{ id: 'msg12345' }] } : {});
      }
      return jsonResponse({
        internalDate: String(Date.parse('2026-06-15T08:00:00.000Z')),
        payload: { headers: [{ name: 'From', value: 'client@example.com' }, { name: 'To', value: 'studio@example.com' }] },
      });
    }
    throw new Error(`unexpected ${href}`);
  };
  const checked = await __testing.backfillClientHistory(ENV, ARTIST, 'token-value', 'studio@example.com', fetchImpl);
  assert.equal(checked, 2);
  assert.deepEqual(recorded, [
    { p_artist_id: ARTIST, p_client_id: CLIENT, p_last_message_at: '2026-06-15T08:00:00.000Z', p_direction: 'inbound' },
    { p_artist_id: ARTIST, p_client_id: '33333333-3333-4333-8333-333333333333', p_last_message_at: null, p_direction: null },
  ]);
  assert.ok(gmailPaths.every((href) => !href.includes('/send')));
  assert.equal(
    new URL(gmailPaths[0]).searchParams.get('q'),
    '{from:"client@example.com" to:"client@example.com"} -in:drafts -in:chats -in:spam -in:trash',
  );
});
