// The Statistics reader: one call to public.get_statistics.
//
// Authorization, artist isolation and finance gating are the database's job
// and are pinned by supabase/tests/1845_statistics_core.sql against the real
// schema. What is pinned here is what the browser asks for.

import { describe, expect, it, vi } from 'vitest';
import { createStatisticsApi } from '../lib/statistics-api';
import type { CrmClient } from '../lib/api';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const WINDOW = { from: '2026-09-15T23:00:00.000Z', to: '2026-10-15T23:00:00.000Z' };

function fakeClient(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => answer);
  const from = vi.fn();
  return { client: { rpc, from } as unknown as CrmClient, rpc, from };
}

describe('statistics reader', () => {
  it('asks the server once, for the chosen artist and window', async () => {
    const { client, rpc, from } = fakeClient({ data: { artists: [] }, error: null });
    await createStatisticsApi(client).loadStatistics({ window: WINDOW, artistId: ARTIST });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_statistics', { p_artist_ids: [ARTIST], p_from: WINDOW.from, p_to: WINDOW.to });
    // No raw table is read in the browser any more.
    expect(from).not.toHaveBeenCalled();
  });

  it('leaves the artist scope to the database when no artist is chosen', async () => {
    const { client, rpc } = fakeClient({ data: { artists: [] }, error: null });
    await createStatisticsApi(client).loadStatistics({ window: WINDOW });
    expect(rpc).toHaveBeenCalledWith('get_statistics', { p_artist_ids: null, p_from: WINDOW.from, p_to: WINDOW.to });
  });

  it('surfaces a refusal as an error rather than an empty answer', async () => {
    const { client } = fakeClient({ data: null, error: { code: '42501', message: 'not allowed to view statistics for this artist' } });
    await expect(createStatisticsApi(client).loadStatistics({ window: WINDOW, artistId: ARTIST })).rejects.toThrow();
  });
});
