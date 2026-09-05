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
}

export interface StatisticsBookingSource {
  id: string;
  display_label: string;
}

// ---------------------------------------------------------------------------
// Status vocabularies
// ---------------------------------------------------------------------------
//
// Mirrored from the production enums (`session_status`, `project_status`). A
// value outside these sets is counted as "some other status" rather than
// silently folded into the nearest one.

/** A booking that happened. */
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

/** Every session status that represents a real booking, whatever became of it.
 *  This is the denominator of the cancellation rate. */
export function isBookedSession(session: StatisticsSession): boolean {
  return !DRAFT_SESSION_STATUSES.has(session.status);
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
// Enquiries and conversion
// ---------------------------------------------------------------------------

export interface ConversionResult {
  /** Enquiries created inside the period. The denominator. */
  denominator: number;
  /** Of those, the ones that led to a project or a booking. */
  converted: number;
  /** null when the denominator is 0. A rate over nothing is not 0%. */
  rate: number | null;
}

/**
 * Cohort conversion, definition in full.
 *
 * Denominator: enquiries whose `created_at` falls in the period. Membership is
 * decided by that one timestamp and no other, so an enquiry counts once, in
 * the period it arrived in.
 *
 * Converted: an enquiry in that cohort which is referenced by at least one
 * project (`projects.enquiry_id`) or at least one booked session
 * (`sessions.enquiry_id`, or `sessions.project_id` -> that project's
 * `enquiry_id`). The project or session may have been created at any time,
 * including after the period ended - the question is what became of that
 * cohort, not what happened inside a window.
 *
 * The consequence, stated rather than hidden: a cohort that is still young
 * converts less simply because it has had less time. `conversionMaturity`
 * below exists so the screen can say so.
 */
export function enquiryConversion(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
): ConversionResult {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const converted = convertedEnquiryIds(projects, sessions);
  const hits = cohort.filter((enquiry) => converted.has(enquiry.id)).length;
  return {
    denominator: cohort.length,
    converted: hits,
    rate: cohort.length === 0 ? null : (hits / cohort.length) * 100,
  };
}

/** Every enquiry id that some project or booked session points back at. */
export function convertedEnquiryIds(
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
): Set<string> {
  const ids = new Set<string>();
  const enquiryOfProject = new Map<string, string>();
  for (const project of projects) {
    if (!project.enquiry_id) continue;
    enquiryOfProject.set(project.id, project.enquiry_id);
    ids.add(project.enquiry_id);
  }
  for (const session of sessions) {
    if (!isBookedSession(session)) continue;
    if (session.enquiry_id) {
      ids.add(session.enquiry_id);
      continue;
    }
    const viaProject = session.project_id ? enquiryOfProject.get(session.project_id) : undefined;
    if (viaProject) ids.add(viaProject);
  }
  return ids;
}

/**
 * How much of the cohort has had a fair chance to convert.
 *
 * `settled` counts enquiries older than `maturityDays`. The screen uses it to
 * mark a conversion figure as still moving instead of presenting a trailing
 * edge as a fall.
 */
export function conversionMaturity(
  enquiries: StatisticsEnquiry[],
  period: Period,
  now: Date,
  maturityDays = 14,
): { total: number; settled: number } {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const cutoff = now.getTime() - maturityDays * 86400000;
  return {
    total: cohort.length,
    settled: cohort.filter((enquiry) => Date.parse(enquiry.created_at) <= cutoff).length,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionTotals {
  /** Bookings due to start inside the period, drafts excluded. */
  booked: number;
  completed: number;
  planned: number;
  cancelled: number;
  noShow: number;
  /** Hours across completed sessions only. */
  hours: number;
  /** Mean hours per completed session, or null when there were none. */
  averageHours: number | null;
  /** cancelled / booked, as a percentage. null when nothing was booked. */
  cancellationRate: number | null;
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
 * cancellations. That is deliberate: the rate answers "of the work that was due
 * in this window, how much fell through", which needs one timestamp on both
 * sides of the division. Using `cancelled_at` for the numerator and `start_at`
 * for the denominator would produce a ratio of two different populations.
 */
export function sessionTotals(sessions: StatisticsSession[], period: Period): SessionTotals {
  const inPeriod = sessions.filter(
    (session) => isBookedSession(session) && within(period, session.start_at),
  );
  const completed = inPeriod.filter((session) => COMPLETED_SESSION_STATUSES.has(session.status));
  const planned = inPeriod.filter((session) => PLANNED_SESSION_STATUSES.has(session.status));
  const cancelled = inPeriod.filter((session) => CANCELLED_SESSION_STATUSES.has(session.status));
  const noShow = inPeriod.filter((session) => NO_SHOW_SESSION_STATUSES.has(session.status));
  const hours = completed.reduce((total, session) => total + sessionHours(session), 0);
  return {
    booked: inPeriod.length,
    completed: completed.length,
    planned: planned.length,
    cancelled: cancelled.length,
    noShow: noShow.length,
    hours,
    averageHours: completed.length === 0 ? null : hours / completed.length,
    cancellationRate: inPeriod.length === 0 ? null : (cancelled.length / inPeriod.length) * 100,
  };
}

export interface UpcomingLoad {
  sessions: number;
  hours: number;
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
  return {
    sessions: ahead.length,
    hours: ahead.reduce((total, session) => total + sessionHours(session), 0),
    days,
  };
}

/** Sessions by local weekday, Monday first. Index 0 is Monday. */
export function sessionsByWeekday(sessions: StatisticsSession[], period: Period): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const session of sessions) {
    if (!isLiveSession(session) || !within(period, session.start_at)) continue;
    const day = new Date(session.start_at).getDay();
    counts[(day + 6) % 7] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Repeat clients
// ---------------------------------------------------------------------------

export interface RepeatClients {
  /** Distinct clients with a live session starting inside the period. */
  active: number;
  /** Of those, the ones this artist has seen more than once, ever. */
  repeat: number;
  rate: number | null;
}

/**
 * Repeat clients, definition in full.
 *
 * Identity is `client_id` and nothing else. Matching on a name or an email
 * string would merge two people who share a name and split one person who
 * changed address; the CRM already resolves intake to a client row, and that
 * row is the answer.
 *
 * Active: distinct clients with a completed or planned session starting in the
 * period. Repeat: those among them who have two or more completed or planned
 * sessions with the same artist across their whole history - the history the
 * viewer can see, which is the history row level security allows them. Pairing
 * is (client, artist), so a client seen once by each of two artists is a repeat
 * client for neither.
 *
 * `history` is every session in scope, not just the period's. Counting inside
 * the period alone would call a client of three years "new" because their
 * second visit happens to be their only one this month.
 */
export function repeatClients(
  history: StatisticsSession[],
  period: Period,
): RepeatClients {
  const live = history.filter(isLiveSession);
  const lifetime = new Map<string, number>();
  for (const session of live) {
    const key = `${session.artist_id}:${session.client_id}`;
    lifetime.set(key, (lifetime.get(key) ?? 0) + 1);
  }
  const activeKeys = new Set(
    live
      .filter((session) => within(period, session.start_at))
      .map((session) => `${session.artist_id}:${session.client_id}`),
  );
  let repeat = 0;
  for (const key of activeKeys) {
    if ((lifetime.get(key) ?? 0) >= 2) repeat += 1;
  }
  return {
    active: activeKeys.size,
    repeat,
    rate: activeKeys.size === 0 ? null : (repeat / activeKeys.size) * 100,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceKind = 'booking_source' | 'channel' | 'utm' | 'form' | 'unknown';

export interface SourceBreakdownRow {
  key: string;
  kind: SourceKind;
  /** The raw value behind the key. Translated at the edge, never here. */
  value: string | null;
  label: string | null;
  enquiries: number;
  converted: number;
  rate: number | null;
}

/**
 * Which field decides an enquiry's source, in strict priority order.
 *
 * 1. `booking_source_id` - a row in the booking source registry, the CRM's own
 *    authoritative answer to "which form was this".
 * 2. `communication_channel` - WhatsApp or Instagram, for enquiries opened from
 *    a conversation rather than a form.
 * 3. `utm_source` - a campaign tag on the submission.
 * 4. `source` - the raw landing path or intake marker the form recorded.
 * 5. Nothing, which is reported as unknown rather than folded into a neighbour.
 *
 * Exactly one rule fires per enquiry and no two values are ever merged. Two
 * forms that happen to sit on the same landing page stay two rows, because they
 * are two registry entries; guessing they are "really" one source would be the
 * heuristic this is written to avoid.
 */
export function sourceKeyFor(enquiry: StatisticsEnquiry): { key: string; kind: SourceKind; value: string | null } {
  if (enquiry.booking_source_id) {
    return { key: `booking_source:${enquiry.booking_source_id}`, kind: 'booking_source', value: enquiry.booking_source_id };
  }
  const channel = trimmed(enquiry.communication_channel);
  if (channel) return { key: `channel:${channel}`, kind: 'channel', value: channel };
  const utm = trimmed(enquiry.utm_source);
  if (utm) return { key: `utm:${utm}`, kind: 'utm', value: utm };
  const source = trimmed(enquiry.source);
  if (source) return { key: `form:${source}`, kind: 'form', value: source };
  return { key: 'unknown', kind: 'unknown', value: null };
}

function trimmed(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : null;
}

/**
 * Enquiries and conversions per source for one period.
 *
 * `bookingSources` supplies display labels where the viewer is allowed to read
 * the registry. Where they are not - `booking_sources` is readable only to
 * whoever may manage them - the enquiry's own `source` value is used instead.
 * That is a second authoritative field on the same row, not a guess, and it
 * keeps distinct forms as distinct rows either way.
 */
export function sourceBreakdown(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
  bookingSources: StatisticsBookingSource[] = [],
): SourceBreakdownRow[] {
  const labels = new Map(bookingSources.map((source) => [source.id, source.display_label]));
  const converted = convertedEnquiryIds(projects, sessions);
  const rows = new Map<string, SourceBreakdownRow>();

  for (const enquiry of enquiries) {
    if (!within(period, enquiry.created_at)) continue;
    const { key, kind, value } = sourceKeyFor(enquiry);
    const existing = rows.get(key) ?? {
      key,
      kind,
      value,
      label: kind === 'booking_source' && value
        ? labels.get(value) ?? trimmed(enquiry.source)
        : null,
      enquiries: 0,
      converted: 0,
      rate: null,
    };
    existing.enquiries += 1;
    if (converted.has(enquiry.id)) existing.converted += 1;
    rows.set(key, existing);
  }

  return [...rows.values()]
    .map((row) => ({ ...row, rate: row.enquiries === 0 ? null : (row.converted / row.enquiries) * 100 }))
    .sort((a, b) => b.enquiries - a.enquiries || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export interface FunnelStage {
  id: 'enquiries' | 'projects' | 'sessions';
  count: number;
  /** Share of the stage above, or null at the top and over an empty cohort. */
  rateFromPrevious: number | null;
}

export interface Funnel {
  stages: FunnelStage[];
  /**
   * Rows in the period that carry no link back up the chain, and so cannot be
   * placed in the funnel at all.
   *
   * These are reported, never counted as zero. A project created before the
   * CRM recorded `enquiry_id` did come from somewhere; calling its cohort
   * "unconverted" would understate every historical period.
   */
  unlinkedProjects: number;
  unlinkedSessions: number;
}

/**
 * Enquiry -> Project -> Session, as a cohort of the enquiries created in the
 * period.
 *
 * Every stage counts distinct enquiries, not rows: an enquiry that produced
 * two projects is one enquiry that reached the project stage. A session
 * qualifies through `enquiry_id` or through its project's `enquiry_id`,
 * whichever the row carries.
 */
export function funnel(
  enquiries: StatisticsEnquiry[],
  projects: StatisticsProject[],
  sessions: StatisticsSession[],
  period: Period,
): Funnel {
  const cohort = enquiries.filter((enquiry) => within(period, enquiry.created_at));
  const cohortIds = new Set(cohort.map((enquiry) => enquiry.id));

  const enquiryOfProject = new Map<string, string>();
  const reachedProject = new Set<string>();
  for (const project of projects) {
    if (!project.enquiry_id) continue;
    enquiryOfProject.set(project.id, project.enquiry_id);
    if (cohortIds.has(project.enquiry_id)) reachedProject.add(project.enquiry_id);
  }

  const reachedSession = new Set<string>();
  for (const session of sessions) {
    if (!isBookedSession(session)) continue;
    const enquiryId = session.enquiry_id
      ?? (session.project_id ? enquiryOfProject.get(session.project_id) ?? null : null);
    if (enquiryId && cohortIds.has(enquiryId)) reachedSession.add(enquiryId);
  }

  const stages: FunnelStage[] = [
    { id: 'enquiries', count: cohort.length, rateFromPrevious: null },
    {
      id: 'projects',
      count: reachedProject.size,
      rateFromPrevious: cohort.length === 0 ? null : (reachedProject.size / cohort.length) * 100,
    },
    {
      id: 'sessions',
      count: reachedSession.size,
      rateFromPrevious: reachedProject.size === 0
        ? null
        : (reachedSession.size / reachedProject.size) * 100,
    },
  ];

  return {
    stages,
    unlinkedProjects: projects.filter(
      (project) => !project.enquiry_id && within(period, project.created_at),
    ).length,
    unlinkedSessions: sessions.filter(
      (session) => isBookedSession(session)
        && !session.enquiry_id
        && !(session.project_id && enquiryOfProject.has(session.project_id))
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
// Four different quantities, never added together:
//
//   received  - money the CRM has a succeeded, credit transaction for.
//   refunded  - money that went back out, shown apart rather than netted off.
//   requested - deposits asked for. A request is not a payment.
//   estimated - the value of projects created. An estimate is not revenue.
//
// Each is reported per currency. Adding GBP to anything else would produce a
// number denominated in nothing, so currencies never merge - not even when only
// one is present, which is why these are lists rather than scalars.

export interface CurrencyAmount {
  currency: string;
  amount: number;
  count: number;
}

export interface FinanceTotals {
  received: CurrencyAmount[];
  refunded: CurrencyAmount[];
  depositsRequested: CurrencyAmount[];
  estimatedProjectValue: CurrencyAmount[];
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
 * The finance block.
 *
 * Received counts `payment_transactions` that are `succeeded` and `credit`,
 * placed in the period by `occurred_at` - when the money moved, not when the
 * row was written. Failed transactions are excluded entirely; a payment that
 * did not go through is not income.
 *
 * Deposits requested counts `payment_requests` with purpose `deposit` by
 * `created_at`, whatever became of them. It is a measure of asking, and the
 * screen labels it as such.
 *
 * Estimated project value sums `estimate_total` for projects created in the
 * period. It is what the work was quoted at. It is never presented as revenue,
 * and it is deliberately not netted against anything.
 */
export function financeTotals(
  transactions: StatisticsTransaction[],
  requests: StatisticsPaymentRequest[],
  projectEstimates: Array<{ project_id: string; currency: string; estimate_total: number | string | null }>,
  projects: StatisticsProject[],
  period: Period,
): FinanceTotals {
  const succeeded = transactions.filter(
    (transaction) => transaction.status === 'succeeded' && within(period, transaction.occurred_at),
  );
  const projectsInPeriod = new Set(
    projects.filter((project) => within(period, project.created_at)).map((project) => project.id),
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
    depositsRequested: accumulate(
      requests.filter(
        (request) => request.purpose === 'deposit' && within(period, request.created_at),
      ),
    ),
    estimatedProjectValue: accumulate(
      projectEstimates
        .filter((row) => projectsInPeriod.has(row.project_id) && row.estimate_total !== null)
        .map((row) => ({ currency: row.currency, amount: row.estimate_total as number | string })),
    ),
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
  conversionTrend: 8,
  weekday: 8,
  source: 5,
  cancellation: 8,
} as const;

export interface InsightInput {
  enquiries: Delta;
  conversion: { current: ConversionResult; previous: ConversionResult };
  sessions: { current: SessionTotals; previous: SessionTotals };
  weekday: number[];
  topSource: SourceBreakdownRow | null;
  topSourceLabel: string | null;
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

  if (
    input.enquiries.current >= INSIGHT_MINIMUMS.enquiryTrend
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

  const { current, previous } = input.conversion;
  if (
    current.denominator >= INSIGHT_MINIMUMS.conversionTrend
    && previous.denominator >= INSIGHT_MINIMUMS.conversionTrend
    && current.rate !== null
    && previous.rate !== null
    && Math.abs(current.rate - previous.rate) >= 5
  ) {
    insights.push({
      id: current.rate > previous.rate ? 'insight.conversionUp' : 'insight.conversionDown',
      params: { from: Math.round(previous.rate), to: Math.round(current.rate) },
      tone: current.rate > previous.rate ? 'good' : 'bad',
    });
  }

  const weekdayTotal = input.weekday.reduce((sum, value) => sum + value, 0);
  if (weekdayTotal >= INSIGHT_MINIMUMS.weekday) {
    const best = input.weekday.reduce(
      (top, value, index) => (value > top.value ? { index, value } : top),
      { index: 0, value: input.weekday[0] },
    );
    // Only when one day genuinely leads. A tie has no busiest day, and naming
    // either of them would be a coin toss presented as a finding.
    const ties = input.weekday.filter((value) => value === best.value).length;
    if (ties === 1 && best.value > 0) {
      insights.push({
        id: 'insight.busiestWeekday',
        params: { weekday: best.index, count: best.value },
        tone: 'neutral',
      });
    }
  }

  if (
    input.topSource
    && input.topSource.enquiries >= INSIGHT_MINIMUMS.source
    && input.topSourceLabel
  ) {
    insights.push({
      id: 'insight.topSource',
      params: {
        source: input.topSourceLabel,
        enquiries: input.topSource.enquiries,
        converted: input.topSource.converted,
      },
      tone: 'neutral',
    });
  }

  const sessionsNow = input.sessions.current;
  const sessionsBefore = input.sessions.previous;
  if (
    sessionsNow.booked >= INSIGHT_MINIMUMS.cancellation
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
