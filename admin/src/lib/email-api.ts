// Operator-facing email reads and the one write an operator may perform.
//
// `public.email_messages` is granted `select` to `authenticated` (0007) and
// its policy is artist-scoped through `can_manage_artist` (0019), so this is a
// direct table read under exactly the boundary every other CRM read uses. No
// new grant, no new RPC, no widened access.
//
// The single write is `public.approve_email_draft`, which is already granted to
// `authenticated` and re-checks `require_artist_access(artist_id, 'manage')`
// inside the database (0020). Approval is what releases a draft towards the
// send pipeline; the CRM never sends directly, and this module deliberately
// offers no way to.

import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { EmailMessage, EmailMessageDetail } from './types';

const LIST_COLUMNS =
  'id, artist_id, status, to_email, subject, created_by_kind, created_at, '
  + 'client_id, enquiry_id, project_id, approved_at, sent_at, failed_at, error_code';

export interface EmailMessageFilter {
  artistId?: string;
  clientId?: string;
  enquiryId?: string;
  limit?: number;
}

export function createEmailApi(client: CrmClient) {
  return {
    /**
     * Stored email for the operator's reachable artists, newest first.
     *
     * Ordered and limited in the database rather than in the browser: an artist
     * with two years of lifecycle email should not ship all of it to a phone to
     * find the three drafts waiting for approval.
     */
    async listEmailMessages(filter: EmailMessageFilter = {}): Promise<EmailMessage[]> {
      let query = client
        .from('email_messages')
        .select(LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(filter.limit ?? 100);
      if (filter.artistId) query = query.eq('artist_id', filter.artistId);
      if (filter.clientId) query = query.eq('client_id', filter.clientId);
      if (filter.enquiryId) query = query.eq('enquiry_id', filter.enquiryId);

      const result = await query;
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load email conversations'), result.error);
      }
      return (result.data ?? []) as EmailMessage[];
    },

    /** One message with its body, read only when a thread is actually opened. */
    async getEmailMessage(id: string): Promise<EmailMessageDetail | null> {
      const result = await client
        .from('email_messages')
        .select(`${LIST_COLUMNS}, body`)
        .eq('id', id)
        .maybeSingle();
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load that email'), result.error);
      }
      return (result.data as EmailMessageDetail | null) ?? null;
    },

    /**
     * Release a draft towards the send pipeline.
     *
     * The database decides whether this operator may: approve_email_draft is
     * SECURITY DEFINER and calls require_artist_access(artist_id, 'manage').
     * The `approveEmail` capability check in the interface only decides whether
     * to offer the button.
     */
    async approveEmailDraft(id: string): Promise<void> {
      const result = await client.rpc('approve_email_draft', { p_email_message_id: id });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'approve that email draft'), result.error);
      }
    },
  };
}

export type EmailApi = ReturnType<typeof createEmailApi>;
