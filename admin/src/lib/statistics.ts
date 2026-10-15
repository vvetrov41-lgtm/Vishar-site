// Statistics: periods and changes. Every business figure is computed on the
// server by crm_private.statistics_core (supabase/migrations/
// 20261015120000_statistics_core.sql) and read through public.get_statistics,
// so the CRM, GPT and Today cannot hold three definitions of one number.
// What remains here is what only the screen needs: which window to ask for,
// how to express a change, and the channel vocabulary for labels.

/** Days an enquiry is given before its outcome is judged (server constant). */
export const CONVERSION_MATURITY_DAYS = 14;

export interface CurrencyAmount {
  currency: string;
  amount: number;
  count?: number;
}

/** Channel kinds returned by crm_private.enquiry_channel. */
export type ChannelKind =
  | 'paid'
  | 'campaign'
  | 'social'
  | 'search'
  | 'ai'
  | 'referral'
  | 'internal'
  | 'conversation'
  | 'manual'
  | 'direct';

export interface Channel {
  key: string;
  kind: ChannelKind;
  value: string | null;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------
//
// A period is a half-open interval [from, to) of whole local days. Half-open
// is what makes a session starting exactly at midnight belong to one period
// and not to two, and local days are what make "the last 7 days" mean the same
// thing to the person reading the screen as it does to their calendar.
//
// The previous period is the interval of identical length immediately before
// `from`. That symmetry is the whole point: a change in percent between two
// windows of different length would be meaningless.

export type PeriodPreset = '7d' | '30d' | '90d' | '12m' | 'custom';

export interface Period {
  /** Inclusive. ISO instant at local midnight. */
  from: string;
  /** Exclusive. ISO instant at local midnight. */
  to: string;
}

export interface PeriodPair {
  preset: PeriodPreset;
  /** Whole local days covered by each of the two windows. */
  days: number;
  current: Period;
  previous: Period;
}

export const PERIOD_PRESET_DAYS: Record<Exclude<PeriodPreset, 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  // 365 days, not "the same date last year". A fixed day count is what keeps
  // the current and previous windows exactly comparable; a calendar year would
  // put 366 days against 365 in a leap year and quietly change every delta.
  '12m': 365,
};

export function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

/**
 * `days` whole local days ending with the local day `now` falls in.
 *
 * `now` is included: a 7-day window is today plus the six days before it, so
 * an enquiry that arrived an hour ago is in it. The exclusive end is tomorrow's
 * midnight, which is why a booking later today is counted and one tomorrow is
 * not.
 */
export function periodEndingToday(days: number, now: Date): PeriodPair {
  const safeDays = Math.max(1, Math.floor(days));
  const end = addLocalDays(startOfLocalDay(now), 1);
  const from = addLocalDays(end, -safeDays);
  const previousFrom = addLocalDays(from, -safeDays);
  return {
    preset: 'custom',
    days: safeDays,
    current: { from: from.toISOString(), to: end.toISOString() },
    previous: { from: previousFrom.toISOString(), to: from.toISOString() },
  };
}

export function periodForPreset(preset: Exclude<PeriodPreset, 'custom'>, now: Date): PeriodPair {
  return { ...periodEndingToday(PERIOD_PRESET_DAYS[preset], now), preset };
}

/**
 * A custom range given as two local calendar dates, both inclusive.
 *
 * The end date is inclusive because that is what a person picking "1 March to
 * 31 March" means; the interval it produces still ends at the exclusive
 * midnight opening 1 April, so the half-open rule above is unbroken.
 */
export function periodForDates(fromDate: string, toDate: string): PeriodPair | null {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDate);
  if (!from || !to) return null;
  const end = addLocalDays(to, 1);
  if (end.getTime() <= from.getTime()) return null;
  const days = Math.round((end.getTime() - from.getTime()) / 86400000);
  const previousFrom = addLocalDays(from, -days);
  return {
    preset: 'custom',
    days,
    current: { from: from.toISOString(), to: end.toISOString() },
    previous: { from: previousFrom.toISOString(), to: from.toISOString() },
  };
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Half-open membership: `from <= value < to`. An unparseable timestamp is out,
 *  never in - a row the CRM cannot place in time must not inflate a count. */
export function within(period: Period, value: string | null | undefined): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return false;
  return at >= Date.parse(period.from) && at < Date.parse(period.to);
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export interface Delta {
  current: number;
  previous: number;
  /** Absolute change. Always available. */
  difference: number;
  /**
   * Relative change, or null when there is nothing to divide by.
   *
   * Going from 0 to 4 is not "a 400% rise", it is "4 where there were none",
   * so the screen shows the absolute change instead of a fabricated ratio.
   */
  percent: number | null;
}

export function delta(current: number, previous: number): Delta {
  return {
    current,
    previous,
    difference: current - previous,
    percent: previous === 0 ? null : ((current - previous) / previous) * 100,
  };
}

/** A change in a rate, in points, or null when either side has no rate. */
export function rateDelta(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  return delta(Math.round(current), Math.round(previous));
}
