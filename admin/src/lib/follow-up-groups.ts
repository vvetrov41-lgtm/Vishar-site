import type { FollowUp } from './types';

export type FollowUpGroupKey =
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'later'
  | 'completed';

export type FollowUpGroups = Record<FollowUpGroupKey, FollowUp[]>;

interface LocalDay {
  year: number;
  month: number;
  day: number;
}

function localDay(value: string | Date, timeZone: string): LocalDay {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(safeDate);
    const number = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return { year: number('year'), month: number('month'), day: number('day') };
  };
  try {
    return read(timeZone);
  } catch {
    return read('UTC');
  }
}

function serialDay(day: LocalDay): number {
  return Math.floor(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

function daysUntilEndOfWeek(day: LocalDay): number {
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return weekday === 0 ? 0 : 7 - weekday;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function groupFollowUps(
  followUps: FollowUp[],
  now: Date,
  timeZoneByArtist: Record<string, string>,
): FollowUpGroups {
  const groups: FollowUpGroups = {
    overdue: [],
    today: [],
    tomorrow: [],
    this_week: [],
    later: [],
    completed: [],
  };

  for (const followUp of followUps) {
    if (followUp.status !== 'open') {
      groups.completed.push(followUp);
      continue;
    }

    const timeZone = timeZoneByArtist[followUp.artist_id] ?? 'UTC';
    const today = localDay(now, timeZone);
    const due = localDay(followUp.due_at, timeZone);
    const difference = serialDay(due) - serialDay(today);

    if (difference < 0) groups.overdue.push(followUp);
    else if (difference === 0) groups.today.push(followUp);
    else if (difference === 1) groups.tomorrow.push(followUp);
    else if (difference <= daysUntilEndOfWeek(today)) groups.this_week.push(followUp);
    else groups.later.push(followUp);
  }

  for (const key of ['overdue', 'today', 'tomorrow', 'this_week', 'later'] as const) {
    groups[key].sort((left, right) => timestamp(left.due_at) - timestamp(right.due_at));
  }
  groups.completed.sort((left, right) => timestamp(right.due_at) - timestamp(left.due_at));
  return groups;
}

export function followUpHref(followUp: FollowUp): string {
  if (followUp.enquiry_id) return `/enquiries/${followUp.enquiry_id}`;
  if (followUp.project_id) return `/projects/${followUp.project_id}`;
  if (followUp.client_id) return `/clients/${followUp.client_id}`;
  return '/follow-ups';
}
