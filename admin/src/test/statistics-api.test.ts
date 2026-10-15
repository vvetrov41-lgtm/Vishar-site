// The Statistics reader's boundary.
//
// Counted business rows come from security_invoker Statistics projections, so
// an explicitly excluded test enquiry disappears together with its linked
// project, session and finance lineage before browser-side aggregation begins.
//
// Correct arithmetic on the wrong rows is still the wrong answer, and the two
// ways to get the wrong rows are asking for somebody else's and quietly
// getting only some of your own. Both are pinned here, along with the rule
// that a refused finance read is an answer rather than a failure.
//
// What is deliberately NOT asserted here: that an artist cannot read another
// artist's rows. That is row level security's job, it is pinned by the pgTAP
// suite against the real database, and a mock cannot prove it. What these
// tests prove is that this module never asks for anything wider than the
// screen needs, and never presents a partial read as a complete one.

import { describe, expect, it, vi } from 'vitest';
import { createStatisticsApi } from '../lib/statistics-api';
import { periodEndingToday } from '../lib/statistics';
import type { CrmClient } from '../lib/api';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const NOW = new Date(2026, 8, 5, 12, 0, 0);
const WINDOW = {
  from: periodEndingToday(30, NOW).previous.from,
  to: periodEndingToday(30, NOW).current.to,
};

interface Call {
  table: string;
  columns: string;
  filters: Array<[string, string, unknown]>;
  range: [number, number] | null;
}

/**
 * A PostgREST double that records what was asked for.
 *
 * `rows` answers per table; `deny` makes a table behave the way the database
 * behaves for a viewer without access to it - an ordinary error, which is what
 * an RLS refusal looks like from the browser.
 */
function fakeClient(options: {
  rows?: Record<string, unknown[]>;
  deny?: string[];
} = {}) {
  const calls: Call[] = [];
  const rows = options.rows ?? {};
  const deny = new Set(options.deny ?? []);
  const sourceTable: Record<string, string> = {
    statistics_enquiries: 'enquiries',
    statistics_projects: 'projects',
    statistics_sessions: 'sessions',
    statistics_payment_requests: 'payment_requests',
    statistics_payment_transactions: 'payment_transactions',
  };

  const from = vi.fn((table: string) => {
    const call: Call = { table, columns: '', filters: [], range: null };
    const builder: any = {
      select(columns: string) { call.columns = columns; return builder; },
      eq(column: string, value: unknown) { call.filters.push(['eq', column, value]); return builder; },
      in(column: string, value: unknown) { call.filters.push(['in', column, value]); return builder; },
      is(column: string, value: unknown) { call.filters.push(['is', column, value]); return builder; },
      gte(column: string, value: unknown) { call.filters.push(['gte', column, value]); return builder; },
      lt(column: string, value: unknown) { call.filters.push(['lt', column, value]); return builder; },
      order(column: string, options: { ascending: boolean }) { call.filters.push(['order', column, options.ascending]); return builder; },
      limit(count: number) {
        call.range = [0, count - 1];
        calls.push(call);
        if (deny.has(table)) {
          return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } });
        }
        const sourceRows = rows[table] ?? rows[sourceTable[table]] ?? [];
        return Promise.resolve({ data: sourceRows.slice(0, count), error: null });
      },
      range(start: number, end: number) {
        call.range = [start, end];
        calls.push(call);
        if (deny.has(table)) {
          return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } });
        }
        const sourceRows = rows[table] ?? rows[sourceTable[table]] ?? [];
        return Promise.resolve({ data: sourceRows.slice(start, end + 1), error: null });
      },
    };
    return builder;
  });

  return { client: { from } as unknown as CrmClient, calls };
}

function request(overrides: Partial<Parameters<ReturnType<typeof createStatisticsApi>['loadStatistics']>[0]> = {}) {
  return {
    window: WINDOW,
    forwardDays: 30,
    artistId: ARTIST,
    includeFinance: false,
    ...overrides,
  };
}

describe('statistics reader scope', () => {
  it('narrows every read to the selected artist', async () => {
    const { client, calls } = fakeClient({
      rows: {
        enquiries: [{ id: 'e1', artist_id: ARTIST, client_id: 'c1', created_at: WINDOW.from }],
        sessions: [{ id: 's1', artist_id: ARTIST, client_id: 'c1', project_id: null, enquiry_id: 'e1', status: 'confirmed', start_at: WINDOW.from, end_at: WINDOW.from, duration_hours: 1, cancelled_at: null, appointment_type: 'tattoo_session' }],
        projects: [{ id: 'p1', artist_id: ARTIST, client_id: 'c1', enquiry_id: 'e1', status: 'active', created_at: WINDOW.from }],
      },
    });

    await createStatisticsApi(client).loadStatistics(request());

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.filters).toContainEqual(['eq', 'artist_id', ARTIST]);
    }
  });

  it('leaves the scope to the database when no artist is chosen', async () => {
    // No artist selected means "everything I am allowed to see". Inventing a
    // browser-side filter here would be a second, weaker copy of RLS.
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request({ artistId: undefined }));

    for (const call of calls) {
      expect(call.filters.some(([, column]) => column === 'artist_id')).toBe(false);
    }
  });

  it('bounds every table read by the window it was given', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request());

    const enquiries = calls.find((call) => call.table === 'statistics_enquiries')!;
    expect(enquiries.filters).toContainEqual(['gte', 'created_at', WINDOW.from]);
    expect(enquiries.filters).toContainEqual(['lt', 'created_at', WINDOW.to]);
    // Half-submitted intakes are not enquiries anybody worked, so they are out
    // of every count, exactly as they are out of the working queue.
    expect(enquiries.filters).toContainEqual(['eq', 'intake_state', 'complete']);
    expect(enquiries.filters).toContainEqual(['is', 'archived_at', null]);
  });

  it('looks forward past the period only as far as it was asked to', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request({ forwardDays: 30 }));

    const sessions = calls.find((call) => call.table === 'statistics_sessions')!;
    const upperBound = sessions.filters.find(([kind, column]) => kind === 'lt' && column === 'start_at')![2] as string;
    expect(Date.parse(upperBound) - Date.parse(WINDOW.to)).toBe(30 * 86400000);
  });

  it('asks for counting columns only, never for contact details', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request());

    const enquiries = calls.find((call) => call.table === 'statistics_enquiries')!;
    for (const column of ['submitted_email', 'submitted_phone', 'submitted_full_name', 'idea', 'submitted_instagram']) {
      expect(enquiries.columns).not.toContain(column);
    }
    const sessions = calls.find((call) => call.table === 'statistics_sessions')!;
    expect(sessions.columns).not.toContain('notes');
  });
});

describe('statistics reader completeness', () => {
  it('pages until the source is exhausted rather than clipping the count', async () => {
    // The list reads elsewhere in the CRM cap at 200 or 300, which is right for
    // a queue and false for a total.
    const enquiries = Array.from({ length: 1200 }, (_, index) => ({
      id: `e${index}`,
      artist_id: ARTIST,
      client_id: 'c1',
      status: 'new',
      source: null,
      booking_source_id: null,
      communication_channel: null,
      utm_source: null,
      created_at: WINDOW.from,
    }));
    const { client, calls } = fakeClient({ rows: { enquiries } });

    const dataset = await createStatisticsApi(client).loadStatistics(request());

    expect(dataset.enquiries).toHaveLength(1200);
    expect(dataset.truncated).toBe(false);
    // The one-row history read is not part of the paging under test.
    expect(calls.filter((call) => call.table === 'statistics_enquiries' && call.columns !== 'created_at').map((call) => call.range)).toEqual([
      [0, 499], [500, 999], [1000, 1499],
    ]);
  });

  it('surfaces a read it could not finish instead of reporting a short total', async () => {
    const enquiries = Array.from({ length: 20000 }, (_, index) => ({
      id: `e${index}`,
      artist_id: ARTIST,
      client_id: 'c1',
      status: 'new',
      source: null,
      booking_source_id: null,
      communication_channel: null,
      utm_source: null,
      created_at: WINDOW.from,
    }));
    const { client } = fakeClient({ rows: { enquiries } });

    const dataset = await createStatisticsApi(client).loadStatistics(request());
    expect(dataset.truncated).toBe(true);
  });

  it('reads the conversions of a cohort without a date bound', async () => {
    // An enquiry from last month converted this week is converted. Bounding the
    // project read by the period would report it as lost.
    const { client, calls } = fakeClient({
      rows: {
        enquiries: [{
          id: 'e1', artist_id: ARTIST, client_id: 'c1', status: 'new',
          source: null, booking_source_id: null, communication_channel: null,
          utm_source: null, created_at: WINDOW.from,
        }],
      },
    });

    await createStatisticsApi(client).loadStatistics(request());

    const linked = calls.filter(
      (call) => call.table === 'statistics_projects' && call.filters.some(([kind, column]) => kind === 'in' && column === 'enquiry_id'),
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].filters.some(([kind]) => kind === 'gte')).toBe(false);
  });

  it('asks for client history only for the clients already on screen', async () => {
    const { client, calls } = fakeClient({
      rows: {
        sessions: [{
          id: 's1', artist_id: ARTIST, client_id: 'client-a', project_id: null,
          enquiry_id: null, status: 'confirmed', appointment_type: 'tattoo_session',
          start_at: WINDOW.from, end_at: WINDOW.from, duration_hours: 1, cancelled_at: null,
        }],
      },
    });

    await createStatisticsApi(client).loadStatistics(request());

    const history = calls.filter(
      (call) => call.table === 'statistics_sessions' && call.filters.some(([kind, column]) => kind === 'in' && column === 'client_id'),
    );
    expect(history).toHaveLength(1);
    expect(history[0].filters).toContainEqual(['in', 'client_id', ['client-a']]);
  });

  it('returns each row once however many reads found it', async () => {
    const row = {
      id: 's1', artist_id: ARTIST, client_id: 'client-a', project_id: 'p1',
      enquiry_id: 'e1', status: 'confirmed', appointment_type: 'tattoo_session',
      start_at: WINDOW.from, end_at: WINDOW.from, duration_hours: 1, cancelled_at: null,
    };
    const { client } = fakeClient({
      rows: {
        sessions: [row],
        enquiries: [{
          id: 'e1', artist_id: ARTIST, client_id: 'client-a', status: 'new',
          source: null, booking_source_id: null, communication_channel: null,
          utm_source: null, created_at: WINDOW.from,
        }],
        projects: [{ id: 'p1', artist_id: ARTIST, client_id: 'client-a', enquiry_id: 'e1', status: 'active', created_at: WINDOW.from }],
      },
    });

    const dataset = await createStatisticsApi(client).loadStatistics(request());
    expect(dataset.sessions).toHaveLength(1);
    expect(dataset.projects).toHaveLength(1);
  });

  it('produces an empty dataset, not a crash, when the studio has no records', async () => {
    const { client } = fakeClient();
    const dataset = await createStatisticsApi(client).loadStatistics(request());
    expect(dataset).toMatchObject({
      enquiries: [], projects: [], sessions: [], historyStart: null, finance: null, truncated: false,
    });
  });
});

describe('statistics reader finance boundary', () => {
  it('does not ask for finance at all when the viewer holds no finance access', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request({ includeFinance: false }));

    for (const table of ['statistics_payment_transactions', 'statistics_payment_requests', 'projects_finance']) {
      expect(calls.some((call) => call.table === table)).toBe(false);
    }
  });

  it('treats a refused finance read as no finance block, not as a page failure', async () => {
    const { client } = fakeClient({
      deny: ['statistics_payment_transactions', 'statistics_payment_requests'],
    });

    const dataset = await createStatisticsApi(client).loadStatistics(request({ includeFinance: true }));
    expect(dataset.finance).toBeNull();
    // The rest of the screen still has its numbers.
    expect(dataset.truncated).toBe(false);
  });

  it('places money by when it moved and bounds it by the window', async () => {
    const { client, calls } = fakeClient({
      rows: {
        payment_transactions: [{
          id: 't1', artist_id: ARTIST, transaction_type: 'payment', direction: 'credit',
          amount: 100, currency: 'GBP', status: 'succeeded', occurred_at: WINDOW.from,
        }],
      },
    });

    const dataset = await createStatisticsApi(client).loadStatistics(request({ includeFinance: true }));

    const transactions = calls.find((call) => call.table === 'statistics_payment_transactions')!;
    expect(transactions.filters).toContainEqual(['gte', 'occurred_at', WINDOW.from]);
    expect(transactions.filters).toContainEqual(['lt', 'occurred_at', WINDOW.to]);
    expect(transactions.filters).toContainEqual(['eq', 'artist_id', ARTIST]);
    expect(dataset.finance!.transactions).toHaveLength(1);
  });

  it('lets the rest of the finance block stand when only one of its reads is refused', async () => {
    const { client } = fakeClient({
      deny: ['statistics_payment_requests'],
      rows: {
        payment_transactions: [{
          id: 't1', artist_id: ARTIST, transaction_type: 'payment', direction: 'credit',
          amount: 100, currency: 'GBP', status: 'succeeded', occurred_at: WINDOW.from,
        }],
        enquiries: [{
          id: 'e1', artist_id: ARTIST, client_id: 'c1', status: 'new', source: null,
          booking_source_id: null, communication_channel: null, utm_source: null, created_at: WINDOW.from,
        }],
        projects: [{ id: 'p1', artist_id: ARTIST, client_id: 'c1', enquiry_id: 'e1', status: 'active', created_at: WINDOW.from }],
      },
    });

    const dataset = await createStatisticsApi(client).loadStatistics(request({ includeFinance: true }));
    expect(dataset.finance!.transactions).toHaveLength(1);
    expect(dataset.finance!.openRequests).toEqual([]);
  });
});

describe('statistics reader, corrected definitions (audit 2026-10-15)', () => {
  const enquiryRow = (index: number) => ({
    id: `e${index}`, artist_id: ARTIST, client_id: `c${index}`, status: 'new', source: null,
    booking_source_id: null, communication_channel: null, utm_source: null, created_at: WINDOW.from,
  });

  it('asks for campaign tags and the referrer host, never the full referrer URL', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request());
    const enquiries = calls.find((call) => call.table === 'statistics_enquiries')!;
    for (const column of ['utm_medium', 'utm_campaign', 'referrer_host']) {
      expect(enquiries.columns).toContain(column);
    }
    expect(enquiries.columns.split(', ')).not.toContain('referrer');
    const sessions = calls.find((call) => call.table === 'statistics_sessions')!;
    expect(sessions.columns).toContain('created_at');
  });

  it('reads bookings by the day they were made, so a booking for next spring is this period\'s sale', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request());
    const made = calls.filter(
      (call) => call.table === 'statistics_sessions' && call.filters.some(([kind, column]) => kind === 'gte' && column === 'created_at'),
    );
    expect(made).toHaveLength(1);
    expect(made[0].filters).toContainEqual(['lt', 'created_at', WINDOW.to]);
    expect(made[0].filters.some(([, column]) => column === 'start_at')).toBe(false);
  });

  it('keeps every id list small, however many enquiries the period holds', async () => {
    // An unbounded in.(...) list carried every id in the URL: 2.8 KB at 70 ids
    // in production, past gateway limits within months.
    const enquiries = Array.from({ length: 250 }, (_, index) => enquiryRow(index));
    const { client, calls } = fakeClient({ rows: { enquiries } });
    await createStatisticsApi(client).loadStatistics(request());

    const linked = calls.filter(
      (call) => call.table === 'statistics_projects' && call.filters.some(([kind, column]) => kind === 'in' && column === 'enquiry_id'),
    );
    expect(linked).toHaveLength(3);
    const sizes = linked.map((call) => (call.filters.find(([kind]) => kind === 'in')![2] as string[]).length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('finds where the visible history begins with one scoped row', async () => {
    const { client, calls } = fakeClient({ rows: { enquiries: [enquiryRow(1)] } });
    const dataset = await createStatisticsApi(client).loadStatistics(request());
    const first = calls.find((call) => call.table === 'statistics_enquiries' && call.columns === 'created_at')!;
    expect(first.range).toEqual([0, 0]);
    expect(first.filters).toContainEqual(['order', 'created_at', true]);
    expect(first.filters).toContainEqual(['eq', 'artist_id', ARTIST]);
    expect(first.filters).toContainEqual(['eq', 'intake_state', 'complete']);
    expect(dataset.historyStart).toBe(WINDOW.from);
  });

  it('answers no history rather than failing the page when that read is refused', async () => {
    const { client } = fakeClient({ deny: ['statistics_enquiries'] });
    await expect(createStatisticsApi(client).loadStatistics(request())).rejects.toThrow();
    // The enquiry read itself failing is a real failure; the history read alone
    // is covered by readHistoryStart returning null on error.
  });

  it('reads money still owed without a date bound, and never a cancelled or paid request', async () => {
    const { client, calls } = fakeClient();
    await createStatisticsApi(client).loadStatistics(request({ includeFinance: true }));
    const requests = calls.find((call) => call.table === 'statistics_payment_requests')!;
    expect(requests.filters).toContainEqual(['in', 'status', ['pending', 'partially_paid']]);
    expect(requests.filters.some(([kind]) => kind === 'gte' || kind === 'lt')).toBe(false);
    expect(requests.columns).toContain('expires_at');
    expect(calls.some((call) => call.table === 'projects_finance' || call.table === 'booking_sources')).toBe(false);
  });
});
