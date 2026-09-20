// The week and day grid, and the arithmetic a drag depends on.
//
// WHY THIS DOES NOT USE `new Date().getHours()`
//
// The month grid does, and for a month grid that is fine: it only needs to know
// which box a date falls in, and the operator and the artist are in the same
// place. A week grid places an appointment against an hour line, and a drag
// asks "what time is this now?" - both of which have to be answered in the
// artist's own zone, because the answer changes on the last Sunday in March
// and the last Sunday in October.
//
// So every boundary here is computed with `Intl.DateTimeFormat` in a named IANA
// zone. Dragging a 10:00 GMT session into British Summer Time leaves it at
// 10:00, not at 11:00, and a seven-hour session stays seven hours long across
// the transition rather than gaining or losing the hour the clocks did.

import type { Appointment } from './appointment-api';
import type { AvailabilityBlock } from './availability-api';

export const DEFAULT_TIMEZONE = 'Europe/London';

/** Minutes per grid row. Also the coarsest a drop can land. */
export const SLOT_MINUTES = 30;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = FORMATTERS.get(timeZone);
  if (existing) return existing;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // An artist row with a zone this browser does not know must not take the
    // calendar down with it. London is the installation's own zone.
    formatter = formatterFor(DEFAULT_TIMEZONE);
  }
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // `en-GB` renders midnight as 24, which is the same instant as hour 0.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** How far the named zone is from UTC at this instant, in milliseconds. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second
  );
  return asUtc - instant;
}

/**
 * The instant at which the named zone reads this wall clock.
 *
 * Two passes, because the first guess uses the offset in force at the guessed
 * instant, which is the wrong one exactly when the clocks change. A wall clock
 * that does not exist - 01:30 on the morning the clocks go forward - lands the
 * same distance past the jump, so 01:30 becomes 02:30 rather than failing.
 */
export function zonedTimestamp(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'> & Partial<ZonedParts>,
  timeZone: string
): number {
  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
  const firstGuess = wallClock - zoneOffsetMs(wallClock, timeZone);
  const settled = wallClock - zoneOffsetMs(firstGuess, timeZone);
  return settled;
}

export function startOfZonedDay(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return zonedTimestamp({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

/** The same wall-clock time, `days` later. Not `instant + days * 86400000`. */
export function addZonedDays(instant: number, days: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return zonedTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day + days,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    },
    timeZone
  );
}

/** Monday, 00:00, in the artist's zone. */
export function startOfZonedWeek(instant: number, timeZone: string): number {
  const dayStart = startOfZonedDay(instant, timeZone);
  const weekday = new Date(dayStart + zoneOffsetMs(dayStart, timeZone)).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return startOfZonedDay(addZonedDays(dayStart, -mondayOffset, timeZone), timeZone);
}

/** Minutes past midnight in the artist's zone. */
export function minutesOfZonedDay(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return parts.hour * 60 + parts.minute;
}

export interface WeekAppointmentEntry {
  kind: 'appointment';
  key: string;
  appointment: Appointment;
  /** Minutes past midnight where the block starts on this day. */
  startMinutes: number;
  endMinutes: number;
  /** True when the appointment began on an earlier day. */
  continued: boolean;
}

export interface WeekTimeOffEntry {
  kind: 'time_off';
  key: string;
  block: AvailabilityBlock;
  startMinutes: number;
  endMinutes: number;
  allDay: boolean;
}

export type WeekEntry = WeekAppointmentEntry | WeekTimeOffEntry;

export interface WeekCalendarDay {
  /** The instant of local midnight, in the artist's zone. */
  date: number;
  isToday: boolean;
  entries: WeekEntry[];
}

export interface WeekCalendar {
  timeZone: string;
  start: number;
  end: number;
  /** First and last hour line the grid draws. */
  startHour: number;
  endHour: number;
  days: WeekCalendarDay[];
}

export interface WeekCalendarInput {
  /** Any instant inside the window to lay out. */
  anchor: number;
  now: Date;
  timeZone: string;
  /** 7 for a week, 1 for a day. */
  days: number;
  appointments: Appointment[];
  timeOff: AvailabilityBlock[];
  /** Hours the grid always shows, before any entry widens it. */
  baseStartHour?: number;
  baseEndHour?: number;
}

const MINUTES_PER_DAY = 24 * 60;

function instantOf(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** Appointment states that still occupy the diary. */
const LIVE_STATUSES = new Set(['draft', 'proposed', 'confirmed']);

export function isLiveAppointment(appointment: Appointment): boolean {
  return appointment.cancelled_at === null && LIVE_STATUSES.has(appointment.status);
}

export function buildWeekCalendar(input: WeekCalendarInput): WeekCalendar {
  const timeZone = input.timeZone || DEFAULT_TIMEZONE;
  const dayCount = Math.max(1, input.days);
  const start = dayCount === 1
    ? startOfZonedDay(input.anchor, timeZone)
    : startOfZonedWeek(input.anchor, timeZone);
  const today = startOfZonedDay(input.now.getTime(), timeZone);

  const days: WeekCalendarDay[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = startOfZonedDay(addZonedDays(start, offset, timeZone), timeZone);
    days.push({ date, isToday: date === today, entries: [] });
  }
  const end = startOfZonedDay(addZonedDays(start, dayCount, timeZone), timeZone);

  let startHour = input.baseStartHour ?? 9;
  let endHour = input.baseEndHour ?? 20;

  for (const day of days) {
    const dayEnd = startOfZonedDay(addZonedDays(day.date, 1, timeZone), timeZone);

    for (const appointment of input.appointments) {
      if (!isLiveAppointment(appointment)) continue;
      const from = instantOf(appointment.start_at);
      const to = instantOf(appointment.end_at);
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      if (to <= day.date || from >= dayEnd) continue;

      const continued = from < day.date;
      const startMinutes = continued ? 0 : minutesOfZonedDay(from, timeZone);
      const endMinutes = to >= dayEnd ? MINUTES_PER_DAY : minutesOfZonedDay(to, timeZone);
      day.entries.push({
        kind: 'appointment',
        key: `appointment-${appointment.id}-${day.date}`,
        appointment,
        startMinutes,
        // A zero-length block would be invisible; give it one slot of presence.
        endMinutes: Math.max(endMinutes, startMinutes + 15),
        continued,
      });
      startHour = Math.min(startHour, Math.floor(startMinutes / 60));
      endHour = Math.max(endHour, Math.ceil(Math.max(endMinutes, startMinutes + 15) / 60));
    }

    for (const block of input.timeOff) {
      if (block.cancelled_at !== null) continue;
      const from = instantOf(block.start_at);
      const to = instantOf(block.end_at);
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      if (to <= day.date || from >= dayEnd) continue;

      const allDay = block.is_all_day || (from <= day.date && to >= dayEnd);
      const startMinutes = allDay ? 0 : minutesOfZonedDay(Math.max(from, day.date), timeZone);
      const endMinutes = allDay
        ? MINUTES_PER_DAY
        : (to >= dayEnd ? MINUTES_PER_DAY : minutesOfZonedDay(to, timeZone));
      day.entries.push({
        kind: 'time_off',
        key: `time-off-${block.block_id}-${day.date}`,
        block,
        startMinutes,
        endMinutes,
        allDay,
      });

      // A block from 08:00 to 12:00 is as much a reason to widen the grid as a
      // booking is. An all-day block does not widen anything: it is drawn in
      // the strip above the hours, not against them.
      if (!allDay) {
        startHour = Math.min(startHour, Math.floor(startMinutes / 60));
        endHour = Math.max(endHour, Math.ceil(endMinutes / 60));
      }
    }

    day.entries.sort((left, right) => {
      if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes;
      if (left.kind !== right.kind) return left.kind === 'time_off' ? -1 : 1;
      return 0;
    });
  }

  return {
    timeZone,
    start,
    end,
    startHour: Math.max(0, Math.min(startHour, 23)),
    endHour: Math.max(startHour + 1, Math.min(endHour, 24)),
    days,
  };
}

/**
 * Where an appointment lands when it is dropped on a day at a time.
 *
 * The new start is a wall clock in the artist's zone, so the operator gets the
 * time they dropped on. The length is elapsed time, so a seven-hour session
 * stays seven hours even when the clocks change inside it.
 */
export function rescheduleTarget(input: {
  appointment: Pick<Appointment, 'start_at' | 'end_at'>;
  dayStart: number;
  minutesFromMidnight: number;
  timeZone: string;
}): { startAt: string; endAt: string } | null {
  const timeZone = input.timeZone || DEFAULT_TIMEZONE;
  const from = instantOf(input.appointment.start_at);
  const to = instantOf(input.appointment.end_at);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;

  const dayParts = zonedParts(input.dayStart, timeZone);
  const minutes = Math.max(0, Math.round(input.minutesFromMidnight));
  const nextStart = zonedTimestamp(
    {
      year: dayParts.year,
      month: dayParts.month,
      day: dayParts.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    timeZone
  );

  return {
    startAt: new Date(nextStart).toISOString(),
    endAt: new Date(nextStart + (to - from)).toISOString(),
  };
}

/**
 * Where an appointment ends when its lower edge is resized onto a grid row.
 *
 * Unlike a move, the start instant stays fixed. The chosen end is a wall clock
 * in the artist's zone, so a manager resizing across a GMT/BST boundary gets
 * the time they pointed at rather than a browser-zone approximation.
 */
export function resizeTarget(input: {
  appointment: Pick<Appointment, 'start_at' | 'end_at'>;
  endDayStart: number;
  endMinutesFromMidnight: number;
  timeZone: string;
}): { startAt: string; endAt: string } | null {
  const timeZone = input.timeZone || DEFAULT_TIMEZONE;
  const from = instantOf(input.appointment.start_at);
  const currentEnd = instantOf(input.appointment.end_at);
  if (Number.isNaN(from) || Number.isNaN(currentEnd) || currentEnd <= from) return null;

  const dayParts = zonedParts(input.endDayStart, timeZone);
  const minutes = Math.max(0, Math.round(input.endMinutesFromMidnight));
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const minutesInDay = minutes % MINUTES_PER_DAY;
  const nextEnd = zonedTimestamp(
    {
      year: dayParts.year,
      month: dayParts.month,
      day: dayParts.day + dayOffset,
      hour: Math.floor(minutesInDay / 60),
      minute: minutesInDay % 60,
    },
    timeZone
  );

  if (nextEnd - from < SLOT_MINUTES * 60_000) return null;

  return {
    startAt: input.appointment.start_at,
    endAt: new Date(nextEnd).toISOString(),
  };
}

/** The slot rows a grid draws between its first and last hour. */
export function slotsFor(calendar: Pick<WeekCalendar, 'startHour' | 'endHour'>): number[] {
  const slots: number[] = [];
  for (let minutes = calendar.startHour * 60; minutes < calendar.endHour * 60; minutes += SLOT_MINUTES) {
    slots.push(minutes);
  }
  return slots;
}

/** "09:30" in the artist's zone, for a slot on the grid. */
export function slotLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The wall-clock time of an instant in the artist's zone, as "09:30". */
export function zonedTimeLabel(value: string, timeZone: string): string {
  const instant = instantOf(value);
  if (Number.isNaN(instant)) return '—';
  return slotLabel(minutesOfZonedDay(instant, timeZone));
}
