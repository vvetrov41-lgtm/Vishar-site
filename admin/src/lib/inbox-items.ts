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
import type { GmailInboxClient } from './email-api';
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

/** Anything carrying the two links that decide whether a row is studio work. */
export interface CrmLinked {
  client_id: string | null;
  enquiry_id: string | null;
}

/**
 * The one boundary between work and noise, asked in one place.
 *
 * A stranger messaging the studio number is a real inbound event and is kept -
 * the webhook record, the message, the audit trail all survive. What it is not
 * is a job: nobody owes an answer to somebody the CRM cannot name, and a queue
 * that says otherwise teaches the operator to ignore it.
 *
 * So every operator surface - the Inbox list, Needs reply, Today, and anything
 * that counts them - asks this single question instead of each inventing its
 * own rule and drifting.
 *
 * Linked means the row has reached a CRM record: a client, or an enquiry -
 * which carries a client of its own, since `enquiries.client_id` is NOT NULL.
 * The database says the same thing from the other side: a CHECK on
 * `communication_conversations` ties `link_state = 'linked'` to a non-null
 * `client_id` (0069), so the server-side filter and this predicate cannot
 * disagree.
 */
export function isActionableConversation(row: CrmLinked): boolean {
  return row.client_id !== null || row.enquiry_id !== null;
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

/**
 * A known client's Gmail activity that the CRM has no stored message for.
 *
 * Keyed exactly like an email thread for the same client, so the two collapse
 * into one row rather than showing the same person twice - see `mergeInbox`.
 *
 * Unlike stored email, this one CAN say the client spoke last, because
 * discovery read the mailbox and knows the direction of the newest message.
 * That is the honest answer here, and it is why a first-time email from a
 * known client can reach Needs reply at all.
 */
export function gmailDiscoveryItem(
  client: GmailInboxClient,
  artistId: string,
): InboxItem {
  return {
    href: `#/inbox/email/client-${client.client_id}`,
    key: `email-client-${client.client_id}`,
    channel: 'email',
    artist_id: artistId,
    client_id: client.client_id,
    enquiry_id: null,
    project_id: null,
    title: client.client_name ?? '',
    preview: client.subject,
    timestamp: client.last_message_at,
    reason: client.direction === 'inbound' ? 'client_replied' : 'none',
    unread: false,
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
  const byIdentity = new Map<string, InboxItem>();
  for (const item of items) {
    const identity = inboxIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      continue;
    }
    byIdentity.set(identity, mergeSameConversation(existing, item));
  }

  return [...byIdentity.values()].sort((a, b) => {
    const aWaiting = isWaiting(a) ? 0 : 1;
    const bWaiting = isWaiting(b) ? 0 : 1;
    if (aWaiting !== bWaiting) return aWaiting - bWaiting;
    const aAt = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
    const bAt = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(aAt) || Number.isNaN(bAt)) return 0;
    return bAt - aAt;
  });
}

/**
 * What makes two rows the same conversation.
 *
 * For email it is the CLIENT, not the row's own key. The same person reaches
 * this list from two places - a stored CRM email, which may be keyed by
 * enquiry, and mailbox discovery, which knows only the client - and showing
 * them twice would be exactly the duplication the client-scoped design exists
 * to prevent, just relocated from the database into the list.
 *
 * Messaging conversations keep their own identity: two WhatsApp threads with
 * one client are genuinely two threads.
 */
function inboxIdentity(item: InboxItem): string {
  return item.channel === 'email' && item.client_id
    ? `email-client-${item.client_id}`
    : item.key;
}

/**
 * Fold a discovery row into the stored row for the same client.
 *
 * The stored row wins on identity and destination, because it carries the
 * CRM's own context - enquiry, project, delivery state - and discovery has
 * none of that. What discovery contributes is the one thing stored email
 * cannot know: that the client has since written back.
 */
function mergeSameConversation(left: InboxItem, right: InboxItem): InboxItem {
  const discovered = left.enquiry_id === null && left.project_id === null && right.enquiry_id !== null
    ? left
    : right.enquiry_id === null && right.project_id === null
      ? right
      : left;
  const stored = discovered === left ? right : left;
  return {
    ...stored,
    timestamp: newerOf(stored.timestamp, discovered.timestamp),
    preview: stored.preview ?? discovered.preview,
    // A waiting reason from either side still means somebody is waiting, and a
    // client who replied outranks a draft nobody approved.
    reason: discovered.reason === 'client_replied'
      ? 'client_replied'
      : stored.reason !== 'none' ? stored.reason : discovered.reason,
    unread: stored.unread || discovered.unread,
  };
}

function newerOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left)) return b;
  if (!Number.isFinite(right)) return a;
  return right > left ? b : a;
}
