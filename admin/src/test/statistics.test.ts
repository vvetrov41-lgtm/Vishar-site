// The Statistics screen's arithmetic, tested without a database or a browser.
//
// Every metric on that screen is a claim about the studio's own records, so
// what is pinned here is the definition rather than the rendering: which rows
// are in scope, which timestamp decides the period, and what a rate divides by.
// A number that cannot survive these cases has no business being shown.

import { describe, expect, it } from 'vitest';
import {
  buildInsights,
  conversionMaturity,
  convertedEnquiryIds,
  delta,
  enquiryConversion,
  financeTotals,
  funnel,
  granularityFor,
  localIsoDate,
  periodEndingToday,
  periodForDates,
  periodForPreset,
  repeatClients,
  sessionHours,
  sessionTotals,
  sessionsByWeekday,
  sourceBreakdown,
  sourceKeyFor,
  timeSeries,
  upcomingLoad,
  within,
  type StatisticsEnquiry,
  type StatisticsPaymentRequest,
  type StatisticsProject,
  type StatisticsSession,
  type StatisticsTransaction,
} from '../lib/statistics';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const OTHER_ARTIST = 'a2222222-2222-4222-8222-222222222222';
const CLIENT = 'c1111111-1111-4111-8111-111111111111';

// Midday local, so a whole-day window has room on both sides of it.
const NOW = new Date(2026, 8, 5, 12, 0, 0);

function enquiry(overrides: Partial<StatisticsEnquiry> = {}): StatisticsEnquiry {
  return {
    id: 'enquiry-1',
    artist_id: ARTIST,
    client_id: CLIENT,
    status: 'new',
    source: '/booking/',
    booking_source_id: null,
    communication_channel: null,
    utm_source: null,
    created_at: new Date(2026, 8, 1, 10, 0, 0).toISOString(),
    ...overrides,
  };
}

function project(overrides: Partial<StatisticsProject> = {}): StatisticsProject {
  return {
    id: 'project-1',
    artist_id: ARTIST,
    client_id: CLIENT,
    enquiry_id: 'enquiry-1',
    status: 'active',
    created_at: new Date(2026, 8, 2, 10, 0, 0).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<StatisticsSession> = {}): StatisticsSession {
  return {
    id: 'session-1',
    artist_id: ARTIST,
    client_id: CLIENT,
    project_id: 'project-1',
    enquiry_id: 'enquiry-1',
    status: 'completed',
    appointment_type: 'tattoo_session',
    start_at: new Date(2026, 8, 3, 10, 0, 0).toISOString(),
    end_at: new Date(2026, 8, 3, 15, 0, 0).toISOString(),
    duration_hours: 5,
    cancelled_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

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

describe('enquiry conversion', () => {
  const { current } = periodEndingToday(30, NOW);

  it('divides converted enquiries by the enquiries created in the period', () => {
    const enquiries = [
      enquiry({ id: 'e1' }),
      enquiry({ id: 'e2' }),
      enquiry({ id: 'e3' }),
      enquiry({ id: 'e4' }),
    ];
    const projects = [project({ id: 'p1', enquiry_id: 'e1' })];
    const sessions = [session({ id: 's1', enquiry_id: 'e2', project_id: null })];

    const result = enquiryConversion(enquiries, projects, sessions, current);
    expect(result.denominator).toBe(4);
    expect(result.converted).toBe(2);
    expect(result.rate).toBe(50);
  });

  it('counts an enquiry once however many projects it produced', () => {
    const enquiries = [enquiry({ id: 'e1' })];
    const projects = [
      project({ id: 'p1', enquiry_id: 'e1' }),
      project({ id: 'p2', enquiry_id: 'e1' }),
    ];
    const result = enquiryConversion(enquiries, projects, [], current);
    expect(result.converted).toBe(1);
    expect(result.rate).toBe(100);
  });

  it('counts a conversion that happened after the period closed', () => {
    // The cohort is fixed by when the enquiry arrived. What became of it is not
    // bounded by the same window, or a period would report the wrong answer for
    // every enquiry converted the following week.
    const enquiries = [enquiry({ id: 'e1' })];
    const projects = [project({
      id: 'p1',
      enquiry_id: 'e1',
      created_at: new Date(2027, 0, 1).toISOString(),
    })];
    expect(enquiryConversion(enquiries, projects, [], current).converted).toBe(1);
  });

  it('reaches an enquiry through the session\'s project when the session has no enquiry of its own', () => {
    const projects = [project({ id: 'p1', enquiry_id: 'e1' })];
    const sessions = [session({ id: 's1', enquiry_id: null, project_id: 'p1' })];
    expect(convertedEnquiryIds(projects, sessions).has('e1')).toBe(true);
  });

  it('does not treat a draft session as a conversion', () => {
    const sessions = [session({ id: 's1', enquiry_id: 'e1', status: 'draft' })];
    expect(convertedEnquiryIds([], sessions).size).toBe(0);
  });

  it('returns no rate at all over an empty cohort, rather than nought per cent', () => {
    const result = enquiryConversion([], [], [], current);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
  });

  it('says how much of the cohort has had time to convert', () => {
    const enquiries = [
      enquiry({ id: 'old', created_at: new Date(2026, 7, 15).toISOString() }),
      enquiry({ id: 'fresh', created_at: new Date(2026, 8, 4).toISOString() }),
    ];
    const maturity = conversionMaturity(enquiries, current, NOW, 14);
    expect(maturity.total).toBe(2);
    expect(maturity.settled).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('sessions', () => {
  const { current } = periodEndingToday(30, NOW);

  it('splits bookings by status and never counts a draft', () => {
    const totals = sessionTotals([
      session({ id: 's1', status: 'completed' }),
      session({ id: 's2', status: 'confirmed' }),
      session({ id: 's3', status: 'proposed' }),
      session({ id: 's4', status: 'cancelled' }),
      session({ id: 's5', status: 'no_show' }),
      session({ id: 's6', status: 'draft' }),
    ], current);

    expect(totals.booked).toBe(5);
    expect(totals.completed).toBe(1);
    expect(totals.planned).toBe(2);
    expect(totals.cancelled).toBe(1);
    expect(totals.noShow).toBe(1);
  });

  it('keeps a no-show apart from a cancellation', () => {
    const totals = sessionTotals([
      session({ id: 's1', status: 'no_show' }),
      session({ id: 's2', status: 'completed' }),
    ], current);
    expect(totals.cancelled).toBe(0);
    expect(totals.cancellationRate).toBe(0);
  });

  it('rates cancellations against every booking due in the period', () => {
    const totals = sessionTotals([
      session({ id: 's1', status: 'cancelled' }),
      session({ id: 's2', status: 'completed' }),
      session({ id: 's3', status: 'confirmed' }),
      session({ id: 's4', status: 'completed' }),
    ], current);
    expect(totals.cancellationRate).toBe(25);
  });

  it('places a cancellation by when it was due, not by when it was called off', () => {
    // One timestamp on both sides of the division, or the rate compares two
    // different populations.
    const cancelled = session({
      id: 's1',
      status: 'cancelled',
      start_at: new Date(2026, 8, 3, 10, 0, 0).toISOString(),
      end_at: new Date(2026, 8, 3, 14, 0, 0).toISOString(),
      cancelled_at: new Date(2026, 5, 1).toISOString(),
    });
    expect(sessionTotals([cancelled], current).cancelled).toBe(1);
  });

  it('counts hours from completed sessions only', () => {
    const totals = sessionTotals([
      session({ id: 's1', status: 'completed', duration_hours: 5 }),
      session({ id: 's2', status: 'confirmed', duration_hours: 6 }),
      session({ id: 's3', status: 'cancelled', duration_hours: 7 }),
    ], current);
    expect(totals.hours).toBe(5);
    expect(totals.averageHours).toBe(5);
  });

  it('falls back to the wall clock when a legacy row carries no duration', () => {
    expect(sessionHours(session({ duration_hours: null }))).toBe(5);
  });

  it('contributes nothing rather than a guess when neither duration nor span works', () => {
    expect(sessionHours(session({
      duration_hours: null,
      start_at: 'nonsense',
      end_at: 'nonsense',
    }))).toBe(0);
    expect(sessionHours(session({
      duration_hours: null,
      end_at: new Date(2026, 8, 3, 9, 0, 0).toISOString(),
    }))).toBe(0);
  });

  it('has no average and no rate over an empty period', () => {
    const totals = sessionTotals([], current);
    expect(totals.averageHours).toBeNull();
    expect(totals.cancellationRate).toBeNull();
    expect(totals.hours).toBe(0);
  });

  it('counts only planned work ahead, and states it in hours rather than a percentage', () => {
    const load = upcomingLoad([
      session({ id: 's1', status: 'confirmed', start_at: new Date(2026, 8, 20, 10, 0, 0).toISOString(), duration_hours: 4 }),
      session({ id: 's2', status: 'completed', start_at: new Date(2026, 8, 21, 10, 0, 0).toISOString(), duration_hours: 4 }),
      session({ id: 's3', status: 'confirmed', start_at: new Date(2026, 10, 20, 10, 0, 0).toISOString(), duration_hours: 4 }),
      session({ id: 's4', status: 'confirmed', start_at: new Date(2026, 7, 1, 10, 0, 0).toISOString(), duration_hours: 4 }),
    ], NOW, 30);
    expect(load.sessions).toBe(1);
    expect(load.hours).toBe(4);
    expect(load).not.toHaveProperty('utilisation');
  });

  it('reports weekdays Monday first and ignores cancelled bookings', () => {
    // 2026-09-03 is a Thursday.
    const counts = sessionsByWeekday([
      session({ id: 's1', start_at: new Date(2026, 8, 3, 10, 0, 0).toISOString() }),
      session({ id: 's2', start_at: new Date(2026, 8, 3, 16, 0, 0).toISOString() }),
      session({ id: 's3', status: 'cancelled', start_at: new Date(2026, 8, 4, 10, 0, 0).toISOString() }),
    ], current);
    expect(counts[3]).toBe(2);
    expect(counts[4]).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('repeat clients', () => {
  const { current } = periodEndingToday(30, NOW);

  it('counts a client seen more than once by the same artist', () => {
    const history = [
      session({ id: 's1', client_id: 'client-a', start_at: new Date(2025, 1, 1).toISOString() }),
      session({ id: 's2', client_id: 'client-a' }),
      session({ id: 's3', client_id: 'client-b' }),
    ];
    const result = repeatClients(history, current);
    expect(result.active).toBe(2);
    expect(result.repeat).toBe(1);
    expect(result.rate).toBe(50);
  });

  it('does not merge two artists into one relationship', () => {
    // One visit each is not a repeat client for either artist.
    const history = [
      session({ id: 's1', client_id: 'client-a', artist_id: ARTIST }),
      session({ id: 's2', client_id: 'client-a', artist_id: OTHER_ARTIST }),
    ];
    const result = repeatClients(history, current);
    expect(result.active).toBe(2);
    expect(result.repeat).toBe(0);
  });

  it('counts history outside the period, so a long-standing client is not called new', () => {
    const history = [
      session({ id: 'old', client_id: 'client-a', start_at: new Date(2024, 3, 1).toISOString() }),
      session({ id: 'now', client_id: 'client-a' }),
    ];
    expect(repeatClients(history, current).repeat).toBe(1);
  });

  it('ignores cancelled bookings on both sides of the count', () => {
    const history = [
      session({ id: 'old', client_id: 'client-a', status: 'cancelled', start_at: new Date(2024, 3, 1).toISOString() }),
      session({ id: 'now', client_id: 'client-a' }),
    ];
    const result = repeatClients(history, current);
    expect(result.active).toBe(1);
    expect(result.repeat).toBe(0);
  });

  it('identifies clients by id, never by a matching name or address', () => {
    // Two distinct client rows stay two clients whatever they are called.
    const history = [
      session({ id: 's1', client_id: 'client-a' }),
      session({ id: 's2', client_id: 'client-b' }),
    ];
    expect(repeatClients(history, current).repeat).toBe(0);
  });

  it('has no rate when nobody was seen', () => {
    expect(repeatClients([], current).rate).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('sources', () => {
  const { current } = periodEndingToday(30, NOW);

  it('applies one rule per enquiry, in a fixed priority order', () => {
    expect(sourceKeyFor(enquiry({
      booking_source_id: 'bs-1',
      communication_channel: 'whatsapp',
      utm_source: 'instagram',
      source: '/booking/',
    }))).toEqual({ key: 'booking_source:bs-1', kind: 'booking_source', value: 'bs-1' });

    expect(sourceKeyFor(enquiry({
      booking_source_id: null,
      communication_channel: 'instagram',
      utm_source: 'ads',
    })).kind).toBe('channel');

    expect(sourceKeyFor(enquiry({
      booking_source_id: null,
      communication_channel: null,
      utm_source: 'ads',
    })).kind).toBe('utm');

    expect(sourceKeyFor(enquiry({
      booking_source_id: null,
      communication_channel: null,
      utm_source: '   ',
      source: 'crm_manual',
    })).kind).toBe('form');

    expect(sourceKeyFor(enquiry({
      booking_source_id: null,
      communication_channel: null,
      utm_source: null,
      source: null,
    })).kind).toBe('unknown');
  });

  it('keeps two registry forms apart even when they share a landing page', () => {
    const rows = sourceBreakdown([
      enquiry({ id: 'e1', booking_source_id: 'bs-1', source: '/booking/' }),
      enquiry({ id: 'e2', booking_source_id: 'bs-2', source: '/booking/' }),
    ], [], [], current);
    expect(rows).toHaveLength(2);
  });

  it('labels a form from the registry when the registry can be read', () => {
    const rows = sourceBreakdown(
      [enquiry({ id: 'e1', booking_source_id: 'bs-1', source: '/booking/' })],
      [], [], current,
      [{ id: 'bs-1', display_label: 'Studio booking form' }],
    );
    expect(rows[0].label).toBe('Studio booking form');
  });

  it('falls back to the enquiry\'s own source when the registry is refused', () => {
    const rows = sourceBreakdown(
      [enquiry({ id: 'e1', booking_source_id: 'bs-1', source: 'kristinavishar.com/#booking' })],
      [], [], current,
      [],
    );
    expect(rows[0].label).toBe('kristinavishar.com/#booking');
  });

  it('reports conversions per source and sorts by volume', () => {
    const rows = sourceBreakdown([
      enquiry({ id: 'e1', booking_source_id: null, utm_source: 'instagram' }),
      enquiry({ id: 'e2', booking_source_id: null, utm_source: 'instagram' }),
      enquiry({ id: 'e3', booking_source_id: null, utm_source: 'google' }),
    ], [project({ id: 'p1', enquiry_id: 'e1' })], [], current);

    expect(rows[0].key).toBe('utm:instagram');
    expect(rows[0].enquiries).toBe(2);
    expect(rows[0].converted).toBe(1);
    expect(rows[0].rate).toBe(50);
    expect(rows[1].rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('funnel', () => {
  const { current } = periodEndingToday(30, NOW);

  it('counts distinct enquiries at every stage', () => {
    const result = funnel(
      [enquiry({ id: 'e1' }), enquiry({ id: 'e2' }), enquiry({ id: 'e3' }), enquiry({ id: 'e4' })],
      [project({ id: 'p1', enquiry_id: 'e1' }), project({ id: 'p2', enquiry_id: 'e1' }), project({ id: 'p3', enquiry_id: 'e2' })],
      [session({ id: 's1', enquiry_id: 'e1', project_id: 'p1' })],
      current,
    );
    expect(result.stages.map((stage) => stage.count)).toEqual([4, 2, 1]);
    expect(result.stages[1].rateFromPrevious).toBe(50);
    expect(result.stages[2].rateFromPrevious).toBe(50);
  });

  it('reports a legacy row with no link instead of counting it as a failure', () => {
    // A project created before the CRM recorded enquiry_id came from somewhere.
    // Folding it into the cohort as unconverted would understate every
    // historical period.
    const result = funnel(
      [enquiry({ id: 'e1' })],
      [project({ id: 'legacy', enquiry_id: null })],
      [session({ id: 'legacy-session', enquiry_id: null, project_id: null })],
      current,
    );
    expect(result.stages[0].count).toBe(1);
    expect(result.stages[1].count).toBe(0);
    expect(result.unlinkedProjects).toBe(1);
    expect(result.unlinkedSessions).toBe(1);
  });

  it('has no transition rates at all when nothing came in', () => {
    const result = funnel([], [], [], current);
    expect(result.stages.map((stage) => stage.rateFromPrevious)).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------------------

describe('time series', () => {
  it('picks a bucket size the period can actually show', () => {
    expect(granularityFor(7)).toBe('day');
    expect(granularityFor(30)).toBe('day');
    expect(granularityFor(90)).toBe('week');
    expect(granularityFor(365)).toBe('month');
  });

  it('emits every bucket in range, including the empty ones', () => {
    const { current } = periodEndingToday(7, NOW);
    const points = timeSeries([enquiry({ created_at: new Date(2026, 8, 1, 9, 0, 0).toISOString() })], [], current, 'day');
    expect(points).toHaveLength(7);
    expect(points[0].bucket).toBe('2026-08-30');
    expect(points.find((point) => point.bucket === '2026-09-01')!.enquiries).toBe(1);
    expect(points.filter((point) => point.enquiries === 0)).toHaveLength(6);
  });

  it('places sessions by when they start and excludes drafts', () => {
    const { current } = periodEndingToday(7, NOW);
    const points = timeSeries([], [
      session({ id: 's1', start_at: new Date(2026, 8, 3, 10, 0, 0).toISOString() }),
      session({ id: 's2', status: 'draft', start_at: new Date(2026, 8, 3, 14, 0, 0).toISOString() }),
    ], current, 'day');
    expect(points.find((point) => point.bucket === '2026-09-03')!.sessions).toBe(1);
  });

  it('starts a weekly bucket on Monday', () => {
    const { current } = periodEndingToday(90, NOW);
    const points = timeSeries([], [], current, 'week');
    expect(new Date(`${points[0].bucket}T00:00:00`).getDay()).toBe(1);
  });

  it('renders a local date without shifting it across a timezone boundary', () => {
    expect(localIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(localIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------

describe('finance', () => {
  const { current } = periodEndingToday(30, NOW);

  function transaction(overrides: Partial<StatisticsTransaction> = {}): StatisticsTransaction {
    return {
      id: 'txn-1',
      artist_id: ARTIST,
      transaction_type: 'payment',
      direction: 'credit',
      amount: 100,
      currency: 'GBP',
      status: 'succeeded',
      occurred_at: new Date(2026, 8, 2, 10, 0, 0).toISOString(),
      ...overrides,
    };
  }

  function paymentRequest(overrides: Partial<StatisticsPaymentRequest> = {}): StatisticsPaymentRequest {
    return {
      id: 'req-1',
      artist_id: ARTIST,
      purpose: 'deposit',
      amount: 50,
      currency: 'GBP',
      status: 'pending',
      created_at: new Date(2026, 8, 2, 10, 0, 0).toISOString(),
      ...overrides,
    };
  }

  it('never adds two currencies into one number', () => {
    const totals = financeTotals([
      transaction({ id: 't1', amount: 100, currency: 'GBP' }),
      transaction({ id: 't2', amount: 200, currency: 'EUR' }),
    ], [], [], [], current);

    expect(totals.received).toEqual([
      { currency: 'EUR', amount: 200, count: 1 },
      { currency: 'GBP', amount: 100, count: 1 },
    ]);
  });

  it('excludes a payment that did not go through', () => {
    const totals = financeTotals([
      transaction({ id: 't1', status: 'failed', amount: 500 }),
      transaction({ id: 't2', amount: 100 }),
    ], [], [], [], current);
    expect(totals.received[0].amount).toBe(100);
  });

  it('shows refunds apart instead of netting them off silently', () => {
    const totals = financeTotals([
      transaction({ id: 't1', amount: 100 }),
      transaction({ id: 't2', transaction_type: 'refund', direction: 'debit', amount: 40 }),
    ], [], [], [], current);
    expect(totals.received[0].amount).toBe(100);
    expect(totals.refunded[0].amount).toBe(40);
  });

  it('places a payment by when the money moved', () => {
    const totals = financeTotals([
      transaction({ id: 't1', occurred_at: new Date(2026, 3, 1).toISOString() }),
    ], [], [], [], current);
    expect(totals.received).toEqual([]);
  });

  it('reads a numeric that arrived as a string', () => {
    const totals = financeTotals([transaction({ amount: '125.50' })], [], [], [], current);
    expect(totals.received[0].amount).toBe(125.5);
  });

  it('keeps requested deposits, received money and quoted estimates separate', () => {
    const totals = financeTotals(
      [transaction({ id: 't1', amount: 100 })],
      [
        paymentRequest({ id: 'r1', amount: 50 }),
        paymentRequest({ id: 'r2', purpose: 'session_balance', amount: 900 }),
      ],
      [{ project_id: 'project-1', currency: 'GBP', estimate_total: 1200 }],
      [project({ id: 'project-1' })],
      current,
    );
    expect(totals.received[0].amount).toBe(100);
    expect(totals.depositsRequested[0].amount).toBe(50);
    expect(totals.estimatedProjectValue[0].amount).toBe(1200);
  });

  it('ignores an estimate for a project created outside the period', () => {
    const totals = financeTotals(
      [], [],
      [{ project_id: 'old', currency: 'GBP', estimate_total: 5000 }],
      [project({ id: 'old', created_at: new Date(2025, 0, 1).toISOString() })],
      current,
    );
    expect(totals.estimatedProjectValue).toEqual([]);
  });

  it('ignores a project with no estimate at all rather than counting it as zero', () => {
    const totals = financeTotals(
      [], [],
      [{ project_id: 'project-1', currency: 'GBP', estimate_total: null }],
      [project({ id: 'project-1' })],
      current,
    );
    expect(totals.estimatedProjectValue).toEqual([]);
  });

  it('returns four empty lists when there is nothing to report', () => {
    const totals = financeTotals([], [], [], [], current);
    expect(totals).toEqual({
      received: [],
      refunded: [],
      depositsRequested: [],
      estimatedProjectValue: [],
    });
  });
});

// ---------------------------------------------------------------------------

describe('insights', () => {
  const emptyTotals = sessionTotals([], periodEndingToday(30, NOW).current);
  const base = {
    enquiries: delta(0, 0),
    conversion: {
      current: { denominator: 0, converted: 0, rate: null },
      previous: { denominator: 0, converted: 0, rate: null },
    },
    sessions: { current: emptyTotals, previous: emptyTotals },
    weekday: [0, 0, 0, 0, 0, 0, 0],
    topSource: null,
    topSourceLabel: null,
  };

  it('says nothing at all when there is nothing to say', () => {
    expect(buildInsights(base)).toEqual([]);
  });

  it('states an enquiry trend only once both windows are big enough', () => {
    expect(buildInsights({ ...base, enquiries: delta(4, 2) })).toEqual([]);
    const [insight] = buildInsights({ ...base, enquiries: delta(12, 6) });
    expect(insight.id).toBe('insight.enquiriesUp');
    expect(insight.params.percent).toBe(100);
  });

  it('ignores a change too small to mean anything', () => {
    expect(buildInsights({ ...base, enquiries: delta(21, 20) })).toEqual([]);
  });

  it('names a busiest day only when one day genuinely leads', () => {
    expect(buildInsights({ ...base, weekday: [4, 4, 0, 0, 0, 0, 0] })).toEqual([]);
    const [insight] = buildInsights({ ...base, weekday: [2, 1, 1, 1, 5, 0, 0] });
    expect(insight.id).toBe('insight.busiestWeekday');
    expect(insight.params.weekday).toBe(4);
    expect(insight.params.count).toBe(5);
  });

  it('will not name a busiest day from a handful of bookings', () => {
    expect(buildInsights({ ...base, weekday: [3, 1, 0, 0, 0, 0, 0] })).toEqual([]);
  });

  it('names a leading source with its conversions', () => {
    const [insight] = buildInsights({
      ...base,
      topSource: { key: 'utm:instagram', kind: 'utm', value: 'instagram', label: null, enquiries: 14, converted: 8, rate: 57 },
      topSourceLabel: 'Instagram',
    });
    expect(insight).toEqual({
      id: 'insight.topSource',
      params: { source: 'Instagram', enquiries: 14, converted: 8 },
      tone: 'neutral',
    });
  });

  it('reports a rise in cancellations once both windows carry enough bookings', () => {
    const period = periodEndingToday(30, NOW).current;
    const previous = sessionTotals(
      Array.from({ length: 10 }, (_, index) => session({
        id: `p${index}`,
        status: index < 2 ? 'cancelled' : 'completed',
      })),
      period,
    );
    const current = sessionTotals(
      Array.from({ length: 10 }, (_, index) => session({
        id: `c${index}`,
        status: index < 5 ? 'cancelled' : 'completed',
      })),
      period,
    );
    const insights = buildInsights({ ...base, sessions: { current, previous } });
    expect(insights).toContainEqual({
      id: 'insight.cancellationsUp',
      params: { from: 2, to: 5 },
      tone: 'bad',
    });
  });

  it('is deterministic: the same aggregates give the same sentences in the same order', () => {
    const input = {
      ...base,
      enquiries: delta(20, 10),
      weekday: [1, 1, 1, 1, 9, 0, 0],
      topSource: { key: 'utm:instagram', kind: 'utm' as const, value: 'instagram', label: null, enquiries: 14, converted: 8, rate: 57 },
      topSourceLabel: 'Instagram',
    };
    expect(buildInsights(input)).toEqual(buildInsights(input));
    expect(buildInsights(input).map((insight) => insight.id)).toEqual([
      'insight.enquiriesUp',
      'insight.busiestWeekday',
      'insight.topSource',
    ]);
  });
});
