// Email as a channel the Inbox can actually reason about.
//
// READ THIS BEFORE EXTENDING IT.
//
// The CRM does not store inbound email. `public.email_messages` carries
// `to_email` and no direction: it is an outbound draft -> approve -> queue ->
// send pipeline (0005, 0007, 0020, 0059). Inbound mail is read live from the
// Gmail API by the Gmail Worker, per enquiry, under a GPT OAuth context that a
// CRM operator session cannot hold.
//
// So this module deliberately does NOT answer "has the client replied?" for
// email. Claiming that from stored data would be a lie, and inventing a
// needs-reply flag the database cannot support is exactly the failure the
// unified Inbox is meant to avoid.
//
// What it does answer is the half that IS authoritative, and that nothing in
// the CRM showed before: a draft is sitting unapproved, or a send failed.
// Both are work waiting on the operator - a GPT or a lifecycle automation
// writes a draft, and until somebody approves it, it never leaves.

import type { EmailMessage, EmailStatus } from './types';

/** Work the operator owns, in the order it should interrupt them. */
export type EmailThreadState = 'send_failed' | 'awaiting_approval' | 'in_flight' | 'sent' | 'closed';

const STATE_ORDER: EmailThreadState[] = [
  'send_failed',
  'awaiting_approval',
  'in_flight',
  'sent',
  'closed',
];

export interface EmailThread {
  /** Stable, URL-safe key: the record the Gmail thread context is keyed by. */
  key: string;
  artist_id: string;
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  to_email: string;
  subject: string;
  last_activity_at: string;
  state: EmailThreadState;
  /** The message the state refers to, so the screen can act on exactly it. */
  actionable_message_id: string | null;
  messages: EmailMessage[];
}

/**
 * A thread is the record the Gmail thread context itself is keyed by
 * (artist, enquiry, client) - so grouping this way keeps one CRM row per real
 * email conversation rather than one per draft.
 */
export function threadKeyFor(message: Pick<EmailMessage, 'enquiry_id' | 'client_id' | 'id'>): string {
  if (message.enquiry_id) return `enquiry-${message.enquiry_id}`;
  if (message.client_id) return `client-${message.client_id}`;
  // A message attached to neither is still real work; it just has no context
  // to group with, so it stands alone rather than being dropped.
  return `message-${message.id}`;
}

export function stateFor(status: EmailStatus): EmailThreadState {
  if (status === 'failed') return 'send_failed';
  if (status === 'draft') return 'awaiting_approval';
  if (status === 'approved' || status === 'queued') return 'in_flight';
  if (status === 'sent') return 'sent';
  return 'closed';
}

/** True when the thread is waiting on a person, not on a machine. */
export function threadNeedsOperator(thread: Pick<EmailThread, 'state'>): boolean {
  return thread.state === 'awaiting_approval' || thread.state === 'send_failed';
}

/**
 * Group messages into threads, newest activity first.
 *
 * The thread's state is the most urgent state any of its messages is in, not
 * the newest one's: a failed send from Tuesday still needs the operator even
 * if a fresh draft was written on Wednesday.
 */
export function groupEmailThreads(messages: EmailMessage[]): EmailThread[] {
  const threads = new Map<string, EmailMessage[]>();
  for (const message of messages) {
    const key = threadKeyFor(message);
    const bucket = threads.get(key) ?? [];
    bucket.push(message);
    threads.set(key, bucket);
  }

  const built: EmailThread[] = [];
  for (const [key, bucket] of threads) {
    const ordered = [...bucket].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    const newest = ordered[0];
    const state = mostUrgentState(ordered);
    const actionable = ordered.find((message) => stateFor(message.status) === state) ?? null;
    built.push({
      key,
      artist_id: newest.artist_id,
      client_id: newest.client_id ?? null,
      enquiry_id: newest.enquiry_id ?? null,
      project_id: newest.project_id ?? null,
      to_email: newest.to_email,
      subject: newest.subject,
      last_activity_at: newest.created_at,
      state,
      actionable_message_id: threadNeedsOperator({ state }) ? (actionable?.id ?? null) : null,
      messages: ordered,
    });
  }

  return built.sort((a, b) => {
    // Work first, then recency. An operator opening this screen is looking for
    // what to do, not for what happened.
    const aWork = threadNeedsOperator(a) ? 0 : 1;
    const bWork = threadNeedsOperator(b) ? 0 : 1;
    if (aWork !== bWork) return aWork - bWork;
    return Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at);
  });
}

function mostUrgentState(messages: EmailMessage[]): EmailThreadState {
  let best = STATE_ORDER.length - 1;
  for (const message of messages) {
    const index = STATE_ORDER.indexOf(stateFor(message.status));
    if (index >= 0 && index < best) best = index;
  }
  return STATE_ORDER[best];
}
