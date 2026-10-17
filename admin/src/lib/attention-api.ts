import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';

export type AttentionAcknowledgementKind =
  | 'conversation_reply'
  | 'gmail_reply'
  | 'new_enquiry'
  | 'deposit_outstanding'
  | 'client_silence';

export interface AttentionAcknowledgement {
  artist_id: string;
  item_kind: AttentionAcknowledgementKind;
  entity_id: string;
  observed_at: string;
  acknowledged_at: string;
}

/** What `get_waiting_on_clients_count` answers: the Today block's number. */
export type WaitingOnClientsCount =
  | { status: 'ok'; count: number; generated_at: string; artists: { artist_id: string; count: number }[] }
  | { status: 'unavailable'; reason: string };

export interface AttentionItemRef {
  artistId: string;
  kind: AttentionAcknowledgementKind;
  entityId: string;
  observedAt: string;
}

function acknowledgements(value: unknown): AttentionAcknowledgement[] {
  if (!Array.isArray(value)) throw new ApiError(apiMessage('Could not load attention acknowledgements.'));
  return value as AttentionAcknowledgement[];
}

export function createAttentionApi(client: CrmClient) {
  return {
    async listAttentionAcknowledgements(artistId?: string): Promise<AttentionAcknowledgement[]> {
      const result = await client.rpc('list_attention_acknowledgements', {
        p_artist_id: artistId ?? null,
      });
      if (result.error) {
        throw new ApiError(
          friendlyMessage(result.error, 'load hidden attention items'),
          result.error,
        );
      }
      return acknowledgements(result.data ?? []);
    },

    async acknowledgeAttentionItem(item: AttentionItemRef): Promise<void> {
      const result = await client.rpc('acknowledge_attention_item', {
        p_artist_id: item.artistId,
        p_item_kind: item.kind,
        p_entity_id: item.entityId,
        p_observed_at: item.observedAt,
      });
      if (result.error) {
        throw new ApiError(
          friendlyMessage(result.error, 'hide that attention item'),
          result.error,
        );
      }
    },

    /** "Not now": a client silence item returns at `until`, unless either side writes first. */
    async snoozeAttentionItem(item: AttentionItemRef, until: Date): Promise<void> {
      const result = await client.rpc('snooze_attention_item', {
        p_artist_id: item.artistId,
        p_item_kind: item.kind,
        p_entity_id: item.entityId,
        p_observed_at: item.observedAt,
        p_resurface_at: until.toISOString(),
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'postpone that reminder'), result.error);
      }
    },

    /** Undo: the item returns if its source still waits. */
    async clearAttentionAcknowledgement(item: AttentionItemRef): Promise<void> {
      const result = await client.rpc('clear_attention_acknowledgement', {
        p_artist_id: item.artistId,
        p_item_kind: item.kind,
        p_entity_id: item.entityId,
      });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'bring that item back'), result.error);
      }
    },

    async getWaitingOnClientsCount(artistId?: string): Promise<WaitingOnClientsCount> {
      const result = await client.rpc('get_waiting_on_clients_count', { p_artist_id: artistId ?? null });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'count clients waiting on a reply'), result.error);
      }
      const data = result.data as WaitingOnClientsCount | null;
      if (!data || (data.status !== 'ok' && data.status !== 'unavailable')) {
        throw new ApiError(apiMessage('Could not count clients waiting on a reply.'));
      }
      return data;
    },
  };
}

export type AttentionApi = ReturnType<typeof createAttentionApi>;
