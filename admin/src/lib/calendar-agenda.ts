// The schedule as a diary rather than a list.
//
// `/appointments` showed one flat "upcoming" list and one flat "past" list,
// with no day boundaries and no marker for today. "Who am I seeing today?" and
// "when am I free?" both required reading dates off consecutive rows and doing
// the grouping in your head - and time off, which is the other half of the
// answer, lived on a different screen entirely.
//
// This groups both into days. Pure, and given `now` explicitly, so the day
// boundary is tested rather than inferred from whenever the suite runs.

import type { Appointment } from './appointment-api';
import type { AvailabilityBlock } from './availability-api';

export interface AgendaAppointmentEntry {
  kind: 'appointment';
  key: string;
  at: number;
  appointment: Appointment;
}

export interface AgendaTimeOffEntry {
  kind: 'time_off';
  key: string;
  at: number;
  block: AvailabilityBlock;
}

export type AgendaEntry = AgendaAppointmentEntry | AgendaTimeOffEntry;

export interface AgendaDay {
  /** Local midnight for the day, as a timestamp. */
  date: number;
  isToday: boolean;
  entries: AgendaEntry[];
}

export interface AgendaInput {
  now: Date;
  appointments: Appointment[];
  timeOff: AvailabilityBlock[];
  /** How many days forward to lay out, including today. */
  days: number;
}

/** Appointment states that still describe a real commitment. */
const LIVE_STATUSES = new Set(['draft', 'proposed', 'confirmed']);

function time(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function startOfDay(value: Date | number): number {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The days the operator can see ahead, each carrying whatever falls in it.
 *
 * Every day in the window is present, including empty ones: "nothing booked on
 * Thursday" is the answer to "when am I free?", and a list that simply omits
 * Thursday does not give it.
 */
export function buildAgenda(input: AgendaInput): AgendaDay[] {
  const today = startOfDay(input.now);
  const days: AgendaDay[] = [];

  for (let offset = 0; offset < Math.max(1, input.days); offset += 1) {
    const date = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() + offset);
    days.push({ date: date.getTime(), isToday: offset === 0, entries: [] });
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  const windowEnd = days[days.length - 1].date + 86400000;

  for (const appointment of input.appointments) {
    if (appointment.cancelled_at !== null) continue;
    if (!LIVE_STATUSES.has(appointment.status)) continue;
    const at = time(appointment.start_at);
    if (Number.isNaN(at) || at < today || at >= windowEnd) continue;
    byDate.get(startOfDay(at))?.entries.push({
      kind: 'appointment',
      key: `appointment-${appointment.id}`,
      at,
      appointment,
    });
  }

  // Time off is a span, not a point: a week away has to mark every day it
  // covers, or the operator sees a free Wednesday in the middle of a holiday.
  for (const block of input.timeOff) {
    if (block.cancelled_at !== null) continue;
    const from = time(block.start_at);
    const to = time(block.end_at);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;

    for (const day of days) {
      const dayEnd = day.date + 86400000;
      if (to <= day.date || from >= dayEnd) continue;
      day.entries.push({
        kind: 'time_off',
        key: `time-off-${block.block_id}-${day.date}`,
        // All-day blocks and blocks that started earlier sort to the top of the
        // day they cover; a half-day block sorts at the hour it begins.
        at: Math.max(from, day.date),
        block,
      });
    }
  }

  for (const day of days) {
    day.entries.sort((left, right) => {
      if (left.at !== right.at) return left.at - right.at;
      // A block covering the whole day frames the day, so it reads first.
      if (left.kind !== right.kind) return left.kind === 'time_off' ? -1 : 1;
      return 0;
    });
  }

  return days;
}

/** Historical or terminal appointments, newest first. */
export function pastAppointments(now: Date, appointments: Appointment[]): Appointment[] {
  const today = startOfDay(now);
  return appointments
    .filter((appointment) => appointment.cancelled_at !== null
      || !LIVE_STATUSES.has(appointment.status)
      // A live appointment from earlier today remains in today's diary. Putting
      // it in Past as well renders the same record twice once its start time
      // passes. Only live appointments from an earlier local day are history.
      || time(appointment.start_at) < today)
    .sort((left, right) => time(right.start_at) - time(left.start_at));
}

/** Live appointments beyond the agenda window, soonest first. */
export function beyondAgenda(now: Date, days: number, appointments: Appointment[]): Appointment[] {
  const windowEnd = startOfDay(now) + Math.max(1, days) * 86400000;
  return appointments
    .filter((appointment) => appointment.cancelled_at === null
      && LIVE_STATUSES.has(appointment.status)
      && time(appointment.start_at) >= windowEnd)
    .sort((left, right) => time(left.start_at) - time(right.start_at));
}
