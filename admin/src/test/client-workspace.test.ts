// The client workspace's reasoning, tested without a database.
//
// `summariseClientWorkspace` decides what an operator sees first and what the
// CRM recommends they do. That ordering is a product rule, not a rendering
// detail, so it is exercised here directly against records rather than through
// a screen.

import { describe, expect, it } from 'vitest';
import {
  conversationAwaitsReply,
  summariseClientWorkspace,
  type ClientWorkspaceInput,
} from '../lib/client-workspace';
import type { Appointment } from '../lib/appointment-api';
import type { ClientConversation } from '../lib/communications-api';
import type { Enquiry, FollowUp, Project } from '../lib/types';

const CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
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
    deposit_status: 'paid',
    currency: 'GBP',
    created_at: '2026-07-02T09:00:00Z',
    updated_at: '2026-07-02T09:00:00Z',
    archived_at: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<ClientConversation> = {}): ClientConversation {
  return {
    id: 'conversation-1',
    artist_id: ARTIST_ID,
    channel: 'whatsapp',
    link_state: 'linked',
    state: 'open',
    client_id: CLIENT_ID,
    enquiry_id: null,
    external_username: null,
    external_display_label: null,
    // Default: the artist answered last, so nothing is waiting.
    last_message_at: '2026-08-29T10:05:00Z',
    last_inbound_at: '2026-08-29T10:00:00Z',
    last_outbound_at: '2026-08-29T10:05:00Z',
    operator_read_at: '2026-08-29T10:05:00Z',
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
    enquiry_id: null,
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
    created_at: '2026-07-01T09:00:00Z',
    last_action_at: '2026-07-01T09:00:00Z',
    archived_at: null,
    ...overrides,
  } as Enquiry;
}

function input(overrides: Partial<ClientWorkspaceInput> = {}): ClientWorkspaceInput {
  return {
    clientId: CLIENT_ID,
    enquiries: [],
    projects: [],
    appointments: [],
    followUps: [],
    conversations: [],
    now: NOW,
    ...overrides,
  };
}

describe('client workspace facts', () => {
  it('picks the soonest future appointment and ignores cancelled ones', () => {
    const snapshot = summariseClientWorkspace(input({
      appointments: [
        appointment({ id: 'later', start_at: '2026-09-20T10:00:00Z' }),
        appointment({ id: 'cancelled', start_at: '2026-09-01T10:00:00Z', status: 'cancelled', cancelled_at: '2026-08-20T10:00:00Z' }),
        appointment({ id: 'soonest', start_at: '2026-09-03T10:00:00Z' }),
        appointment({ id: 'done', start_at: '2026-08-01T10:00:00Z', status: 'completed' }),
      ],
    }));

    expect(snapshot.nextAppointment?.id).toBe('soonest');
    expect(snapshot.lastAppointment?.id).toBe('done');
  });

  it('reports future appointments that are still unconfirmed', () => {
    const snapshot = summariseClientWorkspace(input({
      appointments: [appointment({ id: 'held', status: 'proposed' })],
    }));

    expect(snapshot.unconfirmedAppointments.map((entry) => entry.id)).toEqual(['held']);
  });

  it('answers the deposit question about the active project, not an old one', () => {
    const snapshot = summariseClientWorkspace(input({
      projects: [
        project({ id: 'finished', status: 'completed', deposit_status: 'paid', updated_at: '2026-08-29T09:00:00Z' }),
        project({ id: 'current', status: 'active', deposit_status: 'requested', updated_at: '2026-07-02T09:00:00Z' }),
      ],
    }));

    expect(snapshot.depositProject?.id).toBe('current');
  });

  it('treats a conversation the client spoke in last as awaiting a reply', () => {
    // Never answered at all.
    expect(conversationAwaitsReply(conversation({
      last_inbound_at: '2026-08-29T10:00:00Z',
      last_outbound_at: null,
    }))).toBe(true);

    // Answered, then they wrote again. Reading it does not answer it, so the
    // read mark is deliberately newer than the inbound message here.
    expect(conversationAwaitsReply(conversation({
      last_inbound_at: '2026-08-29T10:00:00Z',
      last_outbound_at: '2026-08-29T09:00:00Z',
      operator_read_at: '2026-08-29T10:05:00Z',
    }))).toBe(true);

    // The artist spoke last.
    expect(conversationAwaitsReply(conversation({
      last_inbound_at: '2026-08-29T10:00:00Z',
      last_outbound_at: '2026-08-29T10:05:00Z',
    }))).toBe(false);

    // Nothing inbound at all.
    expect(conversationAwaitsReply(conversation({
      last_inbound_at: null,
      last_outbound_at: null,
    }))).toBe(false);

    // An archived thread is not a queue item, whoever spoke last.
    expect(conversationAwaitsReply(conversation({
      state: 'archived',
      last_inbound_at: '2026-08-29T10:00:00Z',
      last_outbound_at: null,
    }))).toBe(false);
  });

  it('shows the newest conversation whatever channel it arrived on', () => {
    const snapshot = summariseClientWorkspace(input({
      conversations: [
        conversation({ id: 'older', channel: 'instagram', last_message_at: '2026-08-01T10:00:00Z' }),
        conversation({ id: 'newest', channel: 'whatsapp', last_message_at: '2026-08-29T10:00:00Z' }),
      ],
    }));

    expect(snapshot.latestConversation?.id).toBe('newest');
  });

  it('separates overdue follow-ups from open ones and ignores closed ones', () => {
    const snapshot = summariseClientWorkspace(input({
      followUps: [
        followUp({ id: 'overdue', due_at: '2026-08-25T09:00:00Z' }),
        followUp({ id: 'ahead', due_at: '2026-09-10T09:00:00Z' }),
        followUp({ id: 'done', status: 'done', due_at: '2026-08-01T09:00:00Z' }),
      ],
    }));

    expect(snapshot.openFollowUps.map((entry) => entry.id)).toEqual(['overdue', 'ahead']);
    expect(snapshot.overdueFollowUps.map((entry) => entry.id)).toEqual(['overdue']);
  });
});

describe('client workspace next action', () => {
  it('puts an unanswered client message above everything else', () => {
    const snapshot = summariseClientWorkspace(input({
      conversations: [conversation({ id: 'waiting', last_outbound_at: null })],
      followUps: [followUp()],
      appointments: [appointment({ status: 'proposed' })],
      projects: [project({ deposit_status: 'requested' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'reply', href: '/inbox/waiting' });
  });

  it('falls to the overdue follow-up when nobody is waiting on a reply', () => {
    const snapshot = summariseClientWorkspace(input({
      conversations: [conversation()],
      followUps: [followUp({ enquiry_id: 'enquiry-1' })],
      appointments: [appointment({ status: 'proposed' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'follow_up', href: '/enquiries/enquiry-1' });
  });

  it('asks for an unconfirmed booking to be confirmed before it asks about money', () => {
    const snapshot = summariseClientWorkspace(input({
      appointments: [appointment({ id: 'held', status: 'proposed' })],
      projects: [project({ deposit_status: 'requested' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'confirm_appointment', href: '/appointments/held' });
  });

  it('raises the deposit when a confirmed session is not paid for', () => {
    const snapshot = summariseClientWorkspace(input({
      appointments: [appointment({ status: 'confirmed' })],
      projects: [project({ id: 'project-1', deposit_status: 'requested' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'request_deposit', href: '/projects/project-1' });
  });

  it('does not raise a deposit that is paid or not required', () => {
    for (const depositStatus of ['paid', 'not_required'] as const) {
      const snapshot = summariseClientWorkspace(input({
        appointments: [appointment({ status: 'confirmed' })],
        projects: [project({ deposit_status: depositStatus })],
      }));
      expect(snapshot.nextAction.kind).toBe('none');
    }
  });

  it('suggests booking when work is active and the diary is empty', () => {
    const snapshot = summariseClientWorkspace(input({
      projects: [project({ id: 'project-1', deposit_status: 'paid' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'book_session', href: '/projects/project-1' });
  });

  it('sends the operator to an open enquiry when there is no project to book against', () => {
    const snapshot = summariseClientWorkspace(input({
      enquiries: [enquiry({ id: 'enquiry-1', status: 'reviewing' })],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'open_enquiry', href: '/enquiries/enquiry-1' });
  });

  it('says nothing is waiting rather than inventing work', () => {
    const snapshot = summariseClientWorkspace(input({
      enquiries: [enquiry({ status: 'closed' })],
      projects: [project({ status: 'completed', deposit_status: 'paid' })],
      conversations: [conversation()],
    }));

    expect(snapshot.nextAction).toEqual({ kind: 'none', href: null });
  });
});
