// The Statistics screen's arithmetic, tested without a database or a browser.
//
// Every metric on that screen is a claim about the studio's own records, so
// what is pinned here is the definition rather than the rendering: which rows
// are in scope, which timestamp decides the period, and what a rate divides by.
// A number that cannot survive these cases has no business being shown.

import { describe, expect, it } from 'vitest';
import {
  bookingsMade,
  buildInsights,
  channelBreakdown,
  channelFor,
  consultedEnquiryIds,
  conversionMaturity,
  convertedEnquiryIds,
  delta,
  enquiryConversion,
  financeTotals,
  funnel,
  granularityFor,
  isOpenRequest,
  localIsoDate,
  periodEndingToday,
  periodForDates,
  periodForPreset,
  previousPeriodComparable,
  rateDelta,
  repeatClients,
  sessionHours,
  sessionTotals,
  sessionsByWeekday,
  timeSeries,
  upcomingLoad,
  within,
  type ChannelRow,
  type InsightInput,
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
    const sessions = [
      session({ id: 's1', enquiry_id: null, project_id: 'p1' }),
      session({ id: 's2', enquiry_id: 'e2', project_id: null }),
    ];

    const result = enquiryConversion(enquiries, projects, sessions, current);
    expect(result.denominator).toBe(4);
    expect(result.converted).toBe(2);
    expect(result.rate).toBe(50);
  });

  // Audit 2026-10-15, P0-1: in production every "conversion" of the latest
  // 30-day cohort was a consultation, and one was a cancelled consultation.
  it('does not count a consultation as a conversion, however it went', () => {
    const sessions = [
      session({ id: 's1', enquiry_id: 'e1', project_id: null, appointment_type: 'in_person_consultation', status: 'confirmed' }),
      session({ id: 's2', enquiry_id: 'e2', project_id: null, appointment_type: 'video_consultation', status: 'completed' }),
      session({ id: 's3', enquiry_id: 'e3', project_id: null, appointment_type: 'in_person_consultation', status: 'cancelled' }),
    ];
    expect(convertedEnquiryIds([], sessions).size).toBe(0);
    expect(consultedEnquiryIds([], sessions)).toEqual(new Set(['e1', 'e2']));
  });

  it('counts a touch-up as tattoo work', () => {
    const sessions = [session({ id: 's1', enquiry_id: 'e1', appointment_type: 'touch_up', status: 'confirmed' })];
    expect(convertedEnquiryIds([], sessions).has('e1')).toBe(true);
  });

  it('does not count a cancelled tattoo booking as a conversion', () => {
    const sessions = [session({ id: 's1', enquiry_id: 'e1', status: 'cancelled' })];
    expect(convertedEnquiryIds([], sessions).size).toBe(0);
  });

  it('still counts a no-show: the booking was made and held', () => {
    const sessions = [session({ id: 's1', enquiry_id: 'e1', status: 'no_show' })];
    expect(convertedEnquiryIds([], sessions).has('e1')).toBe(true);
  });

  it('does not count a project with no tattoo session as a conversion', () => {
    // Since 2026-09-07 a project is created by booking the first tattoo
    // session; a project alone is a manual draft or a cancelled booking.
    expect(convertedEnquiryIds([project({ id: 'p1', enquiry_id: 'e1' })], []).size).toBe(0);
  });

  it('counts an enquiry once however many tattoo sessions it produced', () => {
    const enquiries = [enquiry({ id: 'e1' })];
    const sessions = [
      session({ id: 's1', enquiry_id: 'e1' }),
      session({ id: 's2', enquiry_id: 'e1' }),
    ];
    const result = enquiryConversion(enquiries, [], sessions, current);
    expect(result.converted).toBe(1);
    expect(result.rate).toBe(100);
  });

  it('counts a conversion that happened after the period closed', () => {
    const enquiries = [enquiry({ id: 'e1' })];
    const sessions = [session({
      id: 's1',
      enquiry_id: 'e1',
      status: 'confirmed',
      start_at: new Date(2027, 0, 1, 10).toISOString(),
      end_at: new Date(2027, 0, 1, 16).toISOString(),
    })];
    expect(enquiryConversion(enquiries, [], sessions, current).converted).toBe(1);
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

  // Audit 2026-10-15, P0-4: a young cohort was compared with a mature one.
  it('judges only enquiries old enough to have booked, and reports the rest as pending', () => {
    const enquiries = [
      enquiry({ id: 'old-booked', created_at: new Date(2026, 7, 10).toISOString() }),
      enquiry({ id: 'old-lost', created_at: new Date(2026, 7, 12).toISOString() }),
      enquiry({ id: 'young-booked', created_at: new Date(2026, 8, 3).toISOString() }),
      enquiry({ id: 'young-open', created_at: new Date(2026, 8, 4).toISOString() }),
    ];
    const sessions = [
      session({ id: 's1', enquiry_id: 'old-booked' }),
      session({ id: 's2', enquiry_id: 'young-booked', status: 'confirmed' }),
    ];
    const result = enquiryConversion(enquiries, [], sessions, current, { now: NOW, days: 14 });
    expect(result.cohort).toBe(4);
    expect(result.denominator).toBe(2);
    expect(result.converted).toBe(1);
    expect(result.rate).toBe(50);
    expect(result.pending).toBe(2);
    expect(result.pendingConverted).toBe(1);
  });

  it('has no rate while every enquiry is still too young', () => {
    const result = enquiryConversion([enquiry({ id: 'e1' })], [], [], current, { now: NOW, days: 14 });
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.pending).toBe(1);
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

describe('period comparison', () => {
  // Audit 2026-10-15, P0-5: "+N pts, was 0" against an empty cohort.
  it('states no change in a rate when either side has no rate', () => {
    expect(rateDelta(40, null)).toBeNull();
    expect(rateDelta(null, 40)).toBeNull();
    expect(rateDelta(null, null)).toBeNull();
    expect(rateDelta(40, 25)?.difference).toBe(15);
  });

  it('compares only with a previous window the CRM holds complete history for', () => {
    const pair = periodEndingToday(30, NOW);
    const longBefore = new Date(2026, 0, 1).toISOString();
    const insidePrevious = new Date(2026, 7, 20).toISOString();
    expect(previousPeriodComparable(pair, longBefore)).toBe(true);
    expect(previousPeriodComparable(pair, insidePrevious)).toBe(false);
    expect(previousPeriodComparable(pair, null)).toBe(false);
    expect(previousPeriodComparable(pair, 'nonsense')).toBe(false);
  });

  it('treats a 12-month window as incomparable while the CRM is younger than two years', () => {
    const pair = periodForPreset('12m', NOW);
    expect(previousPeriodComparable(pair, new Date(2026, 7, 15).toISOString())).toBe(false);
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

describe('tattoo work and consultations', () => {
  const { current } = periodEndingToday(30, NOW);

  it('never counts a consultation as a session worked, an hour or a cancellation', () => {
    const totals = sessionTotals([
      session({ id: 's1', status: 'completed', duration_hours: 6 }),
      session({ id: 's2', appointment_type: 'in_person_consultation', status: 'completed', duration_hours: 0.5 }),
      session({ id: 's3', appointment_type: 'in_person_consultation', status: 'confirmed', duration_hours: 0.5 }),
      session({ id: 's4', appointment_type: 'video_consultation', status: 'cancelled', duration_hours: 0.5 }),
    ], current);
    expect(totals.completed).toBe(1);
    expect(totals.hours).toBe(6);
    expect(totals.booked).toBe(1);
    expect(totals.cancellationRate).toBe(0);
    expect(totals.consultations).toEqual({ held: 2, cancelled: 1 });
  });

  it('counts bookings by the day they were made, not the day they are for', () => {
    const made = bookingsMade([
      session({ id: 's1', status: 'confirmed', created_at: new Date(2026, 8, 2).toISOString(), start_at: new Date(2027, 2, 1, 10).toISOString(), end_at: new Date(2027, 2, 1, 16).toISOString() }),
      session({ id: 's2', status: 'cancelled', created_at: new Date(2026, 8, 3).toISOString() }),
      session({ id: 's3', appointment_type: 'in_person_consultation', status: 'confirmed', created_at: new Date(2026, 8, 3).toISOString() }),
      session({ id: 's4', status: 'confirmed', created_at: new Date(2026, 5, 1).toISOString() }),
      session({ id: 's5', status: 'draft', created_at: new Date(2026, 8, 3).toISOString() }),
      session({ id: 's6', status: 'confirmed', created_at: null }),
    ], current);
    expect(made).toEqual({ tattoo: 2, tattooCancelled: 1, consultations: 1 });
  });

  it('keeps consultations ahead out of the tattoo hours ahead', () => {
    const load = upcomingLoad([
      session({ id: 's1', status: 'confirmed', start_at: new Date(2026, 8, 20, 10).toISOString(), duration_hours: 6 }),
      session({ id: 's2', appointment_type: 'in_person_consultation', status: 'confirmed', start_at: new Date(2026, 8, 21, 10).toISOString(), duration_hours: 0.5 }),
    ], NOW, 30);
    expect(load).toMatchObject({ sessions: 1, hours: 6, consultations: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('repeat clients', () => {
  const { current } = periodEndingToday(30, NOW);

  it('counts a client who came back for a second piece', () => {
    const history = [
      session({ id: 's1', project_id: 'p-old', start_at: new Date(2025, 5, 1, 10).toISOString(), end_at: new Date(2025, 5, 1, 15).toISOString() }),
      session({ id: 's2', project_id: 'p-new' }),
    ];
    expect(repeatClients(history, current)).toEqual({ active: 1, repeat: 1, rate: 100 });
  });

  // Audit 2026-10-15, P0-2: 7 of 13 production clients would have been called
  // "repeat" for having several sessions of one piece.
  it('does not call several sessions of one project a return', () => {
    const history = [
      session({ id: 's1', project_id: 'p1', start_at: new Date(2026, 7, 1, 10).toISOString(), end_at: new Date(2026, 7, 1, 16).toISOString() }),
      session({ id: 's2', project_id: 'p1' }),
      session({ id: 's3', project_id: 'p1', status: 'confirmed', start_at: new Date(2026, 9, 1, 10).toISOString(), end_at: new Date(2026, 9, 1, 16).toISOString() }),
    ];
    expect(repeatClients(history, current)).toEqual({ active: 1, repeat: 0, rate: 0 });
  });

  it('does not let a consultation make a client active or a return', () => {
    const history = [
      session({ id: 's1', project_id: null, appointment_type: 'in_person_consultation', status: 'completed' }),
      session({ id: 's2', project_id: 'p1', status: 'completed', start_at: new Date(2025, 1, 1, 10).toISOString(), end_at: new Date(2025, 1, 1, 15).toISOString() }),
    ];
    expect(repeatClients(history, current)).toEqual({ active: 0, repeat: 0, rate: null });
  });

  it('does not merge two artists into one relationship', () => {
    const history = [
      session({ id: 's1', artist_id: ARTIST, project_id: 'p1' }),
      session({ id: 's2', artist_id: OTHER_ARTIST, project_id: 'p2' }),
    ];
    expect(repeatClients(history, current)).toEqual({ active: 2, repeat: 0, rate: 0 });
  });

  it('ignores a cancelled project on both sides of the count', () => {
    const history = [
      session({ id: 's1', project_id: 'p-old', status: 'cancelled', start_at: new Date(2025, 5, 1, 10).toISOString(), end_at: new Date(2025, 5, 1, 15).toISOString() }),
      session({ id: 's2', project_id: 'p-new' }),
    ];
    expect(repeatClients(history, current).repeat).toBe(0);
  });

  it('never adds a project for a legacy session that has none', () => {
    const history = [
      session({ id: 's1', project_id: null, start_at: new Date(2025, 5, 1, 10).toISOString(), end_at: new Date(2025, 5, 1, 15).toISOString() }),
      session({ id: 's2', project_id: 'p1' }),
    ];
    expect(repeatClients(history, current).repeat).toBe(0);
  });

  it('identifies clients by id, never by a matching name or address', () => {
    const history = [
      session({ id: 's1', client_id: 'c-a', project_id: 'p1' }),
      session({ id: 's2', client_id: 'c-b', project_id: 'p2' }),
    ];
    expect(repeatClients(history, current)).toEqual({ active: 2, repeat: 0, rate: 0 });
  });

  it('has no rate when nobody was seen', () => {
    expect(repeatClients([], current).rate).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('channels', () => {
  const { current } = periodEndingToday(30, NOW);
  const WEBSITE_FORM = 'b1111111-1111-4111-8111-111111111111';

  // Audit 2026-10-15, P0-7: every website enquiry carries a booking form id,
  // and ranking it first hid 20 paid enquiries behind one "website" row.
  it('reads a paid campaign tag through the booking form id', () => {
    const fb = channelFor(enquiry({ booking_source_id: WEBSITE_FORM, utm_source: 'fb', utm_medium: 'paid', referrer_host: 'facebook.com' }));
    const ig = channelFor(enquiry({ booking_source_id: WEBSITE_FORM, utm_source: 'ig', utm_medium: 'paid', referrer_host: 'instagram.com' }));
    expect(fb).toEqual({ key: 'paid:meta', kind: 'paid', value: 'meta' });
    expect(ig).toEqual(fb);
    expect(channelFor(enquiry({ utm_source: 'google', utm_medium: 'cpc' })).key).toBe('paid:google');
    expect(channelFor(enquiry({ utm_source: null, utm_medium: 'PAID' })).key).toBe('paid:other');
  });

  it('keeps a non-paid campaign tag apart from paid traffic', () => {
    expect(channelFor(enquiry({ utm_source: 'ig', utm_medium: 'social' }))).toEqual({ key: 'campaign:instagram', kind: 'campaign', value: 'instagram' });
  });

  it('classifies the referrer host when there is no campaign tag', () => {
    const cases: Array<[string, string]> = [
      ['l.instagram.com', 'social:instagram'],
      ['www.instagram.com', 'social:instagram'],
      ['m.facebook.com', 'social:facebook'],
      ['www.google.co.uk', 'search:google'],
      ['chatgpt.com', 'ai:chatgpt'],
      ['www.perplexity.ai', 'ai:perplexity'],
      ['www.tattoodo.com', 'referral:tattoodo.com'],
    ];
    for (const [host, key] of cases) {
      expect(channelFor(enquiry({ referrer_host: host })).key).toBe(key);
    }
  });

  it('does not invent an origin for a visitor who came from the studio\'s own site', () => {
    expect(channelFor(enquiry({ referrer_host: 'vishartattoo.com' })).kind).toBe('internal');
    expect(channelFor(enquiry({ referrer_host: 'www.kristinavishar.com' })).kind).toBe('internal');
    expect(channelFor(enquiry({ referrer_host: 'booking.vishartattoo.com' })).kind).toBe('internal');
  });

  it('calls an enquiry with no signal direct-or-unknown, never organic', () => {
    expect(channelFor(enquiry({ source: '/booking/' }))).toEqual({ key: 'direct', kind: 'direct', value: null });
  });

  it('keeps manual entries and conversation-opened enquiries as their own channels', () => {
    expect(channelFor(enquiry({ source: 'crm_manual' })).kind).toBe('manual');
    expect(channelFor(enquiry({ communication_channel: 'whatsapp', utm_medium: 'paid' })).key).toBe('conversation:whatsapp');
  });

  it('reports enquiries, consultations and tattoo bookings per channel', () => {
    const enquiries = [
      enquiry({ id: 'e1', utm_source: 'fb', utm_medium: 'paid', created_at: new Date(2026, 7, 10).toISOString() }),
      enquiry({ id: 'e2', utm_source: 'ig', utm_medium: 'paid', created_at: new Date(2026, 7, 11).toISOString() }),
      enquiry({ id: 'e3', referrer_host: 'instagram.com' }),
      enquiry({ id: 'e4', source: 'crm_manual', created_at: new Date(2026, 7, 12).toISOString() }),
    ];
    const sessions = [
      session({ id: 's1', enquiry_id: 'e2', project_id: null, appointment_type: 'in_person_consultation', status: 'confirmed' }),
      session({ id: 's2', enquiry_id: 'e4', project_id: null }),
    ];
    const rows = channelBreakdown(enquiries, [], sessions, current, { now: NOW, days: 14 });
    const meta = rows.find((row) => row.key === 'paid:meta');
    expect(meta).toMatchObject({ enquiries: 2, consulted: 1, booked: 0, matured: 2, maturedBooked: 0 });
    expect(rows.find((row) => row.key === 'manual')).toMatchObject({ enquiries: 1, booked: 1 });
    expect(rows.find((row) => row.key === 'social:instagram')).toMatchObject({ enquiries: 1, matured: 0 });
    expect(rows[0].key).toBe('paid:meta');
  });
});

// ---------------------------------------------------------------------------

describe('funnel', () => {
  const { current } = periodEndingToday(30, NOW);

  it('counts distinct enquiries at every stage, against the enquiries', () => {
    const enquiries = [enquiry({ id: 'e1' }), enquiry({ id: 'e2' }), enquiry({ id: 'e3' }), enquiry({ id: 'e4' })];
    const sessions = [
      session({ id: 'c1', enquiry_id: 'e1', project_id: null, appointment_type: 'in_person_consultation', status: 'completed' }),
      session({ id: 's1', enquiry_id: 'e1', status: 'confirmed' }),
      session({ id: 's2', enquiry_id: 'e2', status: 'completed' }),
      session({ id: 's3', enquiry_id: 'e2', status: 'completed' }),
    ];
    const result = funnel(enquiries, [], sessions, current);
    expect(result.stages.map((stage) => [stage.id, stage.count, stage.shareOfEnquiries])).toEqual([
      ['enquiries', 4, null],
      ['consultations', 1, 25],
      ['booked', 2, 50],
      ['completed', 1, 25],
    ]);
  });

  it('never reaches a booking through a consultation', () => {
    const sessions = [session({ id: 'c1', enquiry_id: 'e1', project_id: null, appointment_type: 'video_consultation', status: 'confirmed' })];
    const result = funnel([enquiry({ id: 'e1' })], [], sessions, current);
    expect(result.stages.find((stage) => stage.id === 'booked')?.count).toBe(0);
    expect(result.stages.find((stage) => stage.id === 'consultations')?.count).toBe(1);
  });

  it('reports tattoo work with no link instead of counting it as a failure', () => {
    const projects = [project({ id: 'p-legacy', enquiry_id: null })];
    const sessions = [
      session({ id: 's1', enquiry_id: null, project_id: null }),
      session({ id: 's2', enquiry_id: null, project_id: null, appointment_type: 'in_person_consultation' }),
    ];
    const result = funnel([], projects, sessions, current);
    expect(result.unlinkedProjects).toBe(1);
    expect(result.unlinkedSessions).toBe(1);
  });

  it('has no shares at all when nothing came in', () => {
    const result = funnel([], [], [], current);
    expect(result.stages.every((stage) => stage.shareOfEnquiries === null)).toBe(true);
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
      amount: 250,
      currency: 'GBP',
      status: 'pending',
      created_at: new Date(2026, 8, 2, 10, 0, 0).toISOString(),
      expires_at: null,
      ...overrides,
    };
  }

  it('never adds two currencies into one number', () => {
    const totals = financeTotals([
      transaction({ id: 't1', amount: 100, currency: 'GBP' }),
      transaction({ id: 't2', amount: 200, currency: 'EUR' }),
    ], [], current, NOW);
    expect(totals.received).toEqual([
      { currency: 'EUR', amount: 200, count: 1 },
      { currency: 'GBP', amount: 100, count: 1 },
    ]);
  });

  it('excludes a payment that did not go through', () => {
    const totals = financeTotals([transaction({ status: 'failed' })], [], current, NOW);
    expect(totals.received).toEqual([]);
  });

  it('shows refunds apart instead of netting them off silently', () => {
    const totals = financeTotals([
      transaction({ id: 't1', amount: 300 }),
      transaction({ id: 't2', amount: 100, direction: 'debit', transaction_type: 'refund' }),
    ], [], current, NOW);
    expect(totals.received[0].amount).toBe(300);
    expect(totals.refunded[0].amount).toBe(100);
  });

  it('places a payment by when the money moved', () => {
    const totals = financeTotals([transaction({ occurred_at: new Date(2026, 5, 1).toISOString() })], [], current, NOW);
    expect(totals.received).toEqual([]);
  });

  it('reads a numeric that arrived as a string', () => {
    expect(financeTotals([transaction({ amount: '1250.50' })], [], current, NOW).received[0].amount).toBe(1250.5);
  });

  // Audit 2026-10-15, P0-3: four cancelled £250 requests, re-issued and paid
  // as other requests, were summed with the paid ones: £2,250 for £1,250.
  it('never counts a cancelled, paid or expired request as money still owed', () => {
    const totals = financeTotals([], [
      paymentRequest({ id: 'r1', status: 'cancelled' }),
      paymentRequest({ id: 'r2', status: 'paid' }),
      paymentRequest({ id: 'r3', status: 'expired' }),
      paymentRequest({ id: 'r4', status: 'pending', expires_at: new Date(2026, 8, 1).toISOString() }),
      paymentRequest({ id: 'r5', status: 'pending', expires_at: new Date(2026, 8, 20).toISOString() }),
      paymentRequest({ id: 'r6', status: 'pending' }),
    ], current, NOW);
    expect(totals.open).toEqual([{ currency: 'GBP', amount: 500, count: 2 }]);
  });

  it('counts part-paid requests without inventing their remainder', () => {
    const totals = financeTotals([], [paymentRequest({ status: 'partially_paid' })], current, NOW);
    expect(totals.open).toEqual([]);
    expect(totals.partiallyPaid).toBe(1);
  });

  it('does not add requested money to money received', () => {
    const totals = financeTotals([transaction({ amount: 250 })], [paymentRequest({ status: 'paid', amount: 250 })], current, NOW);
    expect(totals.received[0].amount).toBe(250);
    expect(totals.open).toEqual([]);
    expect(totals).not.toHaveProperty('depositsRequested');
    expect(totals).not.toHaveProperty('estimatedProjectValue');
  });

  it('decides openness on the request itself', () => {
    expect(isOpenRequest(paymentRequest(), NOW)).toBe(true);
    expect(isOpenRequest(paymentRequest({ expires_at: 'not a date' }), NOW)).toBe(true);
    expect(isOpenRequest(paymentRequest({ expires_at: NOW.toISOString() }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('insights', () => {
  const emptyTotals = sessionTotals([], periodEndingToday(30, NOW).current);
  const noConversion = { denominator: 0, converted: 0, rate: null, cohort: 0, pending: 0, pendingConverted: 0 };
  const base: InsightInput = {
    comparable: true,
    enquiries: delta(0, 0),
    conversion: { current: noConversion, previous: noConversion },
    sessions: { current: emptyTotals, previous: emptyTotals },
    channels: [],
    channelLabel: (row) => row.key,
  };
  const row = (overrides: Partial<ChannelRow>): ChannelRow => ({
    key: 'paid:meta', kind: 'paid', value: 'meta',
    enquiries: 0, consulted: 0, booked: 0, matured: 0, maturedBooked: 0,
    ...overrides,
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(buildInsights(base)).toEqual([]);
  });

  it('states an enquiry trend only once both windows are big enough', () => {
    expect(buildInsights({ ...base, enquiries: delta(4, 2) })).toEqual([]);
    expect(buildInsights({ ...base, enquiries: delta(12, 6) })[0].id).toBe('insight.enquiriesUp');
  });

  it('ignores a change too small to mean anything', () => {
    expect(buildInsights({ ...base, enquiries: delta(21, 20) })).toEqual([]);
  });

  it('states no trend at all against a window the CRM has no history for', () => {
    const input = {
      ...base,
      comparable: false,
      enquiries: delta(53, 22),
      conversion: {
        current: { ...noConversion, denominator: 20, converted: 0, rate: 0 },
        previous: { ...noConversion, denominator: 20, converted: 8, rate: 40 },
      },
    };
    expect(buildInsights(input)).toEqual([]);
  });

  // Audit 2026-10-15, P0-4.
  it('compares conversion only over enquiries old enough to judge', () => {
    const young = {
      current: { ...noConversion, denominator: 3, converted: 0, rate: 0, cohort: 53, pending: 50 },
      previous: { ...noConversion, denominator: 22, converted: 6, rate: 27.3, cohort: 22 },
    };
    expect(buildInsights({ ...base, conversion: young })).toEqual([]);

    const mature = {
      current: { ...noConversion, denominator: 26, converted: 0, rate: 0, cohort: 53, pending: 27 },
      previous: young.previous,
    };
    expect(buildInsights({ ...base, conversion: mature })).toEqual([{
      id: 'insight.conversionDown',
      params: { from: 27, to: 0, mature: 26, pending: 27 },
      tone: 'bad',
    }]);
  });

  it('names a channel whose judged enquiries have booked nothing, first', () => {
    const input = {
      ...base,
      enquiries: delta(12, 6),
      channels: [
        row({ matured: 13, maturedBooked: 0 }),
        row({ key: 'social:instagram', kind: 'social', value: 'instagram', matured: 4 }),
        row({ key: 'direct', kind: 'direct', value: null, matured: 20 }),
        row({ key: 'manual', kind: 'manual', value: null, matured: 10 }),
      ],
    };
    const insights = buildInsights(input);
    expect(insights[0]).toEqual({
      id: 'insight.channelNoBookings',
      params: { channel: 'paid:meta', enquiries: 13 },
      tone: 'bad',
    });
    expect(insights.filter((insight) => insight.id === 'insight.channelNoBookings')).toHaveLength(1);
  });

  it('says nothing about a channel once it has booked', () => {
    expect(buildInsights({ ...base, channels: [row({ matured: 13, maturedBooked: 1 })] })).toEqual([]);
  });

  it('reports a rise in tattoo cancellations once both windows carry enough bookings', () => {
    const now = { ...emptyTotals, booked: 10, cancelled: 3 };
    const before = { ...emptyTotals, booked: 10, cancelled: 1 };
    expect(buildInsights({ ...base, sessions: { current: now, previous: before } })[0].id).toBe('insight.cancellationsUp');
    expect(buildInsights({ ...base, sessions: { current: { ...now, booked: 4 }, previous: before } })).toEqual([]);
  });

  it('is deterministic: the same aggregates give the same sentences in the same order', () => {
    const input = {
      ...base,
      enquiries: delta(12, 6),
      channels: [row({ matured: 9 })],
    };
    expect(buildInsights(input)).toEqual(buildInsights(input));
    expect(buildInsights(input).map((insight) => insight.id)).toEqual([
      'insight.channelNoBookings',
      'insight.enquiriesUp',
    ]);
  });
});
