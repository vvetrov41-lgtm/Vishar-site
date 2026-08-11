import { describe, expect, it, vi } from 'vitest';
import { createAvailabilityApi } from '../lib/availability-api';
import type { CrmClient } from '../lib/api';

function clientWithRpc(response: { data: unknown; error: unknown } = { data: { ok: true }, error: null }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as CrmClient, rpc };
}

describe('availability API boundary', () => {
  it('lists one artist through the protected availability RPC', async () => {
    const { client, rpc } = clientWithRpc({ data: [], error: null });
    const api = createAvailabilityApi(client);

    await api.listAvailabilityBlocks({
      artistId: 'artist-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });

    expect(rpc).toHaveBeenCalledWith('list_artist_availability_blocks', {
      p_artist_id: 'artist-1',
      p_from: '2026-10-01T00:00:00.000Z',
      p_to: '2026-11-01T00:00:00.000Z',
      p_include_cancelled: false,
    });
  });

  it('creates time off without accepting an artist selector from the response', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAvailabilityApi(client);

    await api.createAvailabilityBlock({
      artistId: 'artist-1',
      blockKind: 'holiday',
      startAt: '2026-10-03T23:00:00.000Z',
      endAt: '2026-10-11T23:00:00.000Z',
      isAllDay: true,
      note: 'Synthetic holiday',
    });

    expect(rpc).toHaveBeenCalledWith('create_artist_availability_block', {
      p_artist_id: 'artist-1',
      p_block_kind: 'holiday',
      p_start_at: '2026-10-03T23:00:00.000Z',
      p_end_at: '2026-10-11T23:00:00.000Z',
      p_is_all_day: true,
      p_note: 'Synthetic holiday',
    });
  });

  it('maps active appointment overlap to a safe actionable message', async () => {
    const { client } = clientWithRpc({
      data: null,
      error: { code: '22023', message: 'time off overlaps an active appointment' },
    });
    const api = createAvailabilityApi(client);

    await expect(api.createAvailabilityBlock({
      artistId: 'artist-1',
      blockKind: 'day_off',
      startAt: '2026-10-10T09:00:00.000Z',
      endAt: '2026-10-10T17:00:00.000Z',
    })).rejects.toThrow('Move or cancel the existing appointment before blocking that time.');
  });

  it('maps overlap with another block without exposing database internals', async () => {
    const { client } = clientWithRpc({
      data: null,
      error: { code: '22023', message: 'time off overlaps another active availability block' },
    });
    const api = createAvailabilityApi(client);

    await expect(api.updateAvailabilityBlock('block-1', {
      blockKind: 'personal',
      startAt: '2026-10-10T09:00:00.000Z',
      endAt: '2026-10-10T12:00:00.000Z',
    })).rejects.toThrow('That time already overlaps another availability block.');
  });

  it('soft-cancels only the explicit availability block id', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createAvailabilityApi(client);

    await api.cancelAvailabilityBlock('block-1');

    expect(rpc).toHaveBeenCalledWith('cancel_artist_availability_block', {
      p_block_id: 'block-1',
    });
  });
});
