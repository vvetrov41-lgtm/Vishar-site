// Client workspace derivation.
//
// The CRM stores enquiries, projects, appointments, payment requests, follow-ups
// and conversations as separate records because the database needs them
// separate. The operator does not think that way: they think "Diana, half
// sleeve, deposit paid, Tuesday, waiting on my reply".
//
// Everything in this file is pure. It takes the records a client already owns
// and derives the small number of facts an operator actually asks for, plus the
// single next action those facts imply. Nothing here reads or writes; the page
// decides what to fetch and this decides what it means. That keeps the "what
// should I do next?" rule testable without a database.

import type { Appointment } from './appointment-api';
import { clientConversationNeedsReply, type ClientConversation } from './communications-api';
import type { Enquiry, FollowUp, Project } from './types';

/** Appointment states that still describe a real, future commitment. */
const LIVE_APPOINTMENT_STATUSES = new Set(['draft', 'proposed', 'confirmed']);

/** Enquiry states that still need the operator to do something. */
const OPEN_ENQUIRY_STATUSES = new Set([
  'new',
  'reviewing',
  'waiting_for_client',
  'accepted',
  'quote_sent',
  'deposit_requested',
  'deposit_paid',
]);

export type ClientNextActionKind =
  | 'reply'
  | 'follow_up'
  | 'confirm_appointment'
  | 'request_deposit'
  | 'book_session'
  | 'open_enquiry'
  | 'none';

export interface ClientNextAction {
  kind: ClientNextActionKind;
  /** In-app destination, or null when there is nothing to open. */
  href: string | null;
}

export interface ClientWorkspaceInput {
  clientId: string;
  enquiries: Enquiry[];
  projects: Project[];
  appointments: Appointment[];
  followUps: FollowUp[];
  conversations: ClientConversation[];
  now: Date;
}

export interface ClientWorkspaceSnapshot {
  /** Soonest appointment that has not happened yet and has not been cancelled. */
  nextAppointment: Appointment | null;
  /** Most recent appointment that has already started. */
  lastAppointment: Appointment | null;
  /** Future appointments still waiting for the operator to confirm them. */
  unconfirmedAppointments: Appointment[];
  /** The project whose deposit state the operator most needs to see. */
  depositProject: Project | null;
  /** The conversation with the most recent activity, whatever the channel. */
  latestConversation: ClientConversation | null;
  /** True when the client spoke last and nobody has read or answered it. */
  awaitingReply: boolean;
  openFollowUps: FollowUp[];
  overdueFollowUps: FollowUp[];
  openEnquiries: Enquiry[];
  activeProjects: Project[];
  nextAction: ClientNextAction;
}

function time(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function isLive(appointment: Appointment): boolean {
  return appointment.cancelled_at === null && LIVE_APPOINTMENT_STATUSES.has(appointment.status);
}

/**
 * "Has the deposit been paid?" is asked about the work in front of the client,
 * not about every project they have ever had. Prefer an active project, then the
 * most recently updated one, so a finished piece from last year does not answer
 * a question about the sleeve being booked now.
 */
function pickDepositProject(projects: Project[]): Project | null {
  const ranked = [...projects].sort((left, right) => {
    const leftActive = left.status === 'active' ? 0 : 1;
    const rightActive = right.status === 'active' ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return time(right.updated_at) - time(left.updated_at);
  });
  return ranked[0] ?? null;
}

/**
 * A conversation needs a reply when the client spoke last.
 *
 * Deliberately not "unread": opening a thread marks it read, so a conversation
 * the operator looked at and did not answer would stop being flagged while the
 * client carried on waiting. The rule lives in `communications-api` so the
 * inbox and the client workspace answer the question the same way.
 */
export function conversationAwaitsReply(conversation: ClientConversation): boolean {
  return clientConversationNeedsReply(conversation);
}

export function summariseClientWorkspace(input: ClientWorkspaceInput): ClientWorkspaceSnapshot {
  const nowMs = input.now.getTime();

  const live = input.appointments.filter(isLive);
  const future = live
    .filter((appointment) => time(appointment.start_at) >= nowMs)
    .sort((left, right) => time(left.start_at) - time(right.start_at));
  const past = input.appointments
    .filter((appointment) => appointment.cancelled_at === null && time(appointment.start_at) < nowMs)
    .sort((left, right) => time(right.start_at) - time(left.start_at));

  const nextAppointment = future[0] ?? null;
  const unconfirmedAppointments = future.filter(
    (appointment) => appointment.status === 'draft' || appointment.status === 'proposed'
  );

  const conversations = [...input.conversations].sort(
    (left, right) => time(right.last_message_at) - time(left.last_message_at)
  );
  const latestConversation = conversations[0] ?? null;
  const replyNeeded = conversations.find(conversationAwaitsReply) ?? null;

  const openFollowUps = input.followUps.filter((followUp) => followUp.status === 'open');
  const overdueFollowUps = openFollowUps
    .filter((followUp) => time(followUp.due_at) < nowMs)
    .sort((left, right) => time(left.due_at) - time(right.due_at));

  const openEnquiries = input.enquiries.filter((enquiry) => OPEN_ENQUIRY_STATUSES.has(enquiry.status));
  const activeProjects = input.projects.filter((project) => project.status === 'active');
  const depositProject = pickDepositProject(input.projects);

  return {
    nextAppointment,
    lastAppointment: past[0] ?? null,
    unconfirmedAppointments,
    depositProject,
    latestConversation,
    awaitingReply: replyNeeded !== null,
    openFollowUps,
    overdueFollowUps,
    openEnquiries,
    activeProjects,
    nextAction: deriveNextAction({
      clientId: input.clientId,
      replyNeeded,
      overdueFollowUps,
      unconfirmedAppointments,
      nextAppointment,
      depositProject,
      activeProjects,
      openEnquiries,
    }),
  };
}

/**
 * One recommended action, in the order an operator would actually work.
 *
 * A person waiting on a reply outranks everything: it is the only item where
 * delay is visible to the client. After that comes work the operator already
 * promised (an overdue follow-up), then commitments that are not yet firm (an
 * unconfirmed booking), then money, then scheduling, then triage.
 *
 * Each action is a destination, never a mutation. The action tells the operator
 * where the decision is made; the existing screen still makes it, with its own
 * permission checks and confirmations intact.
 */
function deriveNextAction(input: {
  clientId: string;
  replyNeeded: ClientConversation | null;
  overdueFollowUps: FollowUp[];
  unconfirmedAppointments: Appointment[];
  nextAppointment: Appointment | null;
  depositProject: Project | null;
  activeProjects: Project[];
  openEnquiries: Enquiry[];
}): ClientNextAction {
  if (input.replyNeeded) {
    return { kind: 'reply', href: `/inbox/${input.replyNeeded.id}` };
  }

  const overdue = input.overdueFollowUps[0];
  if (overdue) {
    return { kind: 'follow_up', href: followUpTarget(overdue, input.clientId) };
  }

  const unconfirmed = input.unconfirmedAppointments[0];
  if (unconfirmed) {
    return { kind: 'confirm_appointment', href: `/appointments/${unconfirmed.id}` };
  }

  // A booked session with an unsettled deposit is the one money question that
  // has a deadline attached to it.
  const deposit = input.depositProject;
  if (
    input.nextAppointment
    && deposit
    && deposit.deposit_status !== 'paid'
    && deposit.deposit_status !== 'not_required'
  ) {
    return { kind: 'request_deposit', href: `/projects/${deposit.id}` };
  }

  if (!input.nextAppointment) {
    const bookable = input.activeProjects[0];
    if (bookable) {
      return { kind: 'book_session', href: `/projects/${bookable.id}` };
    }
    const enquiry = input.openEnquiries[0];
    if (enquiry) {
      return { kind: 'open_enquiry', href: `/enquiries/${enquiry.id}` };
    }
  }

  return { kind: 'none', href: null };
}

function followUpTarget(followUp: FollowUp, clientId: string): string {
  if (followUp.enquiry_id) return `/enquiries/${followUp.enquiry_id}`;
  if (followUp.project_id) return `/projects/${followUp.project_id}`;
  return `/clients/${clientId}`;
}
