// Reads for the Statistics screen.
//
// Three properties this module has to hold, in order of how much it would cost
// to get them wrong.
//
// 1. It never widens access. Counted business rows come from dedicated
//    security_invoker projections. Existing row level security still decides
//    what comes back; the projections only remove explicitly excluded analytics
//    lineage. The optional `artistId` narrows the answer for the person looking,
//    it does not grant them anything. There is no SECURITY DEFINER aggregate.
//
// 2. It never truncates. The list reads the rest of the CRM uses cap at 200 or
//    300 rows, which is right for a working queue and wrong for a count: a
//    silently clipped page would produce a number that is simply false. Every
//    read here pages until the source is exhausted, bounded by an explicit
//    date window and a hard ceiling that is reported rather than hidden.
//
// 3. Finance fails closed and fails quietly. The exclusion-aware payment
//    projections and `projects_finance` remain subject to the caller's database
//    permissions and are refused to anybody without finance access on the artist. That refusal is the
//    boundary; this module treats it as "no finance block", never as an error
//    that takes the rest of the page down with it.

import { ApiError, type CrmClient } from './api';
import { describeApiFailure } from './api-errors';
import { currentLanguage } from './i18n';
import type {
  Period,
  StatisticsEnquiry,
  StatisticsPaymentRequest,
  StatisticsProject,
  StatisticsSession,
  StatisticsTransaction,
} from './statistics';

/** Rows per request. Chosen to stay well inside PostgREST's default ceiling. */
const PAGE_SIZE = 500;
/**
 * The most rows one read will gather before it stops asking.
 *
 * A studio period does not approach this. Reaching it means something is very
 * different from what this screen was designed for, and the honest response is
 * to say the figures are partial rather than to print a number computed from
 * an arbitrary prefix of the data.
 */
const MAX_ROWS = 20000;
/**
 * Ids per `in.(...)` filter. Every id travels in the request URL; at ~40
 * characters each, an unbounded list reached 2.8 KB at 70 ids in production
 * and would pass gateway URL limits within months. Chunks keep every request
 * small however long the period.
 */
const IN_CHUNK = 100;

export interface StatisticsEnquiryWithDiscovery extends StatisticsEnquiry {
  discovery_source: string | null;
}

export interface StatisticsFinance {
  transactions: StatisticsTransaction[];
  /** Pending and part-paid requests, whenever created: what is still owed. */
  openRequests: StatisticsPaymentRequest[];
}

export interface StatisticsDataset {
  /** Enquiries created inside the widest window asked for. */
  enquiries: StatisticsEnquiryWithDiscovery[];
  /** Projects created inside that window, plus every project a cohort enquiry
   *  produced later - conversion is answered by existence, not by date. */
  projects: StatisticsProject[];
  /** Sessions inside the window, plus the forward window, plus bookings made
   *  in the window, plus the history the repeat-client rule needs. */
  sessions: StatisticsSession[];
  /** The earliest enquiry the viewer may see, or null when there is none. A
   *  previous window opening before it cannot be compared with. */
  historyStart: string | null;
  /** null when the viewer holds no finance access, or the read was refused. */
  finance: StatisticsFinance | null;
  /** True when any read hit `MAX_ROWS`. The screen says so rather than lying. */
  truncated: boolean;
}

export interface StatisticsRequest {
  /** The widest window on screen: the previous period's start to the current
   *  period's end. Both series are computed from one read. */
  window: Period;
  /** How far ahead the upcoming-load figures look. */
  forwardDays: number;
  artistId?: string;
  /** Ask for the finance reads at all. False for a viewer without the
   *  capability, so the screen does not fire a request it knows is refused. */
  includeFinance: boolean;
}

type PostgrestQuery = {
  select: (columns: string) => PostgrestQuery;
  eq: (column: string, value: unknown) => PostgrestQuery;
  in: (column: string, values: unknown[]) => PostgrestQuery;
  is: (column: string, value: unknown) => PostgrestQuery;
  gte: (column: string, value: unknown) => PostgrestQuery;
  lt: (column: string, value: unknown) => PostgrestQuery;
  order: (column: string, options: { ascending: boolean }) => PostgrestQuery;
  range: (from: number, to: number) => PostgrestQuery;
  limit: (count: number) => PostgrestQuery;
};

/**
 * Pull every row a query matches, one page at a time.
 *
 * `build` is called per page because a PostgREST builder is single-use. The
 * caller gets the rows and whether the ceiling stopped the walk early.
 */
async function readAll<T>(
  build: () => PostgrestQuery,
  what: 'load statistics',
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const result = await (build().range(offset, offset + PAGE_SIZE - 1) as unknown as Promise<{
      data: T[] | null;
      error: unknown;
    }>);
    if (result.error) {
      throw new ApiError(describeApiFailure(result.error, what, currentLanguage()), result.error);
    }
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * `readAll` over an id list, one chunk of ids per query, so no request URL
 * grows with the period.
 */
async function readAllIn<T>(
  ids: string[],
  build: (chunk: string[]) => PostgrestQuery,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let truncated = false;
  for (let index = 0; index < ids.length; index += IN_CHUNK) {
    const chunk = ids.slice(index, index + IN_CHUNK);
    const result = await readAll<T>(() => build(chunk), 'load statistics');
    rows.push(...result.rows);
    truncated = truncated || result.truncated;
  }
  return { rows, truncated };
}

/** A read whose refusal is a legitimate answer, not a failure. */
async function readAllOptional<T>(build: () => PostgrestQuery): Promise<T[] | null> {
  try {
    const { rows } = await readAll<T>(build, 'load statistics');
    return rows;
  } catch {
    return null;
  }
}

const ENQUIRY_COLUMNS =
  'id, artist_id, client_id, status, source, booking_source_id, communication_channel, utm_source, utm_medium, utm_campaign, referrer_host, discovery_source, created_at';
const PROJECT_COLUMNS = 'id, artist_id, client_id, enquiry_id, status, created_at';
const SESSION_COLUMNS =
  'id, artist_id, client_id, project_id, enquiry_id, status, appointment_type, start_at, end_at, duration_hours, cancelled_at, created_at';

export function createStatisticsApi(client: CrmClient) {
  const scoped = (table: string, columns: string, artistId?: string) => {
    let query = (client.from(table) as PostgrestQuery).select(columns);
    if (artistId) query = query.eq('artist_id', artistId);
    return query;
  };

  /**
   * The finance reads, each of which the database refuses outright to a viewer
   * without finance access on the artist.
   *
   * Returns null when nothing could be read. That is the same answer a viewer
   * without the capability gets, which is the point: the screen has one code
   * path for "no finance block" and cannot be talked into a second.
   */
  async function loadFinance(request: StatisticsRequest): Promise<StatisticsFinance | null> {
    const { window, artistId } = request;

    const transactions = await readAllOptional<StatisticsTransaction>(
      () => scoped(
        'statistics_payment_transactions',
        'id, artist_id, transaction_type, direction, amount, currency, status, occurred_at',
        artistId,
      )
        .gte('occurred_at', window.from)
        .lt('occurred_at', window.to)
        .order('occurred_at', { ascending: true }),
    );

    // What is still owed is a statement about today, so it is read without a
    // date bound. Cancelled and paid requests are not read at all: a request
    // that was cancelled and re-issued must not be counted next to the one
    // that replaced it.
    const openRequests = await readAllOptional<StatisticsPaymentRequest>(
      () => scoped(
        'statistics_payment_requests',
        'id, artist_id, purpose, amount, currency, status, created_at, expires_at',
        artistId,
      )
        .in('status', ['pending', 'partially_paid'])
        .order('created_at', { ascending: true }),
    );

    if (transactions === null && openRequests === null) return null;

    return {
      transactions: transactions ?? [],
      openRequests: openRequests ?? [],
    };
  }

  /**
   * The earliest enquiry the viewer may see. One row; a failed read answers
   * null, which only hides the period comparison - it never fails the page.
   */
  async function readHistoryStart(artistId?: string): Promise<string | null> {
    try {
      const result = await (scoped('statistics_enquiries', 'created_at', artistId)
        .is('archived_at', null)
        .eq('intake_state', 'complete')
        .order('created_at', { ascending: true })
        .limit(1) as unknown as Promise<{ data: Array<{ created_at: string }> | null; error: unknown }>);
      if (result.error) return null;
      return result.data?.[0]?.created_at ?? null;
    } catch {
      return null;
    }
  }

  return {
    loadFinance,

    /**
     * Everything the Statistics screen needs, in as few round trips as the
     * shape of the questions allows.
     *
     * The window covers both the current and the previous period, so the
     * comparison is computed from one consistent read rather than two reads
     * taken moments apart.
     */
    async loadStatistics(request: StatisticsRequest): Promise<StatisticsDataset> {
      const { window, artistId } = request;
      const forwardTo = new Date(
        Date.parse(window.to) + request.forwardDays * 86400000,
      ).toISOString();

      let truncated = false;
      const note = <T,>(result: { rows: T[]; truncated: boolean }) => {
        truncated = truncated || result.truncated;
        return result;
      };

      // Enquiries created in the window. The security_invoker projection has
      // already removed explicitly excluded test/internal lineage.
      // `intake_state = 'complete'` matches
      // the working queue exactly: a half-submitted intake is not an enquiry
      // the artist ever saw, so counting it would inflate every source and
      // depress every conversion rate.
      const enquiries = note(
        await readAll<StatisticsEnquiryWithDiscovery>(
          () => scoped('statistics_enquiries', ENQUIRY_COLUMNS, artistId)
            .is('archived_at', null)
            .eq('intake_state', 'complete')
            .gte('created_at', window.from)
            .lt('created_at', window.to)
            .order('created_at', { ascending: true }),
          'load statistics',
        ),
      ).rows;

      // Sessions from the start of the window to the end of the forward
      // window, so one read serves the period figures and the upcoming load.
      const windowSessions = note(
        await readAll<StatisticsSession>(
          () => scoped('statistics_sessions', SESSION_COLUMNS, artistId)
            .gte('start_at', window.from)
            .lt('start_at', forwardTo)
            .order('start_at', { ascending: true }),
          'load statistics',
        ),
      ).rows;

      // Bookings made in the window, whenever they are due. A booking made
      // today for next spring is this period's sale, and the start_at read
      // above would never see it.
      const bookedInWindow = note(
        await readAll<StatisticsSession>(
          () => scoped('statistics_sessions', SESSION_COLUMNS, artistId)
            .gte('created_at', window.from)
            .lt('created_at', window.to)
            .order('created_at', { ascending: true }),
          'load statistics',
        ),
      ).rows;

      // Projects created in the window.
      const windowProjects = note(
        await readAll<StatisticsProject>(
          () => scoped('statistics_projects', PROJECT_COLUMNS, artistId)
            .is('archived_at', null)
            .gte('created_at', window.from)
            .lt('created_at', window.to)
            .order('created_at', { ascending: true }),
          'load statistics',
        ),
      ).rows;

      // Conversion asks what became of a cohort, and what became of it may have
      // happened after the window closed. So the projects and sessions that
      // point back at a cohort enquiry are fetched by id, without a date bound.
      const enquiryIds = enquiries.map((enquiry) => enquiry.id);
      const linkedProjects = note(
        await readAllIn<StatisticsProject>(enquiryIds, (chunk) =>
          scoped('statistics_projects', PROJECT_COLUMNS, artistId)
            .is('archived_at', null)
            .in('enquiry_id', chunk)
            .order('created_at', { ascending: true })),
      ).rows;
      const linkedSessions = note(
        await readAllIn<StatisticsSession>(enquiryIds, (chunk) =>
          scoped('statistics_sessions', SESSION_COLUMNS, artistId)
            .in('enquiry_id', chunk)
            .order('start_at', { ascending: true })),
      ).rows;

      // A session belonging to a cohort enquiry only through its project.
      const projectIds = [...new Set(
        [...windowProjects, ...linkedProjects].map((project) => project.id),
      )];
      const projectSessions = note(
        await readAllIn<StatisticsSession>(projectIds, (chunk) =>
          scoped('statistics_sessions', SESSION_COLUMNS, artistId)
            .in('project_id', chunk)
            .order('start_at', { ascending: true })),
      ).rows;

      // Repeat clients are a lifetime question, so it needs lifetime rows for
      // the clients on screen - and only for them.
      const clientIds = [...new Set(windowSessions.map((session) => session.client_id))];
      const clientHistory = note(
        await readAllIn<StatisticsSession>(clientIds, (chunk) =>
          scoped('statistics_sessions', SESSION_COLUMNS, artistId)
            .in('client_id', chunk)
            .order('start_at', { ascending: true })),
      ).rows;

      const sessions = dedupeById([
        ...windowSessions,
        ...bookedInWindow,
        ...linkedSessions,
        ...projectSessions,
        ...clientHistory,
      ]);
      const projects = dedupeById([...windowProjects, ...linkedProjects]);

      // Where the viewer's visible history begins. One row.
      const historyStart = await readHistoryStart(artistId);

      const finance = request.includeFinance ? await loadFinance(request) : null;

      return {
        enquiries,
        projects,
        sessions,
        historyStart,
        finance,
        truncated,
      };
    },

  };
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) seen.set(row.id, row);
  return [...seen.values()];
}

export type StatisticsApi = ReturnType<typeof createStatisticsApi>;
