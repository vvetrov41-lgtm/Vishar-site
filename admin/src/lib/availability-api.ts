import { ApiError, friendlyMessage, type CrmClient } from './api';

export type AvailabilityBlockKind = 'day_off' | 'holiday' | 'personal' | 'other';

export interface AvailabilityBlock {
  block_id: string;
  artist_id: string;
  block_kind: AvailabilityBlockKind;
  start_at: string;
  end_at: string;
  is_all_day: boolean;
  note: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AvailabilityBlockInput {
  artistId: string;
  blockKind: AvailabilityBlockKind;
  startAt: string;
  endAt: string;
  isAllDay?: boolean;
  note?: string | null;
}

function availabilityMessage(error: any, what: string): string {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.includes('time off overlaps an active appointment')) {
    return 'Move or cancel the existing appointment before blocking that time.';
  }
  if (message.includes('time off overlaps another active availability block')) {
    return 'That time already overlaps another availability block.';
  }
  return friendlyMessage(error, what);
}

function unwrap<T>(result: { data: T | null; error: any }, what: string): T {
  if (result.error) {
    throw new ApiError(availabilityMessage(result.error, what), result.error);
  }
  return (result.data ?? ([] as unknown)) as T;
}

export function createAvailabilityApi(client: CrmClient) {
  return {
    async listAvailabilityBlocks(input: {
      artistId: string;
      from: string;
      to: string;
      includeCancelled?: boolean;
    }): Promise<AvailabilityBlock[]> {
      return unwrap<AvailabilityBlock[]>(
        await client.rpc('list_artist_availability_blocks', {
          p_artist_id: input.artistId,
          p_from: input.from,
          p_to: input.to,
          p_include_cancelled: input.includeCancelled ?? false,
        }),
        'load artist availability'
      );
    },

    async createAvailabilityBlock(input: AvailabilityBlockInput) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('create_artist_availability_block', {
          p_artist_id: input.artistId,
          p_block_kind: input.blockKind,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_is_all_day: input.isAllDay ?? false,
          p_note: input.note ?? null,
        }),
        'block that time'
      );
    },

    async updateAvailabilityBlock(blockId: string, input: Omit<AvailabilityBlockInput, 'artistId'>) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('update_artist_availability_block', {
          p_block_id: blockId,
          p_block_kind: input.blockKind,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_is_all_day: input.isAllDay ?? false,
          p_note: input.note ?? null,
        }),
        'change that time off'
      );
    },

    async cancelAvailabilityBlock(blockId: string) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('cancel_artist_availability_block', {
          p_block_id: blockId,
        }),
        'remove that time off'
      );
    },
  };
}

export type AvailabilityApi = ReturnType<typeof createAvailabilityApi>;