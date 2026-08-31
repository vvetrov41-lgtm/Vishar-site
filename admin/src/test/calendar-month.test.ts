import { describe, expect, it } from 'vitest';
import { buildMonthCalendar, calendarMonthWindow } from '../lib/calendar-month';
import type { Appointment } from '../lib/appointment-api';
import type { AvailabilityBlock } from '../lib/availability-api';

const appointment = {
  id: 'appointment-1',
  artist_id: 'artist-1',
  client_id: 'client-1',
  project_id: 'project-1',
  enquiry_id: null,
  appointment_type: 'tattoo_session',
  status: 'confirmed',
  start_at: '2026-09-01T10:00:00Z',
  end_at: '2026-09-01T16:00:00Z',
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
} satisfies Appointment;

const timeOff = {
  block_id: 'block-1',
  artist_id: 'artist-1',
  block_kind: 'holiday',
  start_at: '2026-08-11T00:00:00Z',
  end_at: '2026-08-14T00:00:00Z',
  is_all_day: true,
  note: null,
  cancelled_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
} satisfies AvailabilityBlock;

describe('month calendar', () => {
  it('builds a Monday-first six-week grid and keeps adjacent-month appointments visible', () => {
    const month = buildMonthCalendar({
      month: new Date(2026, 7, 1),
      now: new Date(2026, 7, 31, 12),
      appointments: [appointment],
      timeOff: [],
    });

    expect(month.days).toHaveLength(42);
    expect(new Date(month.days[0].date).getDay()).toBe(1);
    const septemberFirst = month.days.find((day) => {
      const date = new Date(day.date);
      return date.getFullYear() === 2026 && date.getMonth() === 8 && date.getDate() === 1;
    });
    expect(septemberFirst?.isCurrentMonth).toBe(false);
    expect(septemberFirst?.entries[0]?.kind).toBe('appointment');
  });

  it('marks every day covered by time off', () => {
    const month = buildMonthCalendar({
      month: new Date(2026, 7, 1),
      now: new Date(2026, 7, 1, 12),
      appointments: [],
      timeOff: [timeOff],
    });

    const covered = month.days.filter((day) => day.entries.some((entry) => entry.kind === 'time_off'));
    expect(covered).toHaveLength(3);
  });

  it('returns a six-week availability window', () => {
    const window = calendarMonthWindow(new Date(2026, 7, 1));
    const start = new Date(window.start);
    const end = new Date(window.end);
    expect(start.getDay()).toBe(1);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(8);
    expect(end.getDate()).toBe(7);
  });
});
