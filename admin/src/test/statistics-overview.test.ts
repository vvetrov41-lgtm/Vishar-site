// The screen's view of get_statistics: combining artists and deciding what to
// say. No business definition is tested here; those live in SQL and are
// pinned by supabase/tests/1845_statistics_core.sql.

import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  combineCores,
  conversionRate,
} from '../lib/statistics-overview';
import type { StatisticsCore, StatisticsResult } from '../lib/statistics-api';
import { STATISTICS_FINANCE, statisticsCore, statisticsResult } from './fixtures';

const label = (row: { key: string }) => row.key;
const core = (overrides: Record<string, unknown> = {}) => statisticsCore(overrides) as unknown as StatisticsCore;

function result(artists: Array<Partial<StatisticsResult['artists'][number]>>): StatisticsResult {
  const base = statisticsResult(false) as unknown as StatisticsResult;
  return { ...base, artists: artists.map((artist, index) => ({ ...base.artists[0], artist_id: `artist-${index}`, ...artist })) };
}

describe('combining artists', () => {
  it('adds counts and same-currency money, never rates or medians', () => {
    const a = core({ finance: STATISTICS_FINANCE });
    const b = core({
      enquiries: 3,
      conversion: { cohort: 3, mature: 1, converted: 1, pending: 2, pending_converted: 0, median_days_to_booking: 9 },
      reply: { median_first_reply_hours: 20, timed: 1, answered_without_time: 0, unanswered: 1 },
      finance: { ...STATISTICS_FINANCE, received: [{ currency: 'GBP', amount: 100, count: 1 }, { currency: 'EUR', amount: 50, count: 1 }] },
    });
    const combined = combineCores([a, b]);
    expect(combined.enquiries).toBe(15);
    expect(combined.conversion.mature).toBe(10);
    expect(combined.conversion.converted).toBe(4);
    expect(conversionRate(combined)).toBe(40);
    expect(combined.reply.median_first_reply_hours).toBeNull();
    expect(combined.conversion.median_days_to_booking).toBeNull();
    expect(combined.finance?.received).toEqual([
      { currency: 'EUR', amount: 50, count: 1 },
      { currency: 'GBP', amount: 600, count: 3 },
    ]);
  });

  it('merges channels by key and weeks by position', () => {
    const combined = combineCores([core(), core()]);
    expect(combined.channels.find((row) => row.key === 'paid:meta')?.enquiries).toBe(18);
    expect(combined.upcoming.weeks[0].tattoo_hours).toBe(24);
    expect(combined.upcoming.weeks).toHaveLength(12);
  });

  it('keeps finance absent when no artist returned it', () => {
    expect(combineCores([core(), core()]).finance).toBeNull();
  });
});

describe('overview', () => {
  it('states changes only when every artist\'s history covers the previous window', () => {
    expect(buildOverview(result([{ comparable: true }]), label).comparable).toBe(true);
    expect(buildOverview(result([{ comparable: true }, { comparable: false }]), label).comparable).toBe(false);
  });

  it('keeps a median per artist', () => {
    const overview = buildOverview(result([{}, {}]), label);
    expect(overview.replyMedians).toEqual([
      { artistId: 'artist-0', hours: 6.5 },
      { artistId: 'artist-1', hours: 6.5 },
    ]);
  });

  it('has no conversion and no conversion change while nothing is old enough', () => {
    const young = core({ conversion: { cohort: 4, mature: 0, converted: 0, pending: 4, pending_converted: 1, median_days_to_booking: null } });
    const overview = buildOverview(result([{ current: young }]), label);
    expect(overview.conversion).toBeNull();
    expect(overview.conversionDelta).toBeNull();
  });

  it('asks for the outcome of ended consultations, which are never counted as held', () => {
    const awaiting = core({
      consultations_awaiting_outcome: 3,
      sessions: { ...core().sessions, consultations_held: 1, consultations_unverified: 3 },
    });
    const overview = buildOverview(result([{ current: awaiting }]), label);
    expect(overview.attention).toContainEqual({
      id: 'consultationsAwaitingOutcome',
      params: { count: 3 },
      target: '/appointments#consultation-outcomes',
    });
    expect(overview.current.sessions.consultations_held).toBe(1);
  });

  it('asks for attention on unanswered enquiries, empty weeks ahead and a channel with no bookings', () => {
    const overview = buildOverview({ ...result([{}]), from: '2026-10-05T23:00:00Z' }, label);
    expect(overview.attention.map((item) => item.id)).toEqual(['unanswered', 'emptyWeeks', 'channelNoBookings']);
    const empty = overview.attention.find((item) => item.id === 'emptyWeeks')!;
    // Weeks 2..8 of the fixture have nothing booked; this week is not counted.
    expect(empty.params.count).toBe(6);
    expect(overview.attention.find((item) => item.id === 'channelNoBookings')!.params).toEqual({ channel: 'paid:meta', enquiries: 8 });
  });

  // Codex review on #1097: before reply evidence was complete, a reply the
  // CRM never saw reads as "no reply".
  it('raises no unanswered alert for a period that starts before reply evidence was complete', () => {
    const overview = buildOverview({ ...result([{}]), from: '2026-09-15T23:00:00Z' }, label);
    expect(overview.replyCoverage).toBe(false);
    expect(overview.attention.some((item) => item.id === 'unanswered')).toBe(false);
  });

  it('keeps a booking-time median per artist', () => {
    expect(buildOverview(result([{}, {}]), label).bookingMedians).toEqual([
      { artistId: 'artist-0', days: 4.5 },
      { artistId: 'artist-1', days: 4.5 },
    ]);
  });

  // Codex review on #1097: a total that silently omits artists without finance.
  it('combines no money when any artist returned none', () => {
    const withMoney = core({ finance: STATISTICS_FINANCE });
    expect(combineCores([withMoney, core()]).finance).toBeNull();
    expect(combineCores([withMoney, withMoney]).finance?.received[0].amount).toBe(1000);
  });

  it('never names direct, manual or own-site traffic as a channel that does not book', () => {
    const quiet = core({
      reply: { median_first_reply_hours: 1, timed: 1, answered_without_time: 0, unanswered: 0 },
      channels: [
        { key: 'direct', kind: 'direct', value: null, enquiries: 20, consulted: 0, booked: 0, matured: 20, matured_booked: 0 },
        { key: 'internal', kind: 'internal', value: null, enquiries: 9, consulted: 0, booked: 0, matured: 9, matured_booked: 0 },
      ],
      upcoming: { weeks: Array.from({ length: 12 }, (_, i) => ({ week_start: `2026-08-${String(i + 1).padStart(2, '0')}`, tattoo_sessions: 1, tattoo_hours: 6, consultations: 0 })), tattoo_sessions_later: 0 },
    });
    expect(buildOverview(result([{ current: quiet }]), label).attention).toEqual([]);
  });

  it('lists open payment requests only where finance was returned', () => {
    const withMoney = buildOverview(result([{ current: core({ finance: STATISTICS_FINANCE }) }]), label);
    expect(withMoney.attention.some((item) => item.id === 'openPayments')).toBe(true);
    expect(buildOverview(result([{}]), label).attention.some((item) => item.id === 'openPayments')).toBe(false);
  });

  it('compares conversion only over mature enquiries in both windows', () => {
    const now = core({ conversion: { cohort: 20, mature: 10, converted: 0, pending: 10, pending_converted: 0, median_days_to_booking: null } });
    const before = core({ conversion: { cohort: 10, mature: 10, converted: 4, pending: 0, pending_converted: 0, median_days_to_booking: 3 } });
    const overview = buildOverview(result([{ current: now, previous: before }]), label);
    expect(overview.insights).toContainEqual({
      id: 'insight.conversionDown',
      params: { from: 40, to: 0, mature: 10 },
      tone: 'bad',
    });
  });

  it('adds the forecast across artists without mixing confirmed and estimated value', () => {
    const rated = core({ finance: STATISTICS_FINANCE });
    const unrated = core({
      finance: {
        ...STATISTICS_FINANCE,
        forecast: {
          sessions: 2,
          pricing_configured: false,
          confirmed: { sessions: 0, value: [], remaining_after_deposits: [] },
          estimated: { sessions: 0, full_day: 0, hourly: 0, from_project_rate: 0, value: [] },
          no_basis: { sessions: 2, hours: 14 },
          expected_value: [],
          deposits_paid: [],
          remaining_after_deposits: [],
        },
      },
    });
    const forecast = combineCores([rated, unrated]).finance!.forecast;
    expect(forecast.sessions).toBe(21);
    expect(forecast.confirmed.value).toMatchObject([{ currency: 'GBP', amount: 5880 }]);
    expect(forecast.estimated.value).toMatchObject([{ currency: 'GBP', amount: 11340 }]);
    expect(forecast.no_basis).toEqual({ sessions: 2, hours: 14 });
    // One artist without rates: the combined view must not claim rates exist.
    expect(forecast.pricing_configured).toBe(false);
  });
});
