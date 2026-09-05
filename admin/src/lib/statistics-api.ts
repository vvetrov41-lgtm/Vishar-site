// Reads for the Statistics screen.
//
// Three properties this module has to hold, in order of how much it would cost
// to get them wrong.
//
// 1. It never widens access. Every read is an ordinary artist-scoped select on
//    a table the CRM already reads elsewhere. Row level security decides what
//    comes back; the optional `artistId` narrows the answer for the person
//    looking, it does not grant them anything. There is no SECURITY DEFINER
//    aggregate here and no view added for convenience.
//
// 2. It never truncates. The list reads the rest of the CRM uses cap at 200 or
//    300 rows, which is right for a working queue and wrong for a count: a
//    silently clipped page would produce a number that is simply false. Every
//    read here pages until the source is exhausted, bounded by an explicit
//    date window and a hard ceiling that is reported rather than hidden.
//
// 3. Finance fails closed and fails quietly. `payment_transactions`,
//    `payment_requests` and `projects_finance` are refused by the database to
//    anybody without finance access on the artist. That refusal is the
//    boundary; this module treats it as "no finance block", never as an error
//    that takes the rest of the page down with it.

import { ApiError, type CrmClient } from './api';
import { describeApiFailure } from './api-errors';
import { currentLanguage } from './i18n';
import type {
  Period,
  StatisticsBookingSource,
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

export interface StatisticsEnquiryWithDiscovery extends StatisticsEnquiry {
  discovery_source: string | null;
}

export interface StatisticsFinance {
  transactions: StatisticsTransaction[];
  requests: StatisticsPaymentRequest[];
  projectEstimates: Array<{ project_id: string; currency: string; estimate_total: number | string | null }>;
}

export interface StatisticsDataset {
  /** Enquiries created inside the widest window asked for. */
  enquiries: StatisticsEnquiryWithDiscovery[];
  /** Projects created inside that window, plus every project a cohort enquiry
   *  produced later - conversion is answered by existence, not by date. */
  projects: StatisticsProject[];
  /** Sessions inside the window, plus the forward window, plus the history the
   *  repeat-client rule needs. */
  sessions: StatisticsSession[];
  /** Empty when the viewer may not read the registry. Labels only. */
  bookingSources: StatisticsBookingSource[];
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
  'id, artist_id, client_id, status, source, booking_source_id, communication_channel, utm_source, discovery_source, created_at';
const PROJECT_COLUMNS = 'id, artist_id, client_id, enquiry_id, status, created_at';
const SESSION_COLUMNS =
  'id, artist_id, client_id, project_id, enquiry_id, status, appointment_type, start_at, end_at, duration_hours, cancelled_at';

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
  async function loadFinance(
    request: StatisticsRequest,
    projectIds: string[],
  ): Promise<StatisticsFinance | null> {
    const { window, artistId } = request;

    const transactions = await readAllOptional<StatisticsTransaction>(
      () => scoped(
        'payment_transactions',
        'id, artist_id, transaction_type, direction, amount, currency, status, occurred_at',
        artistId,
      )
        .gte('occurred_at', window.from)
        .lt('occurred_at', window.to)
        .order('occurred_at', { ascending: true }),
    );

    const requests = await readAllOptional<StatisticsPaymentRequest>(
      () => scoped(
        'payment_requests',
        'id, artist_id, purpose, amount, currency, status, created_at',
        artistId,
      )
        .gte('created_at', window.from)
        .lt('created_at', window.to)
        .order('created_at', { ascending: true }),
    );

    // `projects_finance` is a security_invoker view over the private finance
    // source, so it is scoped by the same rule as the tables above rather than
    // by anything this module does.
    const projectEstimates = projectIds.length === 0
      ? []
      : await readAllOptional<{ project_id: string; currency: string; estimate_total: number | string | null }>(
        () => (client.from('projects_finance') as PostgrestQuery)
          .select('project_id, currency, estimate_total')
          .in('project_id', projectIds),
      ) ?? [];

    if (transactions === null && requests === null) return null;

    return {
      transactions: transactions ?? [],
      requests: requests ?? [],
      projectEstimates,
    };
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

      // Enquiries created in the window. `intake_state = 'complete'` matches
      // the working queue exactly: a half-submitted intake is not an enquiry
      // the artist ever saw, so counting it would inflate every source and
      // depress every conversion rate.
      const enquiries = note(
        await readAll<StatisticsEnquiryWithDiscovery>(
          () => scoped('enquiries', ENQUIRY_COLUMNS, artistId)
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
          () => scoped('sessions', SESSION_COLUMNS, artistId)
            .gte('start_at', window.from)
            .lt('start_at', forwardTo)
            .order('start_at', { ascending: true }),
          'load statistics',
        ),
      ).rows;

      // Projects created in the window.
      const windowProjects = note(
        await readAll<StatisticsProject>(
          () => scoped('projects', PROJECT_COLUMNS, artistId)
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
      // Without this, an enquiry converted last week would count as
      // unconverted in a period that ended yesterday.
      const enquiryIds = enquiries.map((enquiry) => enquiry.id);
      const linkedProjects = enquiryIds.length === 0
        ? []
        : note(
          await readAll<StatisticsProject>(
            () => scoped('projects', PROJECT_COLUMNS, artistId)
              .is('archived_at', null)
              .in('enquiry_id', enquiryIds)
              .order('created_at', { ascending: true }),
            'load statistics',
          ),
        ).rows;
      const linkedSessions = enquiryIds.length === 0
        ? []
        : note(
          await readAll<StatisticsSession>(
            () => scoped('sessions', SESSION_COLUMNS, artistId)
              .in('enquiry_id', enquiryIds)
              .order('start_at', { ascending: true }),
            'load statistics',
          ),
        ).rows;

      // A session belonging to a cohort enquiry only through its project.
      const projectIds = [...new Set(
        [...windowProjects, ...linkedProjects].map((project) => project.id),
      )];
      const projectSessions = projectIds.length === 0
        ? []
        : note(
          await readAll<StatisticsSession>(
            () => scoped('sessions', SESSION_COLUMNS, artistId)
              .in('project_id', projectIds)
              .order('start_at', { ascending: true }),
            'load statistics',
          ),
        ).rows;

      // Repeat clients are a lifetime question, so it needs lifetime rows for
      // the clients on screen - and only for them. Asking by client id keeps
      // this proportional to the period rather than to the whole table.
      const clientIds = [...new Set(windowSessions.map((session) => session.client_id))];
      const clientHistory = clientIds.length === 0
        ? []
        : note(
          await readAll<StatisticsSession>(
            () => scoped('sessions', SESSION_COLUMNS, artistId)
              .in('client_id', clientIds)
              .order('start_at', { ascending: true }),
            'load statistics',
          ),
        ).rows;

      const sessions = dedupeById([
        ...windowSessions,
        ...linkedSessions,
        ...projectSessions,
        ...clientHistory,
      ]);
      const projects = dedupeById([...windowProjects, ...linkedProjects]);

      // Labels only, and entirely optional: `booking_sources` is readable to
      // whoever may manage them, which a working artist need not be. Denied,
      // the breakdown falls back to the enquiry's own recorded source and
      // keeps every distinct form as its own row.
      const bookingSources = await readAllOptional<StatisticsBookingSource>(
        () => scoped('booking_sources', 'id, display_label', artistId)
          .order('display_label', { ascending: true }),
      );

      const finance = request.includeFinance
        ? await loadFinance(request, projects.map((project) => project.id))
        : null;

      return {
        enquiries,
        projects,
        sessions,
        bookingSources: bookingSources ?? [],
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
