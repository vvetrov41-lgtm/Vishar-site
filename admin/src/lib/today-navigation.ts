import type { ConversationSummary } from './communications-api';
import type { EmailThread } from './email-threads';
import type { TodayItem } from './today-workspace';
import type { Enquiry } from './types';

/** Resolve reply work to the enquiry already visible under this session's RLS.
 * An explicit conversation/draft link wins; client-only mail can use a single
 * active enquiry for that exact artist. Multiple matches open the client.
 */
export function enquiryTargetsForToday(
  items: TodayItem[],
  enquiries: Enquiry[],
  conversations: ConversationSummary[],
  emailThreads: EmailThread[],
): TodayItem[] {
  return items.map((item) => {
    if (!['reply', 'email_send_failed', 'email_draft_to_approve'].includes(item.kind)) return item;
    if (!item.artistId || !item.clientId) return item;
    const conversation = conversations.find((row) => item.href === `/inbox/${row.id}`);
    const email = emailThreads.find((row) => item.href === `/inbox/email/${row.key}`);
    const linkedId = item.enquiryId ?? conversation?.enquiry_id ?? email?.enquiry_id;
    const scoped = enquiries.filter((row) => row.artist_id === item.artistId
      && row.client_id === item.clientId && row.intake_state === 'complete' && !row.archived_at);
    const linked = scoped.find((row) => row.id === linkedId);
    const active = scoped.filter((row) => !['closed', 'declined', 'converted'].includes(row.status));
    const target = linked ?? (active.length === 1 ? active[0] : null);
    return { ...item, href: target ? `/enquiries/${target.id}` : `/clients/${item.clientId}` };
  });
}
