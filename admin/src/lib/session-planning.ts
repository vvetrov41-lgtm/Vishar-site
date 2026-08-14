import type { CrmSession } from './types';

export const SESSION_DURATION_SHORTCUTS = [3, 5, 7] as const;

const CONFLICTING_STATUSES = new Set<CrmSession['status']>([
  'draft',
  'proposed',
  'confirmed',
]);

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function addHoursToLocalDateTime(value: string, hours: number): string {
  const start = validDate(value);
  if (!start || !Number.isFinite(hours) || hours <= 0) return '';

  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  return [
    end.getFullYear(),
    '-',
    pad(end.getMonth() + 1),
    '-',
    pad(end.getDate()),
    'T',
    pad(end.getHours()),
    ':',
    pad(end.getMinutes()),
  ].join('');
}

export function findSessionConflicts(
  sessions: CrmSession[],
  startValue: string,
  endValue: string
): CrmSession[] {
  const start = validDate(startValue);
  const end = validDate(endValue);
  if (!start || !end || end <= start) return [];

  return sessions.filter((session) => {
    if (!CONFLICTING_STATUSES.has(session.status)) return false;
    const existingStart = validDate(session.start_at);
    const existingEnd = validDate(session.end_at);
    if (!existingStart || !existingEnd) return false;
    return existingStart < end && existingEnd > start;
  });
}
