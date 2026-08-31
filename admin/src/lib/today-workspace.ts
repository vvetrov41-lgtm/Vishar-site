// The daily triage list.
//
// The Dashboard answered three of the eight questions an operator has when they
// open the CRM in the morning, and its visual anchor was three enquiry counters.
// A counter is not work: it tells you a number and then makes you go somewhere
// else to act on it.
//
// This module turns the records the operator can already read into a list of
// things that need them, each one carrying who it is about and where it is
// dealt with. It is deliberately not an analytics surface: nothing here counts
// anything the operator cannot act on.
//
// Pure, and given `now` explicitly, so the ordering rules are tested directly.

import type { Appointment } from './appointment-api';
import { conversationNeedsReply, type ConversationSummary } from './communications-api';
import { threadNeedsOperator, type EmailThread } from './email-threads';
import type { MonzoReconciliationCandidate } from './payment-api';
import type { Enquiry, FollowUp, Project } from './types';

export type TodayItemKind =
  | 'reschedule_requested'
  | 'reply'
  | 'email_send_failed'
  | 'email_draft_to_approve'
  | 'payment_to_confirm'
  | 'unconfirmed_appointment'
  | 'deposit_outstanding'
  | 'new_enquiry'
  | 'overdue_follow_up'
  | 'integration_failure';

/**
 * Client-originated work first: those are the items where the delay is visible
 * to someone outside the studio. Then money that has already arrived, then
 * commitments that are not yet firm, then triage, then the system talking about
 * itself.
 */
const KIND_ORDER: TodayItemKind[] = [
  'reschedule_requested',
  'reply',
  // A send that failed is a message the client is still waiting for and does
  // not know is stuck, so it ranks with the other client-visible delays. A
  // draft nobody approved is the same delay one step earlier.
  'email_send_failed',
  'email_draft_to_approve',
  'payment_to_confirm',
  'unconfirmed_appointment',
  'deposit_outstanding',
  'new_enquiry',
  'overdue_follow_up',
  'integration_failure',
];

export interface TodayItem {
  key: string;
  kind: TodayItemKind;
  /** Where the item is dealt with. Null only when nothing can be opened. */
  href: string | null;
  /** Who it is about, when the record knows. */
  subject: string | null;
  /** The time the row is anchored to, for display and ordering. */
  at: string | null;
  /** One extra fact the row renders: a channel, an amount, a due label. */
  detail: string | null;
  urgent: boolean;
}

export interface TodaySnapshot {
  needsYou: TodayItem[];
  /** Appointments starting today, in the operator's own timezone. */
  today: Appointment[];
  /** The next seven days after today. */
  ahead: Appointment[];
}

export interface TodayInput {
  now: Date;
  appointments: Appointment[];
  enquiries: Enquiry[];
  projects: Project[];
  followUps: FollowUp[];
  conversations: ConversationSummary[];
  /** Grouped email threads, so drafts and failed sends stop being invisible. */
  emailThreads: EmailThread[];
  reconciliationCandidates: MonzoReconciliationCandidate[];
  failedJobCount: number;
  /** Resolves a client id to a name, so no row is identified by a uuid. */
  clientName: (clientId: string) => string | null;
}

const LIVE_STATUSES = new Set(['draft', 'proposed', 'confirmed']);

function time(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function summariseToday(input: TodayInput): TodaySnapshot {
  const nowMs = input.now.getTime();
  const dayStart = startOfDay(input.now);
  const dayEnd = dayStart + 86400000;
  const aheadEnd = dayEnd + 7 * 86400000;

  const live = input.appointments.filter(
    (appointment) => appointment.cancelled_at === null && LIVE_STATUSES.has(appointment.status)
  );
  const byStart = (left: Appointment, right: Appointment) => time(left.start_at) - time(right.start_at);

  const today = live
    .filter((appointment) => {
      const start = time(appointment.start_at);
      return start >= dayStart && start < dayEnd;
    })
    .sort(byStart);

  const ahead = live
    .filter((appointment) => {
      const start = time(appointment.start_at);
      return start >= dayEnd && start < aheadEnd;
    })
    .sort(byStart);

  const items: TodayItem[] = [];

  // A client asking to move a booked time is the one item that gets worse the
  // longer it sits: the slot stays held and the client stays uncertain.
  for (const appointment of live) {
    if (appointment.client_response !== 'reschedule_requested') continue;
    if (time(appointment.start_at) < nowMs) continue;
    items.push({
      key: `reschedule-${appointment.id}`,
      kind: 'reschedule_requested',
      href: `/appointments/${appointment.id}`,
      subject: input.clientName(appointment.client_id),
      at: appointment.start_at,
      detail: null,
      urgent: true,
    });
  }

  // Needing a reply, not being unread: opening a thread marks it read, so an
  // unread-only rule dropped conversations the operator had looked at and not
  // answered while the client carried on waiting.
  for (const conversation of input.conversations) {
    if (!conversationNeedsReply(conversation)) continue;
    items.push({
      key: `reply-${conversation.id}`,
      kind: 'reply',
      href: `/inbox/${conversation.id}`,
      subject: conversation.client_name
        ?? conversation.external_display_label
        ?? conversation.external_username,
      at: conversation.last_inbound_at ?? conversation.last_message_at,
      detail: conversation.channel,
      urgent: true,
    });
  }

  // Email the CRM drafted or failed to deliver. The CRM stores no inbound
  // mail, so email cannot contribute a "they replied" row; what it can
  // contribute is work that is genuinely stuck on this side.
  for (const thread of input.emailThreads) {
    if (!threadNeedsOperator(thread)) continue;
    items.push({
      key: `email-${thread.key}`,
      kind: thread.state === 'send_failed' ? 'email_send_failed' : 'email_draft_to_approve',
      href: `/inbox/email/${thread.key}`,
      subject: (thread.client_id ? input.clientName(thread.client_id) : null) ?? thread.to_email,
      at: thread.last_activity_at,
      detail: thread.subject,
      urgent: true,
    });
  }

  // Money that has already landed and only needs agreeing with. The server has
  // done the matching; this exists so the operator is told, rather than having
  // to go and look.
  for (const candidate of input.reconciliationCandidates) {
    if (candidate.confirmed) continue;
    const request = candidate.matched_payment_request ?? candidate.suggested_payment_request;
    if (!request) continue;
    items.push({
      key: `payment-${candidate.id}`,
      kind: 'payment_to_confirm',
      href: '/payments',
      subject: request.client_name,
      at: candidate.occurred_at,
      detail: `${candidate.amount} ${candidate.currency}`,
      urgent: false,
    });
  }

  // A proposed appointment appears on no worklist today, so it is remembered
  // only by whoever created it.
  for (const appointment of live) {
    if (appointment.status !== 'proposed' && appointment.status !== 'draft') continue;
    if (time(appointment.start_at) < nowMs) continue;
    items.push({
      key: `unconfirmed-${appointment.id}`,
      kind: 'unconfirmed_appointment',
      href: `/appointments/${appointment.id}`,
      subject: input.clientName(appointment.client_id),
      at: appointment.start_at,
      detail: null,
      urgent: false,
    });
  }

  // A booked session whose project deposit is still outstanding. Reported once
  // per project, anchored to the soonest session it affects.
  const bookedProjects = new Map<string, Appointment>();
  for (const appointment of live) {
    if (!appointment.project_id) continue;
    if (time(appointment.start_at) < nowMs) continue;
    const existing = bookedProjects.get(appointment.project_id);
    if (!existing || time(appointment.start_at) < time(existing.start_at)) {
      bookedProjects.set(appointment.project_id, appointment);
    }
  }
  for (const project of input.projects) {
    const appointment = bookedProjects.get(project.id);
    if (!appointment) continue;
    if (project.deposit_status === 'paid' || project.deposit_status === 'not_required') continue;
    items.push({
      key: `deposit-${project.id}`,
      kind: 'deposit_outstanding',
      href: `/projects/${project.id}`,
      subject: input.clientName(project.client_id),
      at: appointment.start_at,
      detail: project.deposit_status,
      urgent: false,
    });
  }

  for (const enquiry of input.enquiries) {
    if (enquiry.status !== 'new') continue;
    items.push({
      key: `enquiry-${enquiry.id}`,
      kind: 'new_enquiry',
      href: `/enquiries/${enquiry.id}`,
      subject: input.clientName(enquiry.client_id),
      at: enquiry.created_at,
      detail: enquiry.project_type,
      urgent: false,
    });
  }

  for (const followUp of input.followUps) {
    if (followUp.status !== 'open') continue;
    if (time(followUp.due_at) >= nowMs) continue;
    items.push({
      key: `follow-up-${followUp.id}`,
      kind: 'overdue_follow_up',
      href: followUpTarget(followUp),
      subject: followUp.subject,
      at: followUp.due_at,
      detail: null,
      urgent: false,
    });
  }

  // Integration failures are grouped into one row. The detail belongs on the
  // integrations screen; what belongs here is that something needs looking at.
  if (input.failedJobCount > 0) {
    items.push({
      key: 'integration-failures',
      kind: 'integration_failure',
      href: '/integrations',
      subject: null,
      at: null,
      detail: String(input.failedJobCount),
      urgent: false,
    });
  }

  items.sort((left, right) => {
    const kindDelta = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
    if (kindDelta !== 0) return kindDelta;
    const leftAt = time(left.at);
    const rightAt = time(right.at);
    if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return 0;
    if (Number.isNaN(leftAt)) return 1;
    if (Number.isNaN(rightAt)) return -1;
    return leftAt - rightAt;
  });

  return { needsYou: items, today, ahead };
}

function followUpTarget(followUp: FollowUp): string | null {
  if (followUp.enquiry_id) return `/enquiries/${followUp.enquiry_id}`;
  if (followUp.project_id) return `/projects/${followUp.project_id}`;
  if (followUp.client_id) return `/clients/${followUp.client_id}`;
  return null;
}
