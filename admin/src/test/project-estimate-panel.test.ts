import { describe, expect, it } from 'vitest';
import { plannedWork } from '../components/ProjectEstimatePanel';
import type { Appointment } from '../lib/appointment-api';

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appointment-1',
    artist_id: 'artist-1',
    client_id: 'client-1',
    enquiry_id: 'enquiry-1',
    project_id: 'project-1',
    appointment_type: 'tattoo_session',
    status: 'confirmed',
    start_at: '2026-10-27T11:00:00.000Z',
    end_at: '2026-10-27T18:00:00.000Z',
    duration_hours: 7,
    currency: 'GBP',
    payment_status: 'unpaid',
    calendar_provider: 'google',
    calendar_event_id: 'calendar-1',
    calendar_version: 1,
    calendar_sync_status: 'synced',
    calendar_last_synced_version: 1,
    calendar_last_synced_at: '2026-08-17T20:00:00.000Z',
    calendar_last_error_code: null,
    notes: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe('project estimate planned work', () => {
  it('derives two planned tattoo sessions and ten hours from Charlie-style appointments', () => {
    expect(plannedWork([
      appointment({ id: 'appointment-7h', duration_hours: 7 }),
      appointment({ id: 'appointment-3h', duration_hours: 3 }),
    ])).toEqual({ sessions: 2, hours: 10 });
  });

  it('ignores consultations, cancelled work and no-shows', () => {
    expect(plannedWork([
      appointment({ id: 'kept', duration_hours: 5 }),
      appointment({ id: 'consultation', appointment_type: 'video_consultation', duration_hours: 0.5 }),
      appointment({ id: 'cancelled', status: 'cancelled', duration_hours: 7 }),
      appointment({ id: 'no-show', status: 'no_show', duration_hours: 3 }),
    ])).toEqual({ sessions: 1, hours: 5 });
  });
});
