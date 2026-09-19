import { describe, expect, it, vi } from 'vitest';
import { createGmailMetadataApi } from './gmail-metadata-api';
import type { CrmClient } from './api';

function queryResult(rows: unknown[]) {
  const query: any = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return query;
}

describe('createGmailMetadataApi', () => {
  it('reads the CRM snapshot without a provider request and keeps the read bounded', async () => {
    const query = queryResult([{ artist_id: 'artist-1', client_id: 'client-1', subject: 'Hi' }]);
    const client = { from: vi.fn(() => query) } as unknown as CrmClient;

    const rows = await createGmailMetadataApi(client).listGmailMetadataSnapshots();

    expect(client.from).toHaveBeenCalledWith('gmail_client_metadata_snapshots');
    expect(query.select).toHaveBeenCalledWith(
      'artist_id, client_id, subject, last_message_at, direction, refreshed_at',
    );
    expect(query.order).toHaveBeenCalledWith('last_message_at', { ascending: false, nullsFirst: false });
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(query.eq).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('applies artist scope at the database read when one artist is selected', async () => {
    const query = queryResult([]);
    const client = { from: vi.fn(() => query) } as unknown as CrmClient;

    await createGmailMetadataApi(client).listGmailMetadataSnapshots('artist-1');

    expect(query.eq).toHaveBeenCalledWith('artist_id', 'artist-1');
  });
});
