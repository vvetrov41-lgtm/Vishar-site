import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { createApi } from '../lib/api';
import { CLIENT_ID, VLADIMIR_ARTIST_ID, createFakeClient, renderWithSession } from './fixtures';

type QueryCall = { table: string; method: string; args: unknown[] };

function matching(calls: QueryCall[], table: string, method: string, column: string): QueryCall[] {
  return calls.filter((call) => call.table === table && call.method === method && call.args[0] === column);
}

describe('Phase 4 client card relationship queries', () => {
  it('skips remote work when no clients are visible', async () => {
    const queryCalls: QueryCall[] = [];
    const api = createApi(createFakeClient({ role: 'owner', queryCalls }));
    expect(await api.listClientWorkArtistLinks([])).toEqual([]);
    expect(queryCalls).toHaveLength(0);
  });

  it('uses a deduplicated ID filter and only active work to find legacy artist links', async () => {
    const queryCalls: QueryCall[] = [];
    const api = createApi(createFakeClient({ role: 'owner', queryCalls }));
    const records = await api.listClientWorkArtistLinks([CLIENT_ID, CLIENT_ID]);

    for (const table of ['enquiries', 'projects']) {
      expect(matching(queryCalls, table, 'in', 'client_id')).toEqual([
        { table, method: 'in', args: ['client_id', [CLIENT_ID]] },
      ]);
      expect(matching(queryCalls, table, 'is', 'archived_at')).toHaveLength(1);
    }
    expect(matching(queryCalls, 'enquiries', 'eq', 'intake_state')).toHaveLength(1);
    expect(records.some((row) => row.client_id === CLIENT_ID && row.artist_id === VLADIMIR_ARTIST_ID)).toBe(true);
  });

  it('shows artist attribution without fetching a full workspace-wide enquiry/project list', async () => {
    const queryCalls: QueryCall[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: '/clients', queryCalls });

    expect(await screen.findByText('Fixture Client')).toBeInTheDocument();
    expect(await screen.findByLabelText('Artist: Vladimir Vishar')).toBeInTheDocument();

    for (const table of ['enquiries', 'projects']) {
      expect(matching(queryCalls, table, 'in', 'client_id')).toHaveLength(1);
      expect(queryCalls.some((call) => call.table === table && call.method === 'order')).toBe(false);
    }
  });
});
