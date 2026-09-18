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
