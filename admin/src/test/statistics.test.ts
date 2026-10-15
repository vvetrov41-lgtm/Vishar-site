// Statistics periods and changes. Every business figure is defined once, in
// crm_private.statistics_core, and pinned by supabase/tests/1845_statistics_core.sql.

import { describe, expect, it } from 'vitest';
import {
  delta,
  periodEndingToday,
  periodForDates,
  periodForPreset,
  rateDelta,
  within,
} from '../lib/statistics';

// Midday local, so a whole-day window has room on both sides of it.
const NOW = new Date(2026, 8, 5, 12, 0, 0);

describe('period boundaries', () => {
  it('covers whole local days and includes today', () => {
    const { current, previous, days } = periodEndingToday(7, NOW);
    expect(days).toBe(7);
    expect(new Date(current.from)).toEqual(new Date(2026, 7, 30));
    expect(new Date(current.to)).toEqual(new Date(2026, 8, 6));
    expect(new Date(previous.from)).toEqual(new Date(2026, 7, 23));
    expect(new Date(previous.to)).toEqual(new Date(2026, 7, 30));
  });

  it('gives the current and previous window identical length', () => {
    for (const preset of ['7d', '30d', '90d', '12m'] as const) {
      const pair = periodForPreset(preset, NOW);
      const currentSpan = Date.parse(pair.current.to) - Date.parse(pair.current.from);
      const previousSpan = Date.parse(pair.previous.to) - Date.parse(pair.previous.from);
      expect(previousSpan).toBe(currentSpan);
      // Contiguous: no gap and no overlap between the two windows.
      expect(pair.previous.to).toBe(pair.current.from);
    }
  });

  it('treats 12 months as 365 days, so a leap year cannot skew the comparison', () => {
    expect(periodForPreset('12m', NOW).days).toBe(365);
  });

  it('is half-open, so a midnight boundary belongs to exactly one period', () => {
    const { current, previous } = periodEndingToday(7, NOW);
    const boundary = current.from;
    expect(within(current, boundary)).toBe(true);
    expect(within(previous, boundary)).toBe(false);
    expect(within(current, current.to)).toBe(false);
  });

  it('excludes a row whose timestamp cannot be read at all', () => {
    const { current } = periodEndingToday(7, NOW);
    expect(within(current, 'not a date')).toBe(false);
    expect(within(current, null)).toBe(false);
    expect(within(current, '')).toBe(false);
  });

  it('reads a custom range as two inclusive local dates', () => {
    const pair = periodForDates('2026-03-01', '2026-03-31');
    expect(pair).not.toBeNull();
    expect(pair!.days).toBe(31);
    expect(new Date(pair!.current.from)).toEqual(new Date(2026, 2, 1));
    expect(new Date(pair!.current.to)).toEqual(new Date(2026, 3, 1));
    expect(new Date(pair!.previous.from)).toEqual(new Date(2026, 0, 29));
  });

  it('refuses a custom range that is backwards or unparseable', () => {
    expect(periodForDates('2026-03-31', '2026-03-01')).toBeNull();
    expect(periodForDates('March', '2026-03-01')).toBeNull();
    expect(periodForDates('2026-3-1', '2026-03-31')).toBeNull();
  });
});

describe('delta', () => {
  it('reports the absolute change and, where it exists, the relative one', () => {
    expect(delta(12, 10)).toEqual({ current: 12, previous: 10, difference: 2, percent: 20 });
  });

  it('refuses a percentage against nothing rather than claiming an infinite rise', () => {
    expect(delta(4, 0).percent).toBeNull();
    expect(delta(4, 0).difference).toBe(4);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('rate changes', () => {
  // Audit 2026-10-15, P0-5: "+N pts, was 0" against an empty cohort.
  it('states no change in a rate when either side has no rate', () => {
    expect(rateDelta(40, null)).toBeNull();
    expect(rateDelta(null, 40)).toBeNull();
    expect(rateDelta(null, null)).toBeNull();
    expect(rateDelta(40, 25)?.difference).toBe(15);
  });
});
