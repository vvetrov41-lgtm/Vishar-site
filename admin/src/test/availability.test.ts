// Free-slot search.
//
// The engine is pure and takes `now` explicitly, so every rule below can be
// stated as an example rather than mocked. The rules themselves are not this
// module's invention: an active appointment and uncancelled time off are what
// list_appointment_conflicts (0026) and assert_artist_available (0039)
// enforce, and there is nothing else in the schema to enforce.

import { describe, expect, it } from 'vitest';
import {
  busyIntervals,
  findAvailableSlots,
  findConsecutiveDaySlots,
  freeRuns,
  type SlotSearch,
} from '../lib/availability';
import type { Appointment } from '../lib/appointment-api';
import type { AvailabilityBlock } from '../lib/availability-api';

const ARTIST = 'artist-1';

/** Local time, because the operator books a local Friday, not a UTC one. */
function local(day: string, hour: number, minute = 0): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appointment-1',
    artist_id: ARTIST,
    client_id: 'client-1',
    enquiry_id: null,
    project_id: null,
    appointment_type: 'tattoo_session',
    status: 'confirmed',
    start_at: local('2026-09-01', 12),
    end_at: local('2026-09-01', 16),
    duration_hours: 4,
    currency: 'GBP',
    payment_status: 'unpaid',
    calendar_provider: 'none',
    calendar_event_id: null,
    calendar_version: 1,
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
  } as Appointment;
}

function timeOff(overrides: Partial<AvailabilityBlock> = {}): AvailabilityBlock {
  return {
    block_id: 'block-1',
    artist_id: ARTIST,
    block_kind: 'day_off',
    start_at: local('2026-09-02', 0),
    end_at: local('2026-09-03', 0),
    is_all_day: true,
    note: null,
    cancelled_at: null,
    created_at: local('2026-08-01', 9),
    updated_at: local('2026-08-01', 9),
    ...overrides,
  } as AvailabilityBlock;
}

function search(overrides: Partial<SlotSearch> = {}): SlotSearch {
  return {
    now: new Date(local('2026-09-01', 8)),
    from: new Date(local('2026-09-01', 0)),
    to: new Date(local('2026-09-04', 0)),
    durationMinutes: 7 * 60,
    dayWindow: { earliestHour: 10, latestHour: 20 },
    appointments: [],
    timeOff: [],
    ...overrides,
  };
}

describe('what counts as busy', () => {
  it('takes proposed and confirmed appointments, and nothing else', () => {
    // Mirrors list_appointment_conflicts exactly: a draft is not in the diary,
    // and a cancelled or completed one has left it.
    const busy = busyIntervals(
      [
        appointment({ id: 'a', status: 'confirmed' }),
        appointment({ id: 'b', status: 'proposed', start_at: local('2026-09-03', 12), end_at: local('2026-09-03', 14) }),
        appointment({ id: 'c', status: 'draft', start_at: local('2026-09-03', 15), end_at: local('2026-09-03', 17) }),
        appointment({ id: 'd', status: 'cancelled', start_at: local('2026-09-03', 18), end_at: local('2026-09-03', 19) }),
      ],
      [],
    );
    expect(busy).toHaveLength(2);
  });

  it('ignores a cancelled time-off block, as the database does', () => {
    const busy = busyIntervals([], [
      timeOff({ block_id: 'live' }),
      timeOff({ block_id: 'cancelled', cancelled_at: local('2026-08-20', 9) }),
    ]);
    expect(busy).toHaveLength(1);
  });

  it('merges overlapping constraints into one busy run', () => {
    const busy = busyIntervals(
      [appointment({ start_at: local('2026-09-01', 12), end_at: local('2026-09-01', 16) })],
      [timeOff({ start_at: local('2026-09-01', 14), end_at: local('2026-09-01', 18) })],
    );
    expect(busy).toHaveLength(1);
    expect(new Date(busy[0].end).getHours()).toBe(18);
  });
});

describe('free runs', () => {
  it('treats the boundary as half-open, exactly like the database range', () => {
    // tstzrange(..., '[)') means 14:00 is free the instant the 12:00-14:00
    // appointment ends. Refusing that would lose a legitimate afternoon.
    const dayStart = new Date(local('2026-09-01', 10)).getTime();
    const dayEnd = new Date(local('2026-09-01', 20)).getTime();
    const runs = freeRuns(dayStart, dayEnd, busyIntervals(
      [appointment({ start_at: local('2026-09-01', 12), end_at: local('2026-09-01', 14) })],
      [],
    ));
    expect(runs).toHaveLength(2);
    expect(new Date(runs[1].start).getHours()).toBe(14);
  });
});

describe('finding a session', () => {
  it('offers a 7-hour tattoo session only where 7 hours actually exist', () => {
    const slots = findAvailableSlots(search({
      // The 1st has 10:00-12:00 and 16:00-20:00 free: neither is 7 hours.
      appointments: [appointment()],
      timeOff: [],
    }));
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      expect(end.getTime() - start.getTime()).toBe(7 * 60 * 60 * 1000);
      expect(start.getDate()).not.toBe(1);
    }
  });

  it('never offers a period an appointment overlaps', () => {
    const booked = appointment({ start_at: local('2026-09-03', 11), end_at: local('2026-09-03', 15) });
    const slots = findAvailableSlots(search({
      durationMinutes: 60,
      from: new Date(local('2026-09-03', 0)),
      to: new Date(local('2026-09-04', 0)),
      appointments: [booked],
    }));
    const clash = slots.some((slot) => (
      Date.parse(slot.start) < Date.parse(booked.end_at)
      && Date.parse(slot.end) > Date.parse(booked.start_at)
    ));
    expect(clash).toBe(false);
    expect(slots.length).toBeGreaterThan(0);
  });

  it('never offers a period inside time off', () => {
    const off = timeOff();
    const slots = findAvailableSlots(search({ durationMinutes: 60, timeOff: [off] }));
    const clash = slots.some((slot) => (
      Date.parse(slot.start) < Date.parse(off.end_at)
      && Date.parse(slot.end) > Date.parse(off.start_at)
    ));
    expect(clash).toBe(false);
    // The 2nd is entirely off; the 1st and 3rd still produce options.
    expect(slots.some((slot) => slot.day === '2026-09-02')).toBe(false);
    expect(slots.some((slot) => slot.day === '2026-09-03')).toBe(true);
  });

  it('treats a consultation as occupying the diary like any other appointment', () => {
    // Consultations and tattoo sessions are the same table, so the conflict
    // rule does not distinguish them and neither may this.
    const consultation = appointment({
      appointment_type: 'in_person_consultation',
      start_at: local('2026-09-03', 12),
      end_at: local('2026-09-03', 12, 30),
    });
    const slots = findAvailableSlots(search({
      durationMinutes: 7 * 60,
      from: new Date(local('2026-09-03', 0)),
      to: new Date(local('2026-09-04', 0)),
      appointments: [consultation],
    }));
    // 10:00-20:00 minus a 30-minute midday consultation leaves 10:00-12:00 and
    // 12:30-20:00. Only the second is long enough, so the session is pushed
    // after the consultation rather than offered across it.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(Date.parse(slot.start)).toBeGreaterThanOrEqual(Date.parse(consultation.end_at));
    }
  });

  it('finds a short consultation slot where a long session does not fit', () => {
    const slots = findAvailableSlots(search({
      durationMinutes: 30,
      granularityMinutes: 30,
      from: new Date(local('2026-09-01', 0)),
      to: new Date(local('2026-09-02', 0)),
      appointments: [appointment()],
    }));
    expect(slots.length).toBeGreaterThan(0);
    expect(new Date(slots[0].start).getHours()).toBe(10);
  });

  it('never offers a slot in the past', () => {
    const slots = findAvailableSlots(search({
      now: new Date(local('2026-09-01', 15)),
      durationMinutes: 60,
      from: new Date(local('2026-09-01', 0)),
      to: new Date(local('2026-09-02', 0)),
    }));
    for (const slot of slots) {
      expect(Date.parse(slot.start)).toBeGreaterThanOrEqual(new Date(local('2026-09-01', 15)).getTime());
    }
  });

  it('stays inside the hours the caller stated, because the schema states none', () => {
    // There is no working-hours table in this database. The window is the
    // operator's, passed in - so the engine must honour it rather than
    // substituting a rule of its own.
    const slots = findAvailableSlots(search({
      durationMinutes: 60,
      dayWindow: { earliestHour: 13, latestHour: 15 },
    }));
    for (const slot of slots) {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      expect(start.getHours()).toBeGreaterThanOrEqual(13);
      expect(end.getHours()).toBeLessThanOrEqual(15);
    }
  });

  it('reports how much room the slot actually sits in', () => {
    // Asking for 6 hours on an empty 10-hour day should say 10 are free, so
    // the operator can offer the client more without searching again.
    const [slot] = findAvailableSlots(search({ durationMinutes: 6 * 60 }));
    expect(slot.availableMinutes).toBe(600);
  });

  it('caps the number of options rather than filling the screen', () => {
    const slots = findAvailableSlots(search({
      durationMinutes: 60,
      granularityMinutes: 15,
      limit: 5,
    }));
    expect(slots).toHaveLength(5);
  });
});

describe('consecutive days', () => {
  it('finds two days in a row for a large piece', () => {
    const runs = findConsecutiveDaySlots(search({ durationMinutes: 7 * 60 }), 2);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toHaveLength(2);
    const [first, second] = runs[0];
    expect(second.day > first.day).toBe(true);
  });

  it('refuses to bridge a day off', () => {
    // The 2nd is off, so the 1st and 3rd are not a consecutive pair however
    // free they both are.
    const runs = findConsecutiveDaySlots(
      search({ durationMinutes: 60, timeOff: [timeOff()] }),
      2,
    );
    for (const run of runs) {
      expect(run.map((slot) => slot.day)).not.toEqual(['2026-09-01', '2026-09-03']);
    }
  });
});
