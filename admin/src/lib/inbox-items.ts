// One work queue, two provider families.
//
// The Inbox answers "who is waiting on me?". Messaging channels answer that
// from message direction: the client spoke last, so you owe a reply. Email
// cannot answer it that way, because the CRM never stores inbound mail - so
// email answers it from the pipeline instead: a draft nobody approved, or a
// send that failed.
//
// Both are genuinely "waiting on you". Neither is dressed up as the other:
// `reason` says which question the row is answering, and the screen shows that
// reason rather than a single invented "needs reply" flag.

import { conversationNeedsReply, type ConversationSummary } from './communications-api';
import { threadNeedsOperator, type EmailThread } from './email-threads';

export type InboxChannel = 'whatsapp' | 'instagram' | 'email';

export type InboxWaitingReason =
  /** They spoke last. Messaging channels only. */
  | 'client_replied'
  /** A drafted email is sitting unapproved. Email only. */
  | 'draft_awaiting_approval'
  /** The provider refused a send. Email only. */
  | 'send_failed'
  /** Nothing is waiting on the operator. */
  | 'none';

export interface InboxItem {
  /** Route target, unique across both families. */
  href: string;
  key: string;
  channel: InboxChannel;
  artist_id: string;
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  /** Who this is, resolved by the caller from whatever the row carries. */
  title: string;
  /** Subject line for email, latest message preview for messaging. */
  preview: string | null;
  timestamp: string | null;
  reason: InboxWaitingReason;
  /** Unread is a messaging-only idea; email has no read state to speak of. */
  unread: boolean;
}

export function isWaiting(item: Pick<InboxItem, 'reason'>): boolean {
  return item.reason !== 'none';
}

export function conversationItem(
  conversation: ConversationSummary,
  title: string,
): InboxItem {
  return {
    href: `#/inbox/${conversation.id}`,
    key: `conversation-${conversation.id}`,
    channel: conversation.channel,
    artist_id: conversation.artist_id,
    client_id: conversation.client_id,
    enquiry_id: conversation.enquiry_id,
    project_id: null,
    title,
    preview: conversation.latest_preview,
    timestamp: conversation.last_message_at,
    reason: conversationNeedsReply(conversation) ? 'client_replied' : 'none',
    unread: conversation.has_unread,
  };
}

export function emailItem(thread: EmailThread, title: string): InboxItem {
  return {
    href: `#/inbox/email/${thread.key}`,
    key: `email-${thread.key}`,
    channel: 'email',
    artist_id: thread.artist_id,
    client_id: thread.client_id,
    enquiry_id: thread.enquiry_id,
    project_id: thread.project_id,
    title,
    preview: thread.subject,
    timestamp: thread.last_activity_at,
    reason: threadNeedsOperator(thread)
      ? (thread.state === 'send_failed' ? 'send_failed' : 'draft_awaiting_approval')
      : 'none',
    // Email has no per-operator read state in this CRM, and inventing one from
    // "not yet sent" would put a badge on every outbound message.
    unread: false,
  };
}

/**
 * The merged queue: everything waiting on a person first, then by recency.
 *
 * A row with no timestamp sorts last rather than first - an undated row is
 * missing information, not fresh news.
 */
export function mergeInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const aWaiting = isWaiting(a) ? 0 : 1;
    const bWaiting = isWaiting(b) ? 0 : 1;
    if (aWaiting !== bWaiting) return aWaiting - bWaiting;
    const aAt = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
    const bAt = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(aAt) || Number.isNaN(bAt)) return 0;
    return bAt - aAt;
  });
}
