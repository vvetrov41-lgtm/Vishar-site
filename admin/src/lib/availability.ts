// Free-slot search, derived from the two things the database actually knows.
//
// READ THIS BEFORE ADDING A RULE.
//
// There are exactly two authoritative constraints on when an artist can be
// booked, and this module uses both and nothing else:
//
//   1. an active appointment - `public.sessions` in status `proposed` or
//      `confirmed`, overlapping as `[)`. That is the rule
//      `public.list_appointment_conflicts` implements (0026), and consultations
//      are the same table, so they constrain a tattoo session exactly as
//      another tattoo session does.
//   2. artist time off - an uncancelled `public.artist_availability_blocks`
//      row, overlapping as `[)`. That is what
//      `crm_private.assert_artist_available` enforces (0039).
//
// There is no working-hours table, no buffer rule, no booking horizon and no
// per-type duration rule anywhere in this schema. This module therefore
// invents none of them. The one thing it cannot derive - which hours of the
// day the studio is willing to work - is a parameter the caller must state,
// so the operator sees and controls it rather than inheriting a number
// somebody hard-coded.
//
// This search is advisory, exactly like list_appointment_conflicts. The
// authority is still `public.schedule_appointment`, which takes
// `crm_private.lock_artist_schedule` and re-checks availability inside the
// same transaction (0039) - so a slot that goes stale between being offered
// and being confirmed is refused by the database, not double-booked.

import type { Appointment } from './appointment-api';
import type { AvailabilityBlock } from './availability-api';

/** Statuses that occupy the diary. Mirrors list_appointment_conflicts. */
const BUSY_STATUSES = new Set(['proposed', 'confirmed']);

export type BusyReason = 'appointment' | 'time_off';

export interface BusyInterval {
  start: number;
  end: number;
  reason: BusyReason;
}

export interface DayWindow {
  /** Local hour the studio is willing to start, 0-23. */
  earliestHour: number;
  /** Local hour by which work must have finished, 1-24. */
  latestHour: number;
}

export interface SlotSearch {
  now: Date;
  /** Inclusive start of the search window. Clamped to `now`. */
  from: Date;
  /** Exclusive end of the search window. */
  to: Date;
  durationMinutes: number;
  dayWindow: DayWindow;
  appointments: Appointment[];
  timeOff: AvailabilityBlock[];
  /** Cap on returned slots, so a wide window cannot produce a wall of options. */
  limit?: number;
  /** How many candidate starts to offer inside one free run. */
  granularityMinutes?: number;
}

export interface Slot {
  start: string;
  end: string;
  /**
   * How long the free run this slot sits in actually is. An operator asking
   * for 6 hours wants to know when they could have had 8.
   */
  availableMinutes: number;
  /** Local day key, so the UI can group without re-deriving it. */
  day: string;
}

const MINUTE = 60_000;

/**
 * Every interval the artist is not bookable in, merged and sorted.
 *
 * Exported because multi-session search composes it rather than re-deriving
 * the rules: "find another slot" and "find two consecutive days" are both
 * questions about the same set of free runs.
 */
export function busyIntervals(
  appointments: Appointment[],
  timeOff: AvailabilityBlock[],
): BusyInterval[] {
  const intervals: BusyInterval[] = [];

  for (const appointment of appointments) {
    // cancelled_at is belt and braces: a cancelled row should not be in
    // proposed/confirmed, and if it somehow is, it still must not block.
    if (!BUSY_STATUSES.has(appointment.status) || appointment.cancelled_at) continue;
    const start = Date.parse(appointment.start_at);
    const end = Date.parse(appointment.end_at);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    intervals.push({ start, end, reason: 'appointment' });
  }

  for (const block of timeOff) {
    if (block.cancelled_at) continue;
    const start = Date.parse(block.start_at);
    const end = Date.parse(block.end_at);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    intervals.push({ start, end, reason: 'time_off' });
  }

  return mergeIntervals(intervals);
}

/**
 * The runs of time inside one local day window that nothing occupies.
 *
 * Half-open throughout, matching the database's `[)`: an appointment ending at
 * 14:00 does not conflict with one starting at 14:00, so a slot may start the
 * moment another ends.
 */
export function freeRuns(
  dayStart: number,
  dayEnd: number,
  busy: BusyInterval[],
): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let cursor = dayStart;
  for (const interval of busy) {
    if (interval.end <= dayStart || interval.start >= dayEnd) continue;
    if (interval.start > cursor) runs.push({ start: cursor, end: Math.min(interval.start, dayEnd) });
    cursor = Math.max(cursor, interval.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) runs.push({ start: cursor, end: dayEnd });
  return runs.filter((run) => run.end > run.start);
}

/**
 * Slots long enough for the requested duration, earliest first.
 *
 * A run longer than the requested duration yields more than one start, spaced
 * by `granularityMinutes`, so an operator asking for 4 hours on a free day is
 * offered a morning and an afternoon rather than only the earliest instant.
 */
export function findAvailableSlots(search: SlotSearch): Slot[] {
  const duration = Math.max(1, Math.round(search.durationMinutes)) * MINUTE;
  const granularity = Math.max(15, Math.round(search.granularityMinutes ?? 60)) * MINUTE;
  const limit = Math.max(1, search.limit ?? 20);

  // Never offer the past. A slot that started ten minutes ago is not bookable
  // however free the diary is.
  const from = Math.max(search.from.getTime(), search.now.getTime());
  const to = search.to.getTime();
  if (!(to > from)) return [];

  const busy = busyIntervals(search.appointments, search.timeOff);
  const slots: Slot[] = [];

  for (const day of localDays(from, to)) {
    const { start: dayStart, end: dayEnd } = dayBounds(day, search.dayWindow);
    const windowStart = Math.max(dayStart, from);
    const windowEnd = Math.min(dayEnd, to);
    if (!(windowEnd > windowStart)) continue;

    for (const run of freeRuns(windowStart, windowEnd, busy)) {
      const runMinutes = Math.round((run.end - run.start) / MINUTE);
      for (let start = run.start; start + duration <= run.end; start += granularity) {
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(start + duration).toISOString(),
          availableMinutes: runMinutes,
          day: dayKey(new Date(start)),
        });
        if (slots.length >= limit) return slots;
      }
    }
  }

  return slots;
}

/**
 * The same duration on N consecutive local days.
 *
 * A large piece is often booked as "this Friday and Saturday", and asking the
 * operator to run two searches and eyeball the dates is how a double booking
 * gets made. This composes `findAvailableSlots` rather than re-deriving the
 * rules, which is why the primitives above are exported: a preferred gap
 * between sessions is the same walk with a different day step.
 */
export function findConsecutiveDaySlots(
  search: SlotSearch,
  days: number,
): Slot[][] {
  const wanted = Math.max(2, Math.round(days));
  // One slot per day is enough to answer "can I have both days?"; the operator
  // picks the exact times from the per-day options afterwards.
  const perDay = new Map<string, Slot>();
  for (const slot of findAvailableSlots({ ...search, limit: 400, granularityMinutes: 60 })) {
    if (!perDay.has(slot.day)) perDay.set(slot.day, slot);
  }

  const runs: Slot[][] = [];
  const keys = [...perDay.keys()].sort();
  for (let index = 0; index + wanted <= keys.length; index += 1) {
    const window = keys.slice(index, index + wanted);
    if (!isConsecutive(window)) continue;
    runs.push(window.map((key) => perDay.get(key) as Slot));
    if (runs.length >= (search.limit ?? 5)) break;
  }
  return runs;
}

function isConsecutive(keys: string[]): boolean {
  for (let index = 1; index < keys.length; index += 1) {
    const previous = new Date(`${keys[index - 1]}T00:00:00`);
    const current = new Date(`${keys[index]}T00:00:00`);
    const gap = Math.round((current.getTime() - previous.getTime()) / 86_400_000);
    if (gap !== 1) return false;
  }
  return true;
}

function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // Touching is not overlapping: `[)` means 12:00-14:00 and 14:00-16:00 are
    // two blocks, and merging them is still correct for gap-finding.
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      // Once anything overlaps, the merged run is simply "busy"; the reason is
      // only ever used to explain a single interval, never a merged one.
      if (last.reason !== interval.reason) last.reason = 'appointment';
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Local calendar days touched by the window.
 *
 * Local, not UTC: an operator books "Friday", and every other date in this CRM
 * is rendered in the browser's zone. A 400-day cap mirrors the range limit
 * `list_artist_availability_blocks` enforces, so a mistyped range cannot spin.
 */
function localDays(from: number, to: number): Date[] {
  const days: Date[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < to && days.length < 400) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function dayBounds(day: Date, window: DayWindow): { start: number; end: number } {
  const start = new Date(day);
  start.setHours(window.earliestHour, 0, 0, 0);
  const end = new Date(day);
  // 24 means midnight at the end of this day, which setHours handles by
  // rolling over - the intent an operator means by "until midnight".
  end.setHours(window.latestHour, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
