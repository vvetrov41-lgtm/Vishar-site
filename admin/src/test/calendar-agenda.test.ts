// The diary's grouping rules, tested without a database.
//
// Which day a booking lands on, whether time off frames the days it covers,
// and whether an empty day still appears are all product decisions about what
// "when am I free?" means. They are exercised here directly.

import { describe, expect, it } from 'vitest';
import { beyondAgenda, buildAgenda, pastAppointments } from '../lib/calendar-agenda';
import type { Appointment } from '../lib/appointment-api';
import type { AvailabilityBlock } from '../lib/availability-api';

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Local midday, so a day boundary is unambiguous whatever timezone the suite
// runs in.
const NOW = new Date(2026, 7, 30, 12, 0, 0);

function at(day: number, hour: number): string {
  return new Date(2026, 7, day, hour, 0, 0).toISOString();
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appointment-1',
    artist_id: ARTIST_ID,
    client_id: CLIENT_ID,
    enquiry_id: null,
    project_id: 'project-1',
    appointment_type: 'tattoo_session',
    status: 'confirmed',
    start_at: at(31, 10),
    end_at: at(31, 16),
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

function block(overrides: Partial<AvailabilityBlock> = {}): AvailabilityBlock {
  return {
    block_id: 'block-1',
    artist_id: ARTIST_ID,
    block_kind: 'day_off',
    start_at: at(31, 0),
    end_at: at(32, 0),
    is_all_day: true,
    note: null,
    cancelled_at: null,
    created_at: at(1, 9),
    updated_at: at(1, 9),
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof buildAgenda>[0]> = {}) {
  return {
    now: NOW,
    appointments: [],
    timeOff: [],
    days: 7,
    ...overrides,
  };
}

describe('agenda days', () => {
  it('lays out every day in the window, including the empty ones', () => {
    const days = buildAgenda(input({ days: 5 }));

    expect(days).toHaveLength(5);
    expect(days[0].isToday).toBe(true);
    expect(days.slice(1).every((day) => !day.isToday)).toBe(true);
    // "Nothing booked on Thursday" is the answer to "when am I free?". A list
    // that omits Thursday does not give it.
    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it('puts a booking on the day it starts', () => {
    const days = buildAgenda(input({
      appointments: [
        appointment({ id: 'today', start_at: at(30, 15), end_at: at(30, 18) }),
        appointment({ id: 'tomorrow', start_at: at(31, 10) }),
      ],
    }));

    expect(days[0].entries.map((entry) => entry.key)).toEqual(['appointment-today']);
    expect(days[1].entries.map((entry) => entry.key)).toEqual(['appointment-tomorrow']);
  });

  it('keeps cancelled and finished bookings out of the diary', () => {
    const days = buildAgenda(input({
      appointments: [
        appointment({ id: 'cancelled', start_at: at(31, 10), status: 'cancelled', cancelled_at: at(20, 9) }),
        appointment({ id: 'completed', start_at: at(31, 12), status: 'completed' }),
      ],
    }));

    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it('marks every day a block of time off covers, not just the day it starts', () => {
    const days = buildAgenda(input({
      timeOff: [block({ start_at: at(31, 0), end_at: at(34, 0) })],
    }));

    // A week away has to mark every day it covers, or a free-looking Wednesday
    // appears in the middle of a holiday.
    expect(days[0].entries).toHaveLength(0);
    expect(days[1].entries.map((entry) => entry.kind)).toEqual(['time_off']);
    expect(days[2].entries.map((entry) => entry.kind)).toEqual(['time_off']);
    expect(days[3].entries.map((entry) => entry.kind)).toEqual(['time_off']);
    expect(days[4].entries).toHaveLength(0);
  });

  it('ignores cancelled time off', () => {
    const days = buildAgenda(input({
      timeOff: [block({ cancelled_at: at(20, 9) })],
    }));

    expect(days.every((day) => day.entries.length === 0)).toBe(true);
  });

  it('reads the day out in time order, with an all-day block framing it', () => {
    const days = buildAgenda(input({
      appointments: [
        appointment({ id: 'late', start_at: at(31, 15) }),
        appointment({ id: 'early', start_at: at(31, 9) }),
      ],
      timeOff: [block({ start_at: at(31, 0), end_at: at(32, 0) })],
    }));

    expect(days[1].entries.map((entry) => entry.key)).toEqual([
      'time-off-block-1-' + new Date(2026, 7, 31).getTime(),
      'appointment-early',
      'appointment-late',
    ]);
  });
});

describe('either side of the window', () => {
  it('lists what has already happened, newest first', () => {
    const past = pastAppointments(NOW, [
      appointment({ id: 'older', start_at: at(1, 10), status: 'completed' }),
      appointment({ id: 'newer', start_at: at(20, 10), status: 'completed' }),
      appointment({ id: 'earlier-today', start_at: at(30, 9) }),
      appointment({ id: 'ahead', start_at: at(31, 10) }),
      appointment({ id: 'cancelled', start_at: at(31, 12), status: 'cancelled', cancelled_at: at(20, 9) }),
    ]);

    expect(past.map((entry) => entry.id)).toEqual(['cancelled', 'newer', 'older']);
  });

  it('lists what is booked beyond the window, soonest first', () => {
    const beyond = beyondAgenda(NOW, 7, [
      appointment({ id: 'inside', start_at: at(31, 10) }),
      appointment({ id: 'far', start_at: new Date(2026, 9, 1, 10).toISOString() }),
      appointment({ id: 'less-far', start_at: new Date(2026, 8, 12, 10).toISOString() }),
    ]);

    expect(beyond.map((entry) => entry.id)).toEqual(['less-far', 'far']);
  });
});
