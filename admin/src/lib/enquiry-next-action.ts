// The one thing this enquiry is waiting for.
//
// The enquiry page used to open with an "Enquiry actions" card holding every
// action at once: five status buttons, an assignee picker, Convert to project,
// a consultation panel and a booking panel, all the same size. Deciding what to
// do meant reading the whole card and knowing the workflow.
//
// This picks the action the current state is actually waiting on. It is a
// recommendation, not a restriction - every action stays reachable - and it is
// derived from state the CRM already holds, so it cannot claim something the
// workflow does not support.

import type { EnquiryStatus } from './types';

export type EnquiryNextAction =
  /** Intake is unfinished, so nothing can be booked from it yet. */
  | 'awaitIntake'
  /** A time is already agreed. Getting the client to confirm it is the work. */
  | 'awaitAppointment'
  /** The money is with the client. */
  | 'awaitDeposit'
  /** Nobody has answered this person yet. */
  | 'reply'
  /** The client owes an answer and has for a while. */
  | 'chase'
  /** The talking is done. Put it in the diary. */
  | 'bookSession'
  /** Declined or closed: there is no next action. */
  | 'none';

export interface EnquiryState {
  status: EnquiryStatus;
  intakeComplete: boolean;
  /** A proposed or confirmed appointment on this enquiry, still ahead. */
  hasUpcomingAppointment: boolean;
}

export function nextEnquiryAction(state: EnquiryState): EnquiryNextAction {
  if (state.status === 'declined' || state.status === 'closed') return 'none';

  // A booked time outranks the status. An enquiry that is still `new` because
  // nobody pressed a status button, but has a tattoo session on Tuesday, is
  // waiting for the client to confirm Tuesday - not for a first reply.
  if (state.hasUpcomingAppointment) return 'awaitAppointment';

  if (!state.intakeComplete) return 'awaitIntake';
  if (state.status === 'deposit_requested') return 'awaitDeposit';
  if (state.status === 'waiting_for_client') return 'chase';
  if (state.status === 'new' || state.status === 'reviewing') return 'reply';
  return 'bookSession';
}
