// Calendar provider interface.
//
// NO PROVIDER IS BOUND. Google Calendar is not connected, no OAuth flow has
// been completed, and nothing in this repository can create a calendar event.
//
// Two rules shape everything here:
//
//   1. `sessions` is authoritative. The calendar is a projection of it, never
//      the reverse. Reconciliation moves the provider towards the database.
//   2. Only a CONFIRMED session is eligible. A draft or proposed session never
//      produces an event, so a tentative date cannot appear in the artist's
//      calendar as though it were booked.
//
// Rule 2 is enforced in three independent places: `session_is_calendar_eligible`
// in the database, a CHECK constraint that refuses a `calendar_event_id` on a
// draft or proposed session, and `isEligible` below. A provider id is stored
// only after the provider has actually accepted the event.

import { calendarDedupeKey } from './outbox.js';

export const CONFIRMED_STATUS = 'confirmed';

export class CalendarNotConnectedError extends Error {
  constructor(operation) {
    super(`calendar provider not connected (${operation})`);
    this.name = 'CalendarNotConnectedError';
    this.code = 'calendar_provider_not_connected';
  }
}

/** Mirrors `public.session_is_calendar_eligible`. */
export function isEligible(session) {
  return session?.status === CONFIRMED_STATUS;
}

/**
 * The job identity for one logical calendar action. A retry that re-enqueues
 * the same action collides on the unique dedupe key instead of producing a
 * second event.
 */
export function dedupeKeyFor(action, session) {
  return calendarDedupeKey(action, session.id, session.calendar_version ?? 0);
}

/**
 * Decides what the provider should be asked to do for a session, without
 * asking it. Pure, so the rules are testable with no provider at all.
 *
 * - `none`   nothing to do: not confirmed and never was.
 * - `create` confirmed, no event yet.
 * - `update` confirmed, event exists.
 * - `cancel` no longer confirmed, but an event exists that must be withdrawn.
 */
export function planCalendarAction(session) {
  const hasEvent = Boolean(session?.calendar_event_id);

  if (isEligible(session)) {
    return { action: hasEvent ? 'update' : 'create', dedupeKey: dedupeKeyFor(hasEvent ? 'update' : 'create', session) };
  }

  if (hasEvent) {
    return { action: 'cancel', dedupeKey: dedupeKeyFor('cancel', session) };
  }

  return { action: 'none', dedupeKey: null };
}

/**
 * @typedef {object} CalendarProvider
 * @property {(event: object) => Promise<{providerEventId: string}>} createEvent
 * @property {(providerEventId: string, event: object) => Promise<void>} updateEvent
 * @property {(providerEventId: string) => Promise<void>} cancelEvent
 * @property {(providerEventId: string) => Promise<{status: string}|null>} getEvent
 */

export function createCalendarService(provider = null) {
  function guard(operation, session) {
    if (!isEligible(session)) {
      throw new Error(`only a ${CONFIRMED_STATUS} session may be sent to a calendar (${operation})`);
    }
    if (!provider) throw new CalendarNotConnectedError(operation);
  }

  return {
    async createConfirmedEvent(session, event) {
      guard('create', session);
      // The provider id is returned to the caller to store only after the
      // provider has accepted it. Nothing is written speculatively.
      return provider.createEvent(event);
    },

    async updateConfirmedEvent(session, event) {
      guard('update', session);
      if (!session.calendar_event_id) throw new Error('no provider event to update');
      return provider.updateEvent(session.calendar_event_id, event);
    },

    async cancelConfirmedEvent(session) {
      if (!provider) throw new CalendarNotConnectedError('cancel');
      if (!session.calendar_event_id) return { cancelled: false, reason: 'no_event' };
      await provider.cancelEvent(session.calendar_event_id);
      return { cancelled: true };
    },

    /**
     * Compares provider state against the database and reports the difference.
     * It reports; it does not silently "fix" the database to match a calendar
     * someone edited by hand — the session row is the record.
     */
    async reconcile(sessions) {
      if (!provider) throw new CalendarNotConnectedError('reconcile');

      const differences = [];
      for (const session of sessions) {
        const plan = planCalendarAction(session);
        if (plan.action === 'none') continue;

        const remote = session.calendar_event_id
          ? await provider.getEvent(session.calendar_event_id)
          : null;

        if (plan.action === 'create' && !remote) {
          differences.push({ sessionId: session.id, action: 'create', dedupeKey: plan.dedupeKey });
        } else if (plan.action === 'cancel' && remote) {
          differences.push({ sessionId: session.id, action: 'cancel', dedupeKey: plan.dedupeKey });
        } else if (plan.action === 'update' && !remote) {
          differences.push({ sessionId: session.id, action: 'recreate', dedupeKey: plan.dedupeKey });
        }
      }
      return differences;
    },

    isConnected() {
      return provider !== null;
    },
  };
}
