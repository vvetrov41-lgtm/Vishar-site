// The week grid's arithmetic, and what it does on the two Sundays a year the
// clocks move.
//
// Every assertion names an instant in UTC and a wall clock in Europe/London,
// because that pair is exactly what a drag has to get right: the operator
// drops on a wall clock, the database stores an instant.

import { describe, expect, it } from 'vitest';
import {
  addZonedDays,
  buildWeekCalendar,
  SLOT_MINUTES,
  minutesOfZonedDay,
  rescheduleTarget,
  slotsFor,
  startOfZonedDay,
  startOfZonedWeek,
  zonedParts,
  zonedTimeLabel,
  zonedTimestamp,
} from '../lib/calendar-week';

const LONDON = 'Europe/London';

function appointment(startAt: string, endAt: string) {
  return { start_at: startAt, end_at: endAt };
}

function fullAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    artist_id: 'artist-1',
    client_id: 'client-1',
    enquiry_id: null,
    project_id: null,
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
    ...overrides,
  } as any;
}

describe('reading a wall clock in the artist zone', () => {
  it('reads a winter instant as GMT and a summer instant as BST', () => {
    expect(zonedParts(Date.parse('2026-01-15T10:00:00Z'), LONDON)).toMatchObject({
      year: 2026, month: 1, day: 15, hour: 10, minute: 0,
    });
    expect(zonedParts(Date.parse('2026-07-15T10:00:00Z'), LONDON)).toMatchObject({
      year: 2026, month: 7, day: 15, hour: 11, minute: 0,
    });
  });

  it('renders midnight as 00:00 rather than 24:00', () => {
    expect(zonedTimeLabel('2026-01-15T00:00:00Z', LONDON)).toBe('00:00');
    expect(minutesOfZonedDay(Date.parse('2026-01-15T00:00:00Z'), LONDON)).toBe(0);
  });

  it('starts the day at local midnight on both sides of the transition', () => {
    expect(new Date(startOfZonedDay(Date.parse('2026-01-15T10:00:00Z'), LONDON)).toISOString())
      .toBe('2026-01-15T00:00:00.000Z');
    // In BST local midnight is 23:00 UTC the day before.
    expect(new Date(startOfZonedDay(Date.parse('2026-07-15T10:00:00Z'), LONDON)).toISOString())
      .toBe('2026-07-14T23:00:00.000Z');
  });

  it('puts the week on Monday in the artist zone', () => {
    // Wednesday 2 September 2026.
    const monday = startOfZonedWeek(Date.parse('2026-09-02T09:00:00Z'), LONDON);
    expect(zonedParts(monday, LONDON)).toMatchObject({ year: 2026, month: 8, day: 31, hour: 0 });
  });

  it('adds days by wall clock, so a week forward over the transition stays at the same hour', () => {
    // Monday 19 October 2026, 10:00 BST. A week later the clocks have gone back.
    const from = zonedTimestamp({ year: 2026, month: 10, day: 19, hour: 10 }, LONDON);
    const to = addZonedDays(from, 7, LONDON);
    expect(zonedParts(to, LONDON)).toMatchObject({ year: 2026, month: 10, day: 26, hour: 10 });
    // Same wall clock, one hour more of elapsed time.
    expect(to - from).toBe(7 * 86_400_000 + 3_600_000);
  });

  it('resolves a wall clock the spring transition skips instead of failing', () => {
    // BST begins at 01:00 UTC on Sunday 29 March 2026, so 01:30 never happens.
    const resolved = zonedTimestamp({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LONDON);
    expect(zonedParts(resolved, LONDON)).toMatchObject({ hour: 2, minute: 30 });
  });
});

describe('where a dragged appointment lands', () => {
  it('keeps the wall clock when the move crosses into British Summer Time', () => {
    // Monday 23 March 2026, 10:00 GMT, dropped on Wednesday 1 April at 10:00.
    const target = rescheduleTarget({
      appointment: appointment('2026-03-23T10:00:00Z', '2026-03-23T17:00:00Z'),
      dayStart: startOfZonedDay(Date.parse('2026-04-01T12:00:00Z'), LONDON),
      minutesFromMidnight: 10 * 60,
      timeZone: LONDON,
    });

    expect(target).not.toBeNull();
    // 10:00 BST is 09:00 UTC. An implementation that ignored the zone would
    // have produced 10:00Z, which the operator would read as 11:00.
    expect(target!.startAt).toBe('2026-04-01T09:00:00.000Z');
    expect(zonedTimeLabel(target!.startAt, LONDON)).toBe('10:00');
  });

  it('keeps a seven-hour session seven hours long across the autumn transition', () => {
    const target = rescheduleTarget({
      appointment: appointment('2026-09-01T09:00:00Z', '2026-09-01T16:00:00Z'),
      // Sunday 25 October 2026, the morning the clocks go back.
      dayStart: startOfZonedDay(Date.parse('2026-10-25T12:00:00Z'), LONDON),
      minutesFromMidnight: 0,
      timeZone: LONDON,
    });

    expect(target!.startAt).toBe('2026-10-24T23:00:00.000Z');
    expect(Date.parse(target!.endAt) - Date.parse(target!.startAt)).toBe(7 * 3_600_000);
    // Seven hours of work that finishes at 06:00 rather than 07:00, because an
    // hour of the clock was given back in the middle of it.
    expect(zonedTimeLabel(target!.endAt, LONDON)).toBe('06:00');
  });

  it('refuses an appointment whose stored times make no sense', () => {
    expect(rescheduleTarget({
      appointment: appointment('2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'),
      dayStart: startOfZonedDay(Date.parse('2026-09-02T12:00:00Z'), LONDON),
      minutesFromMidnight: 600,
      timeZone: LONDON,
    })).toBeNull();
  });
});

describe('building the grid', () => {
  const now = new Date('2026-09-01T08:00:00Z');

  it('lays out a Monday-to-Sunday week and places the booking on its own day', () => {
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [fullAppointment()],
      timeOff: [],
    });

    expect(week.days).toHaveLength(7);
    expect(zonedParts(week.days[0].date, LONDON)).toMatchObject({ month: 8, day: 31 });
    expect(week.days.filter((day) => day.isToday)).toHaveLength(1);

    const tuesday = week.days[1];
    expect(tuesday.entries).toHaveLength(1);
    const entry = tuesday.entries[0];
    expect(entry.kind).toBe('appointment');
    // 10:00 UTC is 11:00 BST.
    expect(entry.startMinutes).toBe(11 * 60);
    expect(entry.endMinutes).toBe(17 * 60);
  });

  it('shows one day in day view', () => {
    const day = buildWeekCalendar({
      anchor: Date.parse('2026-09-01T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 1,
      appointments: [fullAppointment()],
      timeOff: [],
    });
    expect(day.days).toHaveLength(1);
    expect(day.days[0].entries).toHaveLength(1);
  });

  it('leaves a cancelled appointment out of the diary', () => {
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [fullAppointment({ status: 'cancelled', cancelled_at: '2026-08-30T09:00:00Z' })],
      timeOff: [],
    });
    expect(week.days.flatMap((day) => day.entries)).toHaveLength(0);
  });

  it('widens the hour range to contain an early booking', () => {
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [fullAppointment({
        start_at: '2026-09-01T05:00:00Z', // 06:00 BST
        end_at: '2026-09-01T07:00:00Z',
      })],
      timeOff: [],
    });
    expect(week.startHour).toBe(6);
    expect(slotsFor(week)[0]).toBe(6 * 60);
  });

  it('marks an all-day block without giving it an hour', () => {
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [],
      timeOff: [{
        block_id: 'b-1',
        artist_id: 'artist-1',
        block_kind: 'holiday',
        // Local midnight in BST is 23:00 UTC the day before, so these two
        // instants are Thursday 00:00 and Saturday 00:00 in the artist's zone.
        start_at: '2026-09-02T23:00:00Z',
        end_at: '2026-09-04T23:00:00Z',
        is_all_day: true,
        note: 'Away',
        cancelled_at: null,
        created_at: '2026-08-01T09:00:00Z',
        updated_at: '2026-08-01T09:00:00Z',
      } as any],
    });

    const marked = week.days.filter((day) => day.entries.some(
      (entry) => entry.kind === 'time_off' && entry.allDay
    ));
    expect(marked).toHaveLength(2);
  });
});

describe('partial-day time off', () => {
  const now = new Date('2026-09-01T08:00:00Z');

  function block(startAt: string, endAt: string) {
    return {
      block_id: 'b-partial',
      artist_id: 'artist-1',
      block_kind: 'personal',
      start_at: startAt,
      end_at: endAt,
      is_all_day: false,
      note: null,
      cancelled_at: null,
      created_at: '2026-08-01T09:00:00Z',
      updated_at: '2026-08-01T09:00:00Z',
    } as any;
  }

  it('widens the grid to contain a block that starts before the working day', () => {
    // 08:00 to 12:00 BST on Tuesday 1 September.
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [],
      timeOff: [block('2026-09-01T07:00:00Z', '2026-09-01T11:00:00Z')],
    });

    // Without the widening the grid would still start at 09:00 and the block
    // would have no row to appear in.
    expect(week.startHour).toBe(8);
    const tuesday = week.days[1];
    const entry = tuesday.entries.find((row) => row.kind === 'time_off');
    expect(entry).toBeDefined();
    expect(entry!.startMinutes).toBe(8 * 60);
    expect(entry!.endMinutes).toBe(12 * 60);
    expect(slotsFor(week)[0]).toBe(8 * 60);
  });

  it('leaves the grid alone for an all-day block, which has its own strip', () => {
    const week = buildWeekCalendar({
      anchor: Date.parse('2026-09-02T09:00:00Z'),
      now,
      timeZone: LONDON,
      days: 7,
      appointments: [],
      timeOff: [{ ...block('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'), is_all_day: true }],
    });
    expect(week.startHour).toBe(9);
    expect(SLOT_MINUTES).toBe(30);
  });
});
