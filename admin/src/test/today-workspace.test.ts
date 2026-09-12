// The triage list's reasoning, tested without a database.
//
// What appears on the first screen of the day, and in what order, is a product
// rule. It is exercised here directly against records so the ordering cannot
// drift silently behind a rendering change.

import { describe, expect, it } from 'vitest';
import { summariseToday, type TodayInput } from '../lib/today-workspace';
import type { Appointment } from '../lib/appointment-api';
import type { ConversationSummary } from '../lib/communications-api';
import type { MonzoReconciliationCandidate } from '../lib/payment-api';
import type { Enquiry, FollowUp, Project } from '../lib/types';

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Midday, so "today" has room either side of it in the local timezone the
// operator's browser reports.
const NOW = new Date('2026-08-30T12:00:00Z');

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appointment-1',
    artist_id: ARTIST_ID,
    client_id: CLIENT_ID,
    enquiry_id: null,
    project_id: 'project-1',
    appointment_type: 'tattoo_session',
    status: 'confirmed',
    start_at: '2026-09-03T10:00:00Z',
    end_at: '2026-09-03T16:00:00Z',
    duration_hours: 6,
    currency: 'GBP',
    payment_status: 'unpaid',
    calendar_provider: 'none',
    calendar_event_id: null,
    calendar_version: 0,
    calendar_sync_status: 'not_connected',
    calendar_last_synced_version: null,
    calendar_last_synced_at: null,
    calendar_last_error_code: null,
    client_response: null,
    client_response_at: null,
    client_response_calendar_version: null,
    notes: null,
    cancelled_at: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conversation-1',
    artist_id: ARTIST_ID,
    channel: 'whatsapp',
    link_state: 'linked',
    state: 'open',
    client_id: CLIENT_ID,
    client_name: 'Fixture Client',
    enquiry_id: null,
    external_username: null,
    external_display_label: null,
    last_message_at: '2026-08-30T09:00:00Z',
    last_inbound_at: '2026-08-30T09:00:00Z',
    operator_read_at: null,
    has_unread: true,
    latest_preview: 'Can we move Thursday?',
    latest_direction: 'inbound',
    latest_message_type: 'text',
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    artist_id: ARTIST_ID,
    client_id: CLIENT_ID,
    enquiry_id: null,
    status: 'active',
    title: 'Raven sleeve',
    description: null,
    estimated_sessions: 3,
    estimated_hours: 18,
    deposit_status: 'requested',
    currency: 'GBP',
    created_at: '2026-07-02T09:00:00Z',
    updated_at: '2026-07-02T09:00:00Z',
    archived_at: null,
    ...overrides,
  };
}

function followUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: 'follow-up-1',
    artist_id: ARTIST_ID,
    status: 'open',
    due_at: '2026-08-25T09:00:00Z',
    subject: 'Chase references',
    details: null,
    client_id: CLIENT_ID,
    enquiry_id: 'enquiry-1',
    project_id: null,
    assigned_to: null,
    ...overrides,
  };
}

function enquiry(overrides: Partial<Enquiry> = {}): Enquiry {
  return {
    id: 'enquiry-1',
    artist_id: ARTIST_ID,
    client_id: CLIENT_ID,
    reference_number: 'ENQ-2026-0001',
    status: 'new',
    intake_state: 'complete',
    intake_error_code: null,
    client_identifier_conflict: false,
    assigned_to: null,
    project_type: 'Colour realism',
    placement: null,
    approximate_size: null,
    cover_up: null,
    preferred_timing: null,
    idea: null,
    source: null,
    utm_source: null,
    created_at: '2026-08-29T09:00:00Z',
    last_action_at: '2026-08-29T09:00:00Z',
    archived_at: null,
    ...overrides,
  } as Enquiry;
}

function candidate(overrides: Partial<MonzoReconciliationCandidate> = {}): MonzoReconciliationCandidate {
  return {
    id: 'candidate-1',
    amount: 150,
    currency: 'GBP',
    occurred_at: '2026-08-29T18:00:00Z',
    status: 'candidate',
    confirmed: false,
    suggested_payment_request: {
      payment_request_id: 'request-1',
      client_name: 'Fixture Client',
      purpose: 'deposit',
      request_status: 'sent',
      amount: 150,
      outstanding_amount: 150,
      currency: 'GBP',
      session_start_at: null,
      session_end_at: null,
    },
    matched_payment_request: null,
    match_options: [],
    ...overrides,
  };
}

function input(overrides: Partial<TodayInput> = {}): TodayInput {
  return {
    now: NOW,
    appointments: [],
    enquiries: [],
    projects: [],
    followUps: [],
    conversations: [],
    emailThreads: [],
    gmailAwaitingReply: [],
    acknowledgements: [],
    reconciliationCandidates: [],
    failedJobCount: 0,
    clientName: () => 'Fixture Client',
    ...overrides,
  };
}

describe("today's schedule", () => {
  it('separates today from the next seven days and ignores anything further out', () => {
    const snapshot = summariseToday(input({
      appointments: [
        appointment({ id: 'today', start_at: '2026-08-30T15:00:00Z', end_at: '2026-08-30T18:00:00Z' }),
        appointment({ id: 'tomorrow', start_at: '2026-08-31T10:00:00Z' }),
        appointment({ id: 'far', start_at: '2026-10-01T10:00:00Z' }),
      ],
    }));

    expect(snapshot.today.map((entry) => entry.id)).toEqual(['today']);
    expect(snapshot.ahead.map((entry) => entry.id)).toEqual(['tomorrow']);
  });

  it('keeps cancelled and completed bookings off the schedule', () => {
    const snapshot = summariseToday(input({
      appointments: [
        appointment({ id: 'cancelled', start_at: '2026-08-30T15:00:00Z', status: 'cancelled', cancelled_at: '2026-08-20T10:00:00Z' }),
        appointment({ id: 'completed', start_at: '2026-08-30T09:00:00Z', status: 'completed' }),
      ],
    }));

    expect(snapshot.today).toHaveLength(0);
  });
});

describe('needs you now', () => {
  it('puts client-originated work above money, commitments and triage', () => {
    const snapshot = summariseToday(input({
      appointments: [
        appointment({ id: 'moving', client_response: 'reschedule_requested' }),
        appointment({ id: 'held', status: 'proposed', project_id: 'project-2' }),
      ],
      conversations: [conversation()],
      reconciliationCandidates: [candidate()],
      projects: [project()],
      enquiries: [enquiry({ id: 'enquiry-2', client_id: 'client-2' })],
      followUps: [followUp()],
      failedJobCount: 2,
    }));

    expect(snapshot.needsYou.map((item) => item.kind)).toEqual([
      'reschedule_requested',
      'reply',
      'payment_to_confirm',
      'unconfirmed_appointment',
      'deposit_outstanding',
      'new_enquiry',
      'overdue_follow_up',
      'integration_failure',
    ]);
  });

  it('names a person on every row that has one, and opens where the work is done', () => {
    const snapshot = summariseToday(input({
      conversations: [conversation({ id: 'waiting' })],
      followUps: [followUp({ id: 'late', enquiry_id: 'enquiry-9' })],
    }));

    const reply = snapshot.needsYou.find((item) => item.kind === 'reply');
    expect(reply?.subject).toBe('Fixture Client');
    expect(reply?.href).toBe('/inbox/waiting');

    const overdue = snapshot.needsYou.find((item) => item.kind === 'overdue_follow_up');
    expect(overdue?.href).toBe('/enquiries/enquiry-9');
  });

  it('says nothing needs the operator when nothing does', () => {
    const snapshot = summariseToday(input({
      appointments: [appointment({ status: 'confirmed' })],
      projects: [project({ deposit_status: 'paid' })],
      conversations: [conversation({ has_unread: false, latest_direction: 'outbound' })],
      enquiries: [enquiry({ status: 'converted' })],
      followUps: [followUp({ due_at: '2026-09-30T09:00:00Z' })],
      reconciliationCandidates: [candidate({ confirmed: true })],
    }));

    expect(snapshot.needsYou).toHaveLength(0);
  });

  it('does not chase a deposit that is paid or not required', () => {
    for (const depositStatus of ['paid', 'not_required'] as const) {
      const snapshot = summariseToday(input({
        appointments: [appointment()],
        projects: [project({ deposit_status: depositStatus })],
      }));
      expect(snapshot.needsYou.some((item) => item.kind === 'deposit_outstanding')).toBe(false);
    }
  });

  it('chases a deposit only when a session is actually booked', () => {
    const withoutBooking = summariseToday(input({ projects: [project()] }));
    expect(withoutBooking.needsYou.some((item) => item.kind === 'deposit_outstanding')).toBe(false);

    const withBooking = summariseToday(input({
      appointments: [appointment()],
      projects: [project()],
    }));
    expect(withBooking.needsYou.some((item) => item.kind === 'deposit_outstanding')).toBe(true);
  });

  it('waits until a requested deposit is within the next seven days', () => {
    const snapshot = summariseToday(input({
      appointments: [appointment({ start_at: '2026-11-17T11:00:00Z' })],
      projects: [project()],
    }));

    expect(snapshot.needsYou.some((item) => item.kind === 'deposit_outstanding')).toBe(false);
  });

  it('never raises a booking that has already started', () => {
    const snapshot = summariseToday(input({
      appointments: [
        appointment({ id: 'past-proposed', status: 'proposed', start_at: '2026-08-01T10:00:00Z' }),
        appointment({ id: 'past-moving', client_response: 'reschedule_requested', start_at: '2026-08-01T10:00:00Z' }),
      ],
    }));

    expect(snapshot.needsYou).toHaveLength(0);
  });

  it('reports one deposit row per project, anchored to the soonest session', () => {
    const snapshot = summariseToday(input({
      appointments: [
        appointment({ id: 'later', start_at: '2026-09-20T10:00:00Z' }),
        appointment({ id: 'sooner', start_at: '2026-09-03T10:00:00Z' }),
      ],
      projects: [project()],
    }));

    const deposits = snapshot.needsYou.filter((item) => item.kind === 'deposit_outstanding');
    expect(deposits).toHaveLength(1);
    expect(deposits[0].at).toBe('2026-09-03T10:00:00Z');
  });

  it('groups integration failures into one row rather than one per job', () => {
    const snapshot = summariseToday(input({ failedJobCount: 7 }));
    const failures = snapshot.needsYou.filter((item) => item.kind === 'integration_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toBe('7');
    expect(failures[0].subject).toBeNull();
  });

  it('orders rows of the same kind oldest first, so the longest wait is on top', () => {
    const snapshot = summariseToday(input({
      conversations: [
        conversation({ id: 'newer', last_inbound_at: '2026-08-30T11:00:00Z' }),
        conversation({ id: 'older', last_inbound_at: '2026-08-28T11:00:00Z' }),
      ],
    }));

    expect(snapshot.needsYou.map((item) => item.href)).toEqual(['/inbox/older', '/inbox/newer']);
  });

  it('does not duplicate a new enquiry once a real conversation has started', () => {
    const snapshot = summariseToday(input({
      enquiries: [enquiry()],
      conversations: [conversation({
        enquiry_id: 'enquiry-1',
        client_id: CLIENT_ID,
        last_message_at: '2026-08-30T09:00:00Z',
        last_inbound_at: '2026-08-30T09:00:00Z',
      })],
    }));

    expect(snapshot.needsYou.map((item) => item.kind)).toEqual(['reply']);
  });

  it('keeps a new enquiry visible when its only email is a paused machine draft', () => {
    const snapshot = summariseToday(input({
      enquiries: [enquiry()],
      emailThreads: [{
        key: 'enquiry-enquiry-1',
        artist_id: ARTIST_ID,
        client_id: CLIENT_ID,
        enquiry_id: 'enquiry-1',
        project_id: null,
        to_email: 'fixture@example.test',
        subject: 'Draft reply',
        last_activity_at: '2026-08-30T09:00:00Z',
        state: 'closed',
        actionable_message_id: null,
        messages: [{
          id: 'email-1',
          artist_id: ARTIST_ID,
          status: 'draft',
          to_email: 'fixture@example.test',
          subject: 'Draft reply',
          created_by_kind: 'ai',
          created_at: '2026-08-30T09:00:00Z',
          client_id: CLIENT_ID,
          enquiry_id: 'enquiry-1',
          project_id: null,
          approved_at: null,
          sent_at: null,
          failed_at: null,
          error_code: null,
        }],
      }],
    }));

    expect(snapshot.needsYou.map((item) => item.kind)).toEqual(['new_enquiry']);
  });

  it('hides only the acknowledged reply version and reopens on a newer inbound', () => {
    const acknowledgedAt = '2026-08-30T09:00:00Z';
    const acknowledgements = [{
      artist_id: ARTIST_ID,
      item_kind: 'conversation_reply' as const,
      entity_id: 'conversation-1',
      observed_at: acknowledgedAt,
      acknowledged_at: '2026-08-30T10:00:00Z',
    }];

    const hidden = summariseToday(input({ conversations: [conversation()], acknowledgements }));
    expect(hidden.needsYou).toHaveLength(0);

    const reopened = summariseToday(input({
      conversations: [conversation({
        last_message_at: '2026-08-30T11:00:00Z',
        last_inbound_at: '2026-08-30T11:00:00Z',
      })],
      acknowledgements,
    }));
    expect(reopened.needsYou.map((item) => item.kind)).toEqual(['reply']);
  });
});
