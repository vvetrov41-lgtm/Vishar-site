import { ApiError, friendlyMessage, type CrmClient } from './api';

export interface GmailClientMetadataSnapshot {
  artist_id: string;
  client_id: string;
  subject: string;
  last_message_at: string | null;
  direction: 'inbound' | 'outbound';
  refreshed_at: string;
}

const COLUMNS = 'artist_id, client_id, subject, last_message_at, direction, refreshed_at';

export function createGmailMetadataApi(client: CrmClient) {
  return {
    /**
     * CRM-owned Gmail metadata only. This read never contacts the Gmail Worker
     * or Google; RLS limits rows to artists and clients the operator can reach.
     */
    async listGmailMetadataSnapshots(artistId?: string): Promise<GmailClientMetadataSnapshot[]> {
      let query = client
        .from('gmail_client_metadata_snapshots')
        .select(COLUMNS)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(500);
      if (artistId) query = query.eq('artist_id', artistId);
      const result = await query;
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load email conversations'), result.error);
      }
      return (result.data ?? []) as GmailClientMetadataSnapshot[];
    },
  };
}

export type GmailMetadataApi = ReturnType<typeof createGmailMetadataApi>;