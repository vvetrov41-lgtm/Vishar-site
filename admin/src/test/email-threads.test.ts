// Grouping stored email into something the Inbox can queue.
//
// The module is pure and takes its rows explicitly, so the two rules that
// matter can be stated without a database: which thread a message belongs to,
// and which of a thread's states is the one the operator has to act on.

import { describe, expect, it } from 'vitest';
import {
  groupEmailThreads,
  stateFor,
  threadKeyFor,
  threadNeedsOperator,
} from '../lib/email-threads';
import type { EmailMessage } from '../lib/types';

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    artist_id: 'artist-1',
    status: 'draft',
    to_email: 'client@example.com',
    subject: 'Your session',
    created_by_kind: 'ai',
    created_at: '2026-07-01T09:00:00Z',
    client_id: 'client-1',
    enquiry_id: 'enquiry-1',
    project_id: null,
    approved_at: null,
    sent_at: null,
    failed_at: null,
    error_code: null,
    ...overrides,
  };
}

describe('thread identity', () => {
  it('groups on the record the Gmail thread context is keyed by', () => {
    // crm_private.gmail_thread_contexts is unique on (artist, enquiry, thread),
    // so the enquiry is the right grain - one CRM row per real conversation
    // rather than one per draft.
    expect(threadKeyFor(message())).toBe('enquiry-enquiry-1');
    expect(threadKeyFor(message({ enquiry_id: null }))).toBe('client-client-1');
  });

  it('keeps a message with no links rather than dropping it', () => {
    // A lifecycle email that lost its enquiry is still work; it just has
    // nothing to group with.
    expect(threadKeyFor(message({ id: 'm9', enquiry_id: null, client_id: null })))
      .toBe('message-m9');
  });
});

describe('what a thread is waiting on', () => {
  it('maps each stored status to the state an operator recognises', () => {
    expect(stateFor('failed')).toBe('send_failed');
    expect(stateFor('draft')).toBe('awaiting_approval');
    expect(stateFor('approved')).toBe('in_flight');
    expect(stateFor('queued')).toBe('in_flight');
    expect(stateFor('sent')).toBe('sent');
    expect(stateFor('cancelled')).toBe('closed');
  });

  it('counts only approval and failure as waiting on a person', () => {
    // Queued mail is waiting on the send worker, not on the operator, so it
    // must not sit in a queue titled "needs you".
    expect(threadNeedsOperator({ state: 'awaiting_approval' })).toBe(true);
    expect(threadNeedsOperator({ state: 'send_failed' })).toBe(true);
    expect(threadNeedsOperator({ state: 'in_flight' })).toBe(false);
    expect(threadNeedsOperator({ state: 'sent' })).toBe(false);
  });

  it('takes the most urgent state in the thread, not the newest message', () => {
    // Tuesday's failed send still needs somebody even though Wednesday brought
    // a fresh draft. Reading only the newest message would hide it.
    const [thread] = groupEmailThreads([
      message({ id: 'newer', status: 'draft', created_at: '2026-07-02T09:00:00Z' }),
      message({ id: 'older', status: 'failed', created_at: '2026-07-01T09:00:00Z' }),
    ]);
    expect(thread.state).toBe('send_failed');
    expect(thread.actionable_message_id).toBe('older');
  });

  it('names no actionable message when nothing is waiting', () => {
    const [thread] = groupEmailThreads([
      message({ id: 'done', status: 'sent', sent_at: '2026-07-01T10:00:00Z' }),
    ]);
    expect(thread.state).toBe('sent');
    expect(thread.actionable_message_id).toBeNull();
  });
});

describe('ordering', () => {
  it('puts work before history, then sorts by recency', () => {
    const threads = groupEmailThreads([
      message({ id: 'a', enquiry_id: 'e-old', status: 'sent', created_at: '2026-07-09T09:00:00Z' }),
      message({ id: 'b', enquiry_id: 'e-work', status: 'draft', created_at: '2026-07-01T09:00:00Z' }),
      message({ id: 'c', enquiry_id: 'e-recent', status: 'sent', created_at: '2026-07-10T09:00:00Z' }),
    ]);
    // The stale draft outranks both finished threads, however recent they are.
    expect(threads.map((thread) => thread.key)).toEqual([
      'enquiry-e-work',
      'enquiry-e-recent',
      'enquiry-e-old',
    ]);
  });

  it('carries the newest message subject and links onto the thread', () => {
    const [thread] = groupEmailThreads([
      message({ id: 'old', subject: 'First note', created_at: '2026-07-01T09:00:00Z', status: 'sent' }),
      message({ id: 'new', subject: 'Deposit link', created_at: '2026-07-05T09:00:00Z', status: 'sent', project_id: 'project-1' }),
    ]);
    expect(thread.subject).toBe('Deposit link');
    expect(thread.project_id).toBe('project-1');
    expect(thread.last_activity_at).toBe('2026-07-05T09:00:00Z');
    expect(thread.messages.map((entry) => entry.id)).toEqual(['new', 'old']);
  });
});
