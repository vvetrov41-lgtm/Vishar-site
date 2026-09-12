import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';

export type AttentionAcknowledgementKind =
  | 'conversation_reply'
  | 'gmail_reply'
  | 'new_enquiry'
  | 'deposit_outstanding';

export interface AttentionAcknowledgement {
  artist_id: string;
  item_kind: AttentionAcknowledgementKind;
  entity_id: string;
  observed_at: string;
  acknowledged_at: string;
}

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
  };
}

export type AttentionApi = ReturnType<typeof createAttentionApi>;
