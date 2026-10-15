// Statistics: every number this CRM is willing to state, and its formula.
//
// READ THIS BEFORE ADDING A METRIC.
//
// This module is pure. It takes rows the database already handed back - which
// means rows row level security already decided the viewer may see - and turns
// them into counts. It performs no I/O, so every formula below is exercised
// directly by `src/test/statistics.test.ts` rather than through a rendered
// screen.
//
// Two rules govern what may live here.
//
// 1. A metric needs one unambiguous definition: which rows are in scope, which
//    single timestamp decides period membership, and - for a rate - what the
//    denominator is. A number nobody can define is not shown at all. Where the
//    data cannot answer honestly the answer is an absolute count, never an
//    invented percentage.
// 2. Nothing here filters by artist. Artist scope is a database boundary, and
//    re-implementing it in the browser would create a second, weaker copy of
//    it. The reader hands in the rows it was given; if that set is wrong, the
//    defect is in RLS, not in arithmetic.

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
//
// Narrow on purpose. These are the columns the statistics reader asks for, not
// the CRM's full record types: a screen that only counts has no business
// holding a client's phone number.

export type StatisticsEnquiryStatus = string;

export interface StatisticsEnquiry {
  id: string;
  artist_id: string;
  client_id: string;
  status: StatisticsEnquiryStatus;
  source: string | null;
  booking_source_id: string | null;
  communication_channel: string | null;
  utm_source: string | null;
  /** Campaign medium (`paid`, `social`, ...). Absent on rows read before the
   *  projection carried it, which classifies exactly like null. */
  utm_medium?: string | null;
  utm_campaign?: string | null;
  /** Host of the referrer only, lower case. Never the full URL. */
  referrer_host?: string | null;
  created_at: string;
}

export interface StatisticsProject {
  id: string;
  artist_id: string;
  client_id: string;
  enquiry_id: string | null;
  status: string;
  created_at: string;
}

export interface StatisticsSession {
  id: string;
  artist_id: string;
  client_id: string;
  project_id: string | null;
  enquiry_id: string | null;
  status: string;
  appointment_type: string;
  start_at: string;
  end_at: string;
  duration_hours: number | null;
  cancelled_at: string | null;
  /** When the booking was made. Decides "booked in the period". */
  created_at?: string | null;
}

/** A `payment_transactions` row. Only ever present when the database returned
 *  one, which it does exclusively for a viewer holding finance access. */
export interface StatisticsTransaction {
  id: string;
  artist_id: string;
  transaction_type: string;
  direction: string;
  amount: number | string;
  currency: string;
  status: string;
  occurred_at: string;
}

/** A `payment_requests` row. Same finance boundary as above. */
export interface StatisticsPaymentRequest {
  id: string;
  artist_id: string;
  purpose: string;
  amount: number | string;
  currency: string;
  status: string;
  created_at: string;
  expires_at?: string | null;
}

// ---------------------------------------------------------------------------
// Status and appointment vocabularies
// ---------------------------------------------------------------------------
//
// Mirrored from the production enums (`session_status`, `appointment_type`).
// A value outside these sets is counted as "some other status" rather than
// silently folded into the nearest one.

/** A booking that happened. Tattoo work is set to completed automatically
 *  once its end time has passed (crm_private.auto_complete_due_tattoo_sessions)
 *  unless the artist marked it cancelled or a no-show first. */
export const COMPLETED_SESSION_STATUSES = new Set(['completed']);
/** A booking that is meant to happen. */
export const PLANNED_SESSION_STATUSES = new Set(['proposed', 'confirmed']);
/** A booking that will not happen. `no_show` is kept apart from `cancelled`:
 *  the client not arriving is not the same event as the booking being called
 *  off, and merging them would make the cancellation rate unreadable. */
export const CANCELLED_SESSION_STATUSES = new Set(['cancelled']);
export const NO_SHOW_SESSION_STATUSES = new Set(['no_show']);
/** Never counted anywhere. A draft is a half-written row, not a booking. */
export const DRAFT_SESSION_STATUSES = new Set(['draft']);

/**
 * Tattoo work: the appointments a project exists for. A touch-up belongs to
 * the tattoo it touches up. Everything a studio sells is in here.
 */
export const TATTOO_APPOINTMENT_TYPES = new Set(['tattoo_session', 'touch_up']);
/**
 * A conversation about the work, not the work. The database states the same
 * rule: booking a consultation "must not convert an enquiry into tattoo work"
 * (20260907070000_enquiry_auto_project_booking.sql). A consultation is
 * therefore never a conversion, never a repeat visit and never worked hours.
 */
export const CONSULTATION_APPOINTMENT_TYPES = new Set(['in_person_consultation', 'video_consultation']);

export function isTattooWork(session: StatisticsSession): boolean {
  return TATTOO_APPOINTMENT_TYPES.has(session.appointment_type);
}

export function isConsultation(session: StatisticsSession): boolean {
  return CONSULTATION_APPOINTMENT_TYPES.has(session.appointment_type);
}

/** Every session status that represents a real booking, whatever became of it.
 *  This is the denominator of the cancellation rate. */
export function isBookedSession(session: StatisticsSession): boolean {
  return !DRAFT_SESSION_STATUSES.has(session.status);
}

/**
 * A booking that stands: made, and not called off. A no-show still stands -
 * the client was booked and the slot was held for them.
 */
export function isHeldBooking(session: StatisticsSession): boolean {
  return isBookedSession(session) && !CANCELLED_SESSION_STATUSES.has(session.status);
}

/** A session that counts as work having been agreed: it happened, or it is
 *  still meant to. Used for repeat clients and the weekday pattern, where a
 *  cancelled booking would say the artist worked when they did not. */
export function isLiveSession(session: StatisticsSession): boolean {
  return COMPLETED_SESSION_STATUSES.has(session.status)
    || PLANNED_SESSION_STATUSES.has(session.status);
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

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

/**
 * Whether the previous window can be compared with the current one at all.
 *
 * A comparison against a window the CRM holds no history for is not a
 * comparison: "+53 enquiries, was 0" for a 12-month period would claim growth
 * from nothing when the records simply did not exist yet. `historyStart` is
 * the earliest enquiry the viewer may see. When the previous window opens
 * before it, the previous figures are partial and no change is stated.
 */
export function previousPeriodComparable(period: PeriodPair, historyStart: string | null): boolean {
  if (!historyStart) return false;
  const start = Date.parse(historyStart);
  if (Number.isNaN(start)) return false;
  return start <= Date.parse(period.previous.from);
}

// ---------------------------------------------------------------------------
// Enquiries and conversion
// ---------------------------------------------------------------------------

/** Days an enquiry is given before its outcome is counted. */
export const CONVERSION_MATURITY_DAYS = 14;

export interface ConversionResult {
  /** Enquiries created in the period that are old enough to be judged. The
   *  denominator. Equal to `cohort` when no maturity rule is applied. */
  denominator: number;
  /** Of those, the ones that led to a tattoo booking that stands. */
  converted: number;
  /** null when the denominator is 0. A rate over nothing is not 0%. */
  rate: number | null;
  /** Every enquiry created in the period, mature or not. */
  cohort: number;
  /** Enquiries still too young to be judged, and how many of them have
   *  already booked. Shown, never folded into the rate. */
  pending: number;
  pendingConverted: number;
}

export interface MaturityRule {
  now: Date;
  days: number;
}

function enquiryOfProjectMap(projects: StatisticsProject[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of projects) {
    if (project.enquiry_id) map.set(project.id, project.enquiry_id);
  }
  return map;
}

function enquiryOfSession(session: StatisticsSession, enquiryOfProject: Map<string, string>): string | null {
  if (session.enquiry_id) return session.enquiry_id;
  return session.project_id ? enquiryOfProject.get(session.project_id) ?? null : null;
}

/**
 * Every enquiry id that led to tattoo work which stands.
 *
 * Converted means: at least one tattoo session or touch-up, reached through
 * `sessions.enquiry_id` or through the session's project, that is neither a
 * draft nor cancelled. A no-show still counts - the booking was made and kept
 * open for the client.
 *
 * Deliberately not conversions:
 * - a consultation, however it went (see CONSULTATION_APPOINTMENT_TYPES);
 * - a project on its own. Since 2026-09-07 a project is created by booking the
 *   first tattoo session, so a project with no tattoo session is either a
 *   manual draft or one whose booking was cancelled;
 * - a tattoo booking that was cancelled.
 */
export function convertedEnquiryIds(
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
): Set<string> {
  const enquiryOfProject = enquiryOfProjectMap(projects);
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!isTattooWork(session) || !isHeldBooking(session)) continue;
    const enquiryId = enquiryOfSession(session, enquiryOfProject);
    if (enquiryId) ids.add(enquiryId);
  }
  return ids;
}

/** Every enquiry id that had a consultation which was not called off. */
export function consultedEnquiryIds(
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
): Set<string> {
  const enquiryOfProject = enquiryOfProjectMap(projects);
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!isConsultation(session) || !isHeldBooking(session)) continue;
    const enquiryId = enquiryOfSession(session, enquiryOfProject);
    if (enquiryId) ids.add(enquiryId);
  }
  return ids;
}

/** Every enquiry id whose tattoo work has actually taken place. */
export function tattooCompletedEnquiryIds(
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
): Set<string> {
  const enquiryOfProject = enquiryOfProjectMap(projects);
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!isTattooWork(session) || !COMPLETED_SESSION_STATUSES.has(session.status)) continue;
    const enquiryId = enquiryOfSession(session, enquiryOfProject);
    if (enquiryId) ids.add(enquiryId);
  }
  return ids;
}

function isMature(enquiry: StatisticsEnquiry, maturity: MaturityRule | undefined): boolean {
  if (!maturity) return true;
  const created = Date.parse(enquiry.created_at);
  return !Number.isNaN(created) && created <= maturity.now.getTime() - maturity.days * 86400000;
}

/**
 * Cohort conversion to tattoo work, definition in full.
 *
 * Cohort: enquiries whose `created_at` falls in the period. Membership is
 * decided by that one timestamp, so an enquiry counts once, in the period it
 * arrived in. What became of it may have happened after the period closed.
 *
 * Converted: see `convertedEnquiryIds`.
 *
 * Maturity: with a rule given, only enquiries at least `days` old form the
 * denominator. A two-day-old enquiry has not failed to book; counting it as
 * unconverted made every young period look like a collapse. The young ones
 * are reported as `pending` instead. Without a rule the whole cohort is used.
 */
export function enquiryConversion(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
  maturity?: MaturityRule,
): ConversionResult {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const converted = convertedEnquiryIds(projects, sessions);
  const mature = cohort.filter((enquiry) => isMature(enquiry, maturity));
  const young = cohort.filter((enquiry) => !isMature(enquiry, maturity));
  const hits = mature.filter((enquiry) => converted.has(enquiry.id)).length;
  return {
    denominator: mature.length,
    converted: hits,
    rate: mature.length === 0 ? null : (hits / mature.length) * 100,
    cohort: cohort.length,
    pending: young.length,
    pendingConverted: young.filter((enquiry) => converted.has(enquiry.id)).length,
  };
}

/**
 * How much of the cohort has had a fair chance to convert.
 *
 * `settled` counts enquiries older than `maturityDays`.
 */
export function conversionMaturity(
  enquiries: StatisticsEnquiry[],
  period: Period,
  now: Date,
  maturityDays = CONVERSION_MATURITY_DAYS,
): { total: number; settled: number } {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const cutoff = now.getTime() - maturityDays * 86400000;
  return {
    total: cohort.length,
    settled: cohort.filter((enquiry) => Date.parse(enquiry.created_at) <= cutoff).length,
  };
}

/**
 * Change in a rate, in percentage points, or null when either side has no
 * rate. A rate against an empty cohort is not 0%, so "+40 pts, was 0" would
 * be invented.
 */
export function rateDelta(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  return delta(Math.round(current), Math.round(previous));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionTotals {
  /** Tattoo bookings due to start inside the period, drafts excluded. */
  booked: number;
  completed: number;
  planned: number;
  cancelled: number;
  noShow: number;
  /** Hours across completed tattoo work only. */
  hours: number;
  /** Mean hours per completed tattoo session, or null when there were none. */
  averageHours: number | null;
  /** cancelled / booked, as a percentage. null when nothing was booked. */
  cancellationRate: number | null;
  /** Consultations due in the period, kept entirely apart from tattoo work. */
  consultations: {
    /** Not cancelled, not a draft. */
    held: number;
    cancelled: number;
  };
}

/**
 * Session duration in hours.
 *
 * `duration_hours` is authoritative when the row carries it. When it does not -
 * older rows predate the column being filled - the wall-clock span between
 * `start_at` and `end_at` is used, which is the same quantity measured a
 * different way, not an estimate. A row that yields neither contributes zero
 * rather than a guess.
 */
export function sessionHours(session: StatisticsSession): number {
  if (typeof session.duration_hours === 'number' && Number.isFinite(session.duration_hours)) {
    return Math.max(0, session.duration_hours);
  }
  const start = Date.parse(session.start_at);
  const end = Date.parse(session.end_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return (end - start) / 3600000;
}

/**
 * Every session figure for one period.
 *
 * Period membership is decided by `start_at` throughout, including for
 * cancellations: the rate answers "of the work that was due in this window,
 * how much fell through", which needs one timestamp on both sides of the
 * division.
 *
 * Tattoo work and consultations are never added together. A half-hour
 * consultation is not a session worked, and counting it as one inflated
 * sessions, hours and the cancellation rate alike.
 */
export function sessionTotals(sessions: StatisticsSession[], period: Period): SessionTotals {
  const inPeriod = sessions.filter(
    (session) => isBookedSession(session) && within(period, session.start_at),
  );
  const work = inPeriod.filter(isTattooWork);
  const consultations = inPeriod.filter(isConsultation);
  const completed = work.filter((session) => COMPLETED_SESSION_STATUSES.has(session.status));
  const planned = work.filter((session) => PLANNED_SESSION_STATUSES.has(session.status));
  const cancelled = work.filter((session) => CANCELLED_SESSION_STATUSES.has(session.status));
  const noShow = work.filter((session) => NO_SHOW_SESSION_STATUSES.has(session.status));
  const hours = completed.reduce((total, session) => total + sessionHours(session), 0);
  return {
    booked: work.length,
    completed: completed.length,
    planned: planned.length,
    cancelled: cancelled.length,
    noShow: noShow.length,
    hours,
    averageHours: completed.length === 0 ? null : hours / completed.length,
    cancellationRate: work.length === 0 ? null : (cancelled.length / work.length) * 100,
    consultations: {
      held: consultations.filter(isHeldBooking).length,
      cancelled: consultations.filter((session) => CANCELLED_SESSION_STATUSES.has(session.status)).length,
    },
  };
}

export interface BookingsMade {
  /** Tattoo sessions or touch-ups whose booking was made in the period. */
  tattoo: number;
  /** Of those, the ones since cancelled. Still counted above: the booking was
   *  made in the period, and that is the question being answered. */
  tattooCancelled: number;
  consultations: number;
}

/**
 * Bookings made in the period, placed by `created_at` - the day the booking
 * was made, not the day of the appointment. This is the only figure that
 * shows a week's sales while the work itself is months ahead.
 *
 * Rows without `created_at` (read before the projection carried it) are not
 * placed at all rather than guessed.
 */
export function bookingsMade(sessions: StatisticsSession[], period: Period): BookingsMade {
  const made = sessions.filter(
    (session) => isBookedSession(session) && within(period, session.created_at ?? null),
  );
  const tattoo = made.filter(isTattooWork);
  return {
    tattoo: tattoo.length,
    tattooCancelled: tattoo.filter((session) => CANCELLED_SESSION_STATUSES.has(session.status)).length,
    consultations: made.filter(isConsultation).length,
  };
}

export interface UpcomingLoad {
  /** Tattoo sessions and touch-ups ahead. */
  sessions: number;
  hours: number;
  /** Consultations ahead, counted apart and never in the hours. */
  consultations: number;
  days: number;
}

/**
 * What is already in the diary ahead.
 *
 * Absolute counts only. A utilisation percentage would need a defensible
 * denominator - contracted hours net of time off - and this CRM does not hold
 * one that could be divided by without inventing it, so none is offered.
 */
export function upcomingLoad(sessions: StatisticsSession[], now: Date, days = 30): UpcomingLoad {
  const from = now.toISOString();
  const to = addLocalDays(startOfLocalDay(now), days + 1).toISOString();
  const ahead = sessions.filter(
    (session) => PLANNED_SESSION_STATUSES.has(session.status)
      && within({ from, to }, session.start_at),
  );
  const work = ahead.filter(isTattooWork);
  return {
    sessions: work.length,
    hours: work.reduce((total, session) => total + sessionHours(session), 0),
    consultations: ahead.filter(isConsultation).length,
    days,
  };
}

/** Tattoo sessions by local weekday, Monday first. Index 0 is Monday. */
export function sessionsByWeekday(sessions: StatisticsSession[], period: Period): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const session of sessions) {
    if (!isTattooWork(session) || !isLiveSession(session) || !within(period, session.start_at)) continue;
    const day = new Date(session.start_at).getDay();
    counts[(day + 6) % 7] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Repeat clients
// ---------------------------------------------------------------------------

export interface RepeatClients {
  /** Distinct clients with live tattoo work starting inside the period. */
  active: number;
  /** Of those, the ones who have come back for a second piece. */
  repeat: number;
  rate: number | null;
}

/**
 * Repeat clients, definition in full.
 *
 * Identity is `client_id` and nothing else. Matching on a name or an email
 * string would merge two people who share a name and split one person who
 * changed address.
 *
 * Active: distinct (artist, client) pairs with a completed or planned tattoo
 * session or touch-up starting in the period. Consultations do not make a
 * client active.
 *
 * Repeat: those pairs with live tattoo work on two or more DIFFERENT projects
 * with the same artist across their whole visible history. A sleeve done over
 * five sessions is one client coming back to finish one piece, not a returning
 * client; counting sessions called most of a multi-session diary "repeat".
 * A session with no project (legacy rows) cannot be told apart from its
 * neighbours and so never adds a project.
 */
export function repeatClients(
  history: StatisticsSession[],
  period: Period,
): RepeatClients {
  const live = history.filter((session) => isTattooWork(session) && isLiveSession(session));
  const projects = new Map<string, Set<string>>();
  for (const session of live) {
    if (!session.project_id) continue;
    const key = `${session.artist_id}:${session.client_id}`;
    const set = projects.get(key) ?? new Set<string>();
    set.add(session.project_id);
    projects.set(key, set);
  }
  const activeKeys = new Set(
    live
      .filter((session) => within(period, session.start_at))
      .map((session) => `${session.artist_id}:${session.client_id}`),
  );
  let repeat = 0;
  for (const key of activeKeys) {
    if ((projects.get(key)?.size ?? 0) >= 2) repeat += 1;
  }
  return {
    active: activeKeys.size,
    repeat,
    rate: activeKeys.size === 0 ? null : (repeat / activeKeys.size) * 100,
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Where an enquiry came from, as the records can prove it.
 *
 * paid      - a campaign tag with a paid medium (utm_medium paid, cpc, ...).
 * campaign  - a campaign tag without a paid medium (utm_medium social, ...).
 * social / search / ai / referral - the referrer's host.
 * internal  - the referrer is one of the studio's own sites: the visitor
 *             navigated there first, so where they came from is not known.
 * conversation - the enquiry was opened from a WhatsApp or Instagram thread.
 * manual    - typed into the CRM by the studio.
 * direct    - nothing recorded. Not "organic": simply unknown.
 *
 * The booking form an enquiry used (`booking_source_id`) is deliberately not a
 * channel. Every website enquiry carries it, so ranking it first hid every
 * campaign tag and referrer behind one "website" row.
 *
 * This is the technical source. What the client said in the form
 * (`discovery_source`) is reported separately and never merged with it.
 */
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
  /** Platform or host behind the channel, e.g. `meta`, `instagram`, `google`. */
  value: string | null;
}

const PAID_MEDIUMS = new Set([
  'paid', 'cpc', 'ppc', 'cpm', 'cpv', 'paidsocial', 'paid_social', 'paid-social',
  'paid_search', 'paid-search', 'paidsearch', 'ads', 'ad', 'display', 'sponsored',
]);

/** The studio's own hosts. A referrer here says nothing about acquisition. */
export const OWN_HOSTS = ['vishartattoo.com', 'kristinavishar.com'];

const PLATFORM_ALIASES: Record<string, string> = {
  fb: 'facebook',
  facebook: 'facebook',
  ig: 'instagram',
  instagram: 'instagram',
  meta: 'meta',
  google: 'google',
  adwords: 'google',
  googleads: 'google',
  tiktok: 'tiktok',
  chatgpt: 'chatgpt',
  'chatgpt.com': 'chatgpt',
};

function platformOf(raw: string): string {
  const value = raw.trim().toLowerCase();
  return PLATFORM_ALIASES[value] ?? value;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function classifyReferrer(host: string): Channel {
  const bare = host.replace(/^www\./, '');
  if (OWN_HOSTS.some((own) => hostMatches(bare, own))) {
    return { key: 'internal', kind: 'internal', value: null };
  }
  if (hostMatches(bare, 'instagram.com')) return { key: 'social:instagram', kind: 'social', value: 'instagram' };
  if (hostMatches(bare, 'facebook.com') || bare === 'fb.com' || bare === 'fb.me') {
    return { key: 'social:facebook', kind: 'social', value: 'facebook' };
  }
  if (hostMatches(bare, 'tiktok.com')) return { key: 'social:tiktok', kind: 'social', value: 'tiktok' };
  if (hostMatches(bare, 'pinterest.com')) return { key: 'social:pinterest', kind: 'social', value: 'pinterest' };
  if (hostMatches(bare, 'chatgpt.com') || hostMatches(bare, 'openai.com')) return { key: 'ai:chatgpt', kind: 'ai', value: 'chatgpt' };
  if (hostMatches(bare, 'perplexity.ai')) return { key: 'ai:perplexity', kind: 'ai', value: 'perplexity' };
  if (hostMatches(bare, 'claude.ai')) return { key: 'ai:claude', kind: 'ai', value: 'claude' };
  if (bare === 'gemini.google.com') return { key: 'ai:gemini', kind: 'ai', value: 'gemini' };
  if (hostMatches(bare, 'copilot.microsoft.com')) return { key: 'ai:copilot', kind: 'ai', value: 'copilot' };
  if (/(^|\.)google\.[a-z.]+$/.test(bare)) return { key: 'search:google', kind: 'search', value: 'google' };
  if (hostMatches(bare, 'bing.com')) return { key: 'search:bing', kind: 'search', value: 'bing' };
  if (hostMatches(bare, 'duckduckgo.com')) return { key: 'search:duckduckgo', kind: 'search', value: 'duckduckgo' };
  return { key: `referral:${bare}`, kind: 'referral', value: bare };
}

export function channelFor(enquiry: StatisticsEnquiry): Channel {
  const conversation = trimmed(enquiry.communication_channel);
  if (conversation) {
    return { key: `conversation:${conversation}`, kind: 'conversation', value: conversation };
  }
  if (trimmed(enquiry.source) === 'crm_manual') return { key: 'manual', kind: 'manual', value: null };

  const utmSource = trimmed(enquiry.utm_source);
  const utmMedium = trimmed(enquiry.utm_medium)?.toLowerCase() ?? null;
  if (utmMedium && PAID_MEDIUMS.has(utmMedium)) {
    const platform = utmSource ? platformOf(utmSource) : 'other';
    // Instagram and Facebook placements of one Meta campaign are one channel.
    const value = platform === 'instagram' || platform === 'facebook' ? 'meta' : platform;
    return { key: `paid:${value}`, kind: 'paid', value };
  }
  if (utmSource) {
    const value = platformOf(utmSource);
    return { key: `campaign:${value}`, kind: 'campaign', value };
  }

  const host = trimmed(enquiry.referrer_host)?.toLowerCase();
  if (host) return classifyReferrer(host);

  return { key: 'direct', kind: 'direct', value: null };
}

function trimmed(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : null;
}

export interface ChannelRow extends Channel {
  enquiries: number;
  /** Enquiries that had a consultation (not called off). */
  consulted: number;
  /** Enquiries that led to tattoo work which stands, at any time. */
  booked: number;
  /** Enquiries old enough to judge, and how many of them booked. */
  matured: number;
  maturedBooked: number;
}

/**
 * Enquiries, consultations and tattoo bookings per channel for one period.
 *
 * No rate column: a channel's young enquiries have not failed to book. The
 * matured counts are carried so an insight can speak about a channel only
 * once its enquiries have had time.
 */
export function channelBreakdown(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
  maturity?: MaturityRule,
): ChannelRow[] {
  const booked = convertedEnquiryIds(projects, sessions);
  const consulted = consultedEnquiryIds(projects, sessions);
  const rows = new Map<string, ChannelRow>();
  for (const enquiry of enquiries) {
    if (!within(period, enquiry.created_at)) continue;
    const channel = channelFor(enquiry);
    const row = rows.get(channel.key) ?? {
      ...channel, enquiries: 0, consulted: 0, booked: 0, matured: 0, maturedBooked: 0,
    };
    row.enquiries += 1;
    if (consulted.has(enquiry.id)) row.consulted += 1;
    if (booked.has(enquiry.id)) row.booked += 1;
    if (isMature(enquiry, maturity)) {
      row.matured += 1;
      if (booked.has(enquiry.id)) row.maturedBooked += 1;
    }
    rows.set(channel.key, row);
  }
  return [...rows.values()].sort((a, b) => b.enquiries - a.enquiries || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelStageId = 'enquiries' | 'consultations' | 'booked' | 'completed';

export interface FunnelStage {
  id: FunnelStageId;
  count: number;
  /** Share of the period's enquiries, or null over an empty cohort. Every
   *  stage is measured against the enquiries: a tattoo can be booked without
   *  a consultation, so the stages are not strictly nested. */
  shareOfEnquiries: number | null;
}

export interface Funnel {
  stages: FunnelStage[];
  /**
   * Tattoo work in the period that carries no link back to an enquiry, and so
   * cannot be placed in the funnel at all. Reported, never counted as zero.
   */
  unlinkedProjects: number;
  unlinkedSessions: number;
}

/**
 * Enquiry -> consultation -> tattoo booked -> tattoo done, as a cohort of the
 * enquiries created in the period. Every stage counts distinct enquiries.
 */
export function funnel(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
): Funnel {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const cohortIds = new Set(cohort.map((enquiry) => enquiry.id));
  const count = (ids: Set<string>) => [...ids].filter((id) => cohortIds.has(id)).length;
  const share = (value: number) => (cohort.length === 0 ? null : (value / cohort.length) * 100);

  const consulted = count(consultedEnquiryIds(projects, sessions));
  const booked = count(convertedEnquiryIds(projects, sessions));
  const completed = count(tattooCompletedEnquiryIds(projects, sessions));
  const enquiryOfProject = enquiryOfProjectMap(projects);

  return {
    stages: [
      { id: 'enquiries', count: cohort.length, shareOfEnquiries: null },
      { id: 'consultations', count: consulted, shareOfEnquiries: share(consulted) },
      { id: 'booked', count: booked, shareOfEnquiries: share(booked) },
      { id: 'completed', count: completed, shareOfEnquiries: share(completed) },
    ],
    unlinkedProjects: projects.filter(
      (project) => !project.enquiry_id && within(period, project.created_at),
    ).length,
    unlinkedSessions: sessions.filter(
      (session) => isTattooWork(session)
        && isBookedSession(session)
        && !enquiryOfSession(session, enquiryOfProject)
        && within(period, session.start_at),
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export type SeriesGranularity = 'day' | 'week' | 'month';

export interface SeriesPoint {
  /** Local ISO date of the bucket's first day, `YYYY-MM-DD`. */
  bucket: string;
  enquiries: number;
  sessions: number;
}

export function granularityFor(days: number): SeriesGranularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * Enquiries by `created_at` and booked sessions by `start_at`, bucketed over
 * the period. Every bucket in the range is emitted, including empty ones, so a
 * quiet week reads as a gap rather than being closed up by the chart.
 */
export function timeSeries(
  enquiries: StatisticsEnquiry[],
  sessions: StatisticsSession[],
  period: Period,
  granularity: SeriesGranularity,
): SeriesPoint[] {
  const from = new Date(period.from);
  const to = new Date(period.to);
  const buckets = new Map<string, SeriesPoint>();

  for (let cursor = bucketStart(from, granularity); cursor < to; cursor = nextBucket(cursor, granularity)) {
    buckets.set(localIsoDate(cursor), { bucket: localIsoDate(cursor), enquiries: 0, sessions: 0 });
  }

  const place = (value: string, field: 'enquiries' | 'sessions') => {
    if (!within(period, value)) return;
    const key = localIsoDate(bucketStart(new Date(value), granularity));
    const point = buckets.get(key);
    if (point) point[field] += 1;
  };

  for (const enquiry of enquiries) place(enquiry.created_at, 'enquiries');
  for (const session of sessions) {
    if (isBookedSession(session)) place(session.start_at, 'sessions');
  }

  return [...buckets.values()];
}

function bucketStart(value: Date, granularity: SeriesGranularity): Date {
  if (granularity === 'month') return new Date(value.getFullYear(), value.getMonth(), 1);
  if (granularity === 'week') {
    const day = startOfLocalDay(value);
    // Monday, matching the weekday chart below it.
    return addLocalDays(day, -((day.getDay() + 6) % 7));
  }
  return startOfLocalDay(value);
}

function nextBucket(value: Date, granularity: SeriesGranularity): Date {
  if (granularity === 'month') return new Date(value.getFullYear(), value.getMonth() + 1, 1);
  return addLocalDays(value, granularity === 'week' ? 7 : 1);
}

export function localIsoDate(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------
//
// Three quantities, never added together:
//
//   received  - money the CRM has a succeeded, credit transaction for.
//   refunded  - money that went back out, shown apart rather than netted off.
//   open      - payment requests still waiting to be paid, right now.
//
// Each is reported per currency. Adding GBP to anything else would produce a
// number denominated in nothing, so currencies never merge - not even when only
// one is present, which is why these are lists rather than scalars.
//
// Removed on 2026-10-15, and why:
// - "Deposits requested" summed every deposit request whatever became of it.
//   A cancelled request that was re-issued and paid was counted twice
//   (production: £2,250 shown for £1,250 actually asked for and paid).
// - "Quoted on new projects" was an estimate, present on 3 of 8 projects, and
//   read next to real money as if it were money.

export interface CurrencyAmount {
  currency: string;
  amount: number;
  count: number;
}

export interface FinanceTotals {
  received: CurrencyAmount[];
  refunded: CurrencyAmount[];
  /** Pending requests that have not expired: money still being asked for. */
  open: CurrencyAmount[];
  /** Requests part-paid so far. Their remainder is not known from the
   *  projection, so they are counted, never summed into `open`. */
  partiallyPaid: number;
}

const REFUND_TRANSACTION_TYPES = new Set(['refund', 'partial_refund']);

function toAmount(value: number | string): number {
  // `numeric` arrives as a string from PostgREST when it is wide enough to lose
  // precision as a float, so both shapes have to be handled.
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function accumulate(rows: Array<{ currency: string; amount: number | string }>): CurrencyAmount[] {
  const totals = new Map<string, CurrencyAmount>();
  for (const row of rows) {
    const currency = (row.currency || '').trim().toUpperCase() || 'UNKNOWN';
    const entry = totals.get(currency) ?? { currency, amount: 0, count: 0 };
    entry.amount += toAmount(row.amount);
    entry.count += 1;
    totals.set(currency, entry);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Whether a payment request is still open at `now`.
 *
 * `pending` and not expired. A cancelled request (re-issued, withdrawn) and an
 * expired one are not money anybody is waiting for; a paid one is already in
 * "received". This is what keeps one deposit from being counted twice.
 */
export function isOpenRequest(request: StatisticsPaymentRequest, now: Date): boolean {
  if (request.status !== 'pending') return false;
  return isUnexpired(request, now);
}

function isUnexpired(request: StatisticsPaymentRequest, now: Date): boolean {
  if (!request.expires_at) return true;
  const expires = Date.parse(request.expires_at);
  return Number.isNaN(expires) || expires > now.getTime();
}

/**
 * The finance block.
 *
 * Received counts `payment_transactions` that are `succeeded` and `credit`,
 * placed in the period by `occurred_at` - when the money moved. Failed
 * transactions are excluded entirely.
 *
 * Open is a statement about today, not about the period: every request that
 * is pending and unexpired, whenever it was created.
 */
export function financeTotals(
  transactions: StatisticsTransaction[],
  openRequests: StatisticsPaymentRequest[],
  period: Period,
  now: Date,
): FinanceTotals {
  const succeeded = transactions.filter(
    (transaction) => transaction.status === 'succeeded' && within(period, transaction.occurred_at),
  );
  return {
    received: accumulate(
      succeeded.filter(
        (transaction) => transaction.direction === 'credit'
          && !REFUND_TRANSACTION_TYPES.has(transaction.transaction_type),
      ),
    ),
    refunded: accumulate(
      succeeded.filter(
        (transaction) => transaction.direction === 'debit'
          || REFUND_TRANSACTION_TYPES.has(transaction.transaction_type),
      ),
    ),
    open: accumulate(openRequests.filter((request) => isOpenRequest(request, now))),
    // The payment workflow treats a part-paid request as open only while it
    // has not expired, exactly like a pending one.
    partiallyPaid: openRequests.filter(
      (request) => request.status === 'partially_paid' && isUnexpired(request, now),
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export interface Insight {
  id: string;
  /** Translated at the edge. Values are numbers and already-resolved labels. */
  params: Record<string, string | number>;
  tone: 'neutral' | 'good' | 'bad';
}

/**
 * Minimum denominators, chosen so a sentence is only produced when the numbers
 * behind it could not have been produced by a single quiet week.
 *
 * These are not statistical significance tests, and the copy never claims they
 * are. They are a floor below which a comparison is noise and is therefore not
 * stated at all.
 */
export const INSIGHT_MINIMUMS = {
  enquiryTrend: 5,
  /** Mature enquiries in each cohort. */
  conversionTrend: 8,
  /** Mature enquiries from one channel before saying it has not booked. */
  channel: 8,
  cancellation: 8,
} as const;

export interface InsightInput {
  /** False when the previous window predates the CRM's history. */
  comparable: boolean;
  enquiries: Delta;
  /** Mature-only conversion for both windows. */
  conversion: { current: ConversionResult; previous: ConversionResult };
  sessions: { current: SessionTotals; previous: SessionTotals };
  channels: ChannelRow[];
  /** Resolves a channel to the label the reader sees. */
  channelLabel: (channel: ChannelRow) => string;
}

/**
 * Deterministic sentences derived from the numbers already on the screen.
 *
 * No model, no network, no customer data: the inputs are the aggregates
 * computed above and nothing else. Given the same aggregates this returns the
 * same list in the same order, which is what makes it testable.
 */
export function buildInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];

  // A channel whose mature enquiries have produced no tattoo at all. Placed
  // first: it is the one sentence that asks for a decision (usually: is the
  // advert worth its money).
  for (const channel of input.channels) {
    if (channel.kind === 'direct' || channel.kind === 'manual' || channel.kind === 'internal') continue;
    if (channel.matured >= INSIGHT_MINIMUMS.channel && channel.maturedBooked === 0) {
      insights.push({
        id: 'insight.channelNoBookings',
        params: { channel: input.channelLabel(channel), enquiries: channel.matured },
        tone: 'bad',
      });
    }
  }

  if (
    input.comparable
    && input.enquiries.current >= INSIGHT_MINIMUMS.enquiryTrend
    && input.enquiries.previous >= INSIGHT_MINIMUMS.enquiryTrend
    && input.enquiries.percent !== null
    && Math.abs(input.enquiries.percent) >= 10
  ) {
    insights.push({
      id: input.enquiries.percent > 0 ? 'insight.enquiriesUp' : 'insight.enquiriesDown',
      params: { percent: Math.abs(Math.round(input.enquiries.percent)) },
      tone: input.enquiries.percent > 0 ? 'good' : 'bad',
    });
  }

  // Mature enquiries only, on both sides. Comparing a cohort that has had
  // weeks to book with one that has had days reported every young period as a
  // collapse.
  const { current, previous } = input.conversion;
  if (
    input.comparable
    && current.denominator >= INSIGHT_MINIMUMS.conversionTrend
    && previous.denominator >= INSIGHT_MINIMUMS.conversionTrend
    && current.rate !== null
    && previous.rate !== null
    && Math.abs(current.rate - previous.rate) >= 5
  ) {
    insights.push({
      id: current.rate > previous.rate ? 'insight.conversionUp' : 'insight.conversionDown',
      params: {
        from: Math.round(previous.rate),
        to: Math.round(current.rate),
        mature: current.denominator,
        pending: current.pending,
      },
      tone: current.rate > previous.rate ? 'good' : 'bad',
    });
  }

  const sessionsNow = input.sessions.current;
  const sessionsBefore = input.sessions.previous;
  if (
    input.comparable
    && sessionsNow.booked >= INSIGHT_MINIMUMS.cancellation
    && sessionsBefore.booked >= INSIGHT_MINIMUMS.cancellation
    && sessionsNow.cancelled !== sessionsBefore.cancelled
  ) {
    insights.push({
      id: sessionsNow.cancelled > sessionsBefore.cancelled
        ? 'insight.cancellationsUp'
        : 'insight.cancellationsDown',
      params: { from: sessionsBefore.cancelled, to: sessionsNow.cancelled },
      tone: sessionsNow.cancelled > sessionsBefore.cancelled ? 'bad' : 'good',
    });
  }

  return insights;
}
