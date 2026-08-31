import type { Appointment } from './appointment-api';
import type { AvailabilityBlock } from './availability-api';

export interface MonthAppointmentEntry {
  kind: 'appointment';
  key: string;
  at: number;
  appointment: Appointment;
}

export interface MonthTimeOffEntry {
  kind: 'time_off';
  key: string;
  at: number;
  block: AvailabilityBlock;
}

export type MonthCalendarEntry = MonthAppointmentEntry | MonthTimeOffEntry;

export interface MonthCalendarDay {
  date: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  entries: MonthCalendarEntry[];
}

export interface MonthCalendar {
  start: number;
  end: number;
  days: MonthCalendarDay[];
}

function parsedTime(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function startOfLocalDay(value: Date | number): number {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function startOfLocalMonth(value: Date | number): number {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function addLocalDays(value: Date | number, days: number): number {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** Monday-first six-week window used by a conventional month calendar. */
export function calendarMonthWindow(month: Date | number): { start: number; end: number } {
  const monthStart = new Date(startOfLocalMonth(month));
  const mondayOffset = (monthStart.getDay() + 6) % 7;
  const start = addLocalDays(monthStart, -mondayOffset);
  return { start, end: addLocalDays(start, 42) };
}

export function buildMonthCalendar(input: {
  month: Date | number;
  now: Date;
  appointments: Appointment[];
  timeOff: AvailabilityBlock[];
}): MonthCalendar {
  const monthStart = startOfLocalMonth(input.month);
  const monthDate = new Date(monthStart);
  const currentMonth = monthDate.getMonth();
  const currentYear = monthDate.getFullYear();
  const today = startOfLocalDay(input.now);
  const window = calendarMonthWindow(monthStart);
  const days: MonthCalendarDay[] = [];

  for (let offset = 0; offset < 42; offset += 1) {
    const date = addLocalDays(window.start, offset);
    const local = new Date(date);
    days.push({
      date,
      isCurrentMonth: local.getMonth() === currentMonth && local.getFullYear() === currentYear,
      isToday: date === today,
      entries: [],
    });
  }

  const byDate = new Map(days.map((day) => [day.date, day]));

  for (const appointment of input.appointments) {
    const at = parsedTime(appointment.start_at);
    if (Number.isNaN(at) || at < window.start || at >= window.end) continue;
    const day = byDate.get(startOfLocalDay(at));
    day?.entries.push({
      kind: 'appointment',
      key: `appointment-${appointment.id}`,
      at,
      appointment,
    });
  }

  for (const block of input.timeOff) {
    if (block.cancelled_at !== null) continue;
    const from = parsedTime(block.start_at);
    const to = parsedTime(block.end_at);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;

    for (const day of days) {
      const dayEnd = addLocalDays(day.date, 1);
      if (to <= day.date || from >= dayEnd) continue;
      day.entries.push({
        kind: 'time_off',
        key: `time-off-${block.block_id}-${day.date}`,
        at: Math.max(from, day.date),
        block,
      });
    }
  }

  for (const day of days) {
    day.entries.sort((left, right) => {
      if (left.at !== right.at) return left.at - right.at;
      if (left.kind !== right.kind) return left.kind === 'time_off' ? -1 : 1;
      return 0;
    });
  }

  return { ...window, days };
}
