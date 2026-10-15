// Statistics overview: turns get_statistics' per-artist answers into what the
// screen shows. Pure; no business definition lives here.
//
// Combining artists is limited to sums of counts and of same-currency money,
// which add up by construction. A rate is recomputed from the summed
// numerator and denominator; a median cannot be combined at all, so medians
// stay per artist.

import { delta, rateDelta, type CurrencyAmount, type Delta } from './statistics';
import type {
  StatisticsArtistResult,
  StatisticsChannelRow,
  StatisticsCore,
  StatisticsFinanceBlock,
  StatisticsForecast,
  StatisticsResult,
  StatisticsWeek,
} from './statistics-api';

function sumMoney(lists: CurrencyAmount[][]): CurrencyAmount[] {
  const totals = new Map<string, CurrencyAmount>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const currency = (entry.currency || 'UNKNOWN').toUpperCase();
      const current = totals.get(currency) ?? { currency, amount: 0, count: 0 };
      current.amount += Number(entry.amount) || 0;
      current.count = (current.count ?? 0) + (entry.count ?? 0);
      totals.set(currency, current);
    }
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

function sumRecord(records: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record ?? {})) out[key] = (out[key] ?? 0) + Number(value);
  }
  return out;
}

function sumChannels(lists: StatisticsChannelRow[][]): StatisticsChannelRow[] {
  const rows = new Map<string, StatisticsChannelRow>();
  for (const list of lists) {
    for (const row of list ?? []) {
      const current = rows.get(row.key) ?? { ...row, enquiries: 0, consulted: 0, booked: 0, matured: 0, matured_booked: 0 };
      current.enquiries += row.enquiries;
      current.consulted += row.consulted;
      current.booked += row.booked;
      current.matured += row.matured;
      current.matured_booked += row.matured_booked;
      rows.set(row.key, current);
    }
  }
  return [...rows.values()].sort((a, b) => b.enquiries - a.enquiries || a.key.localeCompare(b.key));
}

function sumWeeks(lists: StatisticsWeek[][]): StatisticsWeek[] {
  // Every artist answers the same twelve local Mondays in their own timezone;
  // the studio's artists share one, so the weeks line up by index.
  const length = Math.max(0, ...lists.map((list) => list?.length ?? 0));
  return Array.from({ length }, (_, index) => {
    const weeks = lists.map((list) => list?.[index]).filter(Boolean) as StatisticsWeek[];
    return {
      week_start: weeks[0]?.week_start ?? '',
      tattoo_sessions: weeks.reduce((total, week) => total + week.tattoo_sessions, 0),
      tattoo_hours: weeks.reduce((total, week) => total + Number(week.tattoo_hours), 0),
      consultations: weeks.reduce((total, week) => total + week.consultations, 0),
    };
  });
}

function sumForecast(forecasts: StatisticsForecast[]): StatisticsForecast {
  const add = (pick: (forecast: StatisticsForecast) => number) =>
    forecasts.reduce((total, forecast) => total + (Number(pick(forecast)) || 0), 0);
  const money = (pick: (forecast: StatisticsForecast) => CurrencyAmount[]) => sumMoney(forecasts.map(pick));
  return {
    sessions: add((f) => f.sessions),
    pricing_configured: forecasts.every((f) => f.pricing_configured),
    confirmed: {
      sessions: add((f) => f.confirmed.sessions),
      value: money((f) => f.confirmed.value),
      remaining_after_deposits: money((f) => f.confirmed.remaining_after_deposits),
    },
    estimated: {
      sessions: add((f) => f.estimated.sessions),
      full_day: add((f) => f.estimated.full_day),
      hourly: add((f) => f.estimated.hourly),
      from_project_rate: add((f) => f.estimated.from_project_rate),
      value: money((f) => f.estimated.value),
    },
    no_basis: { sessions: add((f) => f.no_basis.sessions), hours: add((f) => f.no_basis.hours) },
    expected_value: money((f) => f.expected_value),
    deposits_paid: money((f) => f.deposits_paid),
    remaining_after_deposits: money((f) => f.remaining_after_deposits),
  };
}

function sumFinance(blocks: Array<StatisticsFinanceBlock | null>): StatisticsFinanceBlock | null {
  // Money is combined only when every artist returned it. A total that
  // silently leaves out the artists the viewer may not see money for would
  // read as a studio total while the counts beside it cover everyone.
  if (blocks.length === 0 || blocks.some((block) => block === null)) return null;
  const present = blocks as StatisticsFinanceBlock[];
  return {
    received: sumMoney(present.map((block) => block.received)),
    refunded: sumMoney(present.map((block) => block.refunded)),
    open: sumMoney(present.map((block) => block.open)),
    partially_paid: present.reduce((total, block) => total + block.partially_paid, 0),
    forecast: sumForecast(present.map((block) => block.forecast)),
    deposits_paid_by_channel: sumRecord(present.map((block) => block.deposits_paid_by_channel)),
  };
}

/** Counts summed across artists. Medians are not combinable and are null. */
export function combineCores(cores: StatisticsCore[]): StatisticsCore {
  const add = (pick: (core: StatisticsCore) => number) => cores.reduce((total, core) => total + (Number(pick(core)) || 0), 0);
  const single = cores.length === 1 ? cores[0] : null;
  return {
    enquiries: add((core) => core.enquiries),
    unique_clients: add((core) => core.unique_clients),
    discovery: sumRecord(cores.map((core) => core.discovery)),
    bookings_made: {
      tattoo: add((core) => core.bookings_made.tattoo),
      tattoo_cancelled: add((core) => core.bookings_made.tattoo_cancelled),
      consultations: add((core) => core.bookings_made.consultations),
    },
    conversion: {
      cohort: add((core) => core.conversion.cohort),
      mature: add((core) => core.conversion.mature),
      converted: add((core) => core.conversion.converted),
      pending: add((core) => core.conversion.pending),
      pending_converted: add((core) => core.conversion.pending_converted),
      median_days_to_booking: single?.conversion.median_days_to_booking ?? null,
    },
    funnel: {
      enquiries: add((core) => core.funnel.enquiries),
      answered: add((core) => core.funnel.answered),
      consultations: add((core) => core.funnel.consultations),
      booked: add((core) => core.funnel.booked),
      completed: add((core) => core.funnel.completed),
    },
    reply: {
      median_first_reply_hours: single?.reply.median_first_reply_hours ?? null,
      timed: add((core) => core.reply.timed),
      answered_without_time: add((core) => core.reply.answered_without_time),
      unanswered: add((core) => core.reply.unanswered),
    },
    channels: sumChannels(cores.map((core) => core.channels)),
    sessions: {
      booked: add((core) => core.sessions.booked),
      completed: add((core) => core.sessions.completed),
      planned: add((core) => core.sessions.planned),
      cancelled: add((core) => core.sessions.cancelled),
      no_show: add((core) => core.sessions.no_show),
      hours: add((core) => core.sessions.hours),
      consultations_held: add((core) => core.sessions.consultations_held),
      consultations_no_show: add((core) => core.sessions.consultations_no_show),
      consultations_unverified: add((core) => core.sessions.consultations_unverified),
      consultations_cancelled: add((core) => core.sessions.consultations_cancelled),
    },
    consultations_awaiting_outcome: add((core) => core.consultations_awaiting_outcome),
    returning_clients: {
      active: add((core) => core.returning_clients.active),
      returning: add((core) => core.returning_clients.returning),
    },
    upcoming: {
      weeks: sumWeeks(cores.map((core) => core.upcoming.weeks)),
      tattoo_sessions_later: add((core) => core.upcoming.tattoo_sessions_later),
    },
    finance: sumFinance(cores.map((core) => core.finance)),
  };
}

export function conversionRate(core: StatisticsCore): number | null {
  return core.conversion.mature === 0 ? null : (core.conversion.converted / core.conversion.mature) * 100;
}

/**
 * When reply evidence became complete: WhatsApp phone-app echoes from
 * 2026-09-28, Gmail SENT from 2026-10-04 (20261004090000). Before it, a reply
 * the CRM never saw reads as "no reply", so "unanswered" is only stated for a
 * period that starts on or after this instant.
 */
export const REPLY_EVIDENCE_COMPLETE_FROM = '2026-10-04T00:00:00Z';

export function replyEvidenceComplete(periodFrom: string): boolean {
  return Date.parse(periodFrom) >= Date.parse(REPLY_EVIDENCE_COMPLETE_FROM);
}

export interface AttentionItem {
  id: 'unanswered' | 'emptyWeeks' | 'channelNoBookings' | 'openPayments' | 'consultationsAwaitingOutcome';
  params: Record<string, string | number>;
  target: string;
}

export interface Insight {
  id: string;
  params: Record<string, string | number>;
  tone: 'neutral' | 'good' | 'bad';
}

export const INSIGHT_MINIMUMS = { enquiryTrend: 5, conversionTrend: 8, channel: 8 } as const;

export interface StatisticsOverview {
  artistCount: number;
  comparable: boolean;
  current: StatisticsCore;
  previous: StatisticsCore;
  /** Per-artist medians, because medians do not combine. */
  replyMedians: Array<{ artistId: string; hours: number | null }>;
  bookingMedians: Array<{ artistId: string; days: number | null }>;
  /** False when the period starts before reply evidence was complete. */
  replyCoverage: boolean;
  enquiries: Delta;
  bookings: Delta;
  completed: Delta;
  conversion: number | null;
  conversionDelta: Delta | null;
  attention: AttentionItem[];
  insights: Insight[];
}

/**
 * Everything the screen renders from one get_statistics answer.
 * `channelLabel` resolves a channel to the words the reader sees.
 */
export function buildOverview(
  result: StatisticsResult,
  channelLabel: (row: StatisticsChannelRow) => string,
): StatisticsOverview {
  const artists: StatisticsArtistResult[] = result.artists ?? [];
  const current = combineCores(artists.map((artist) => artist.current));
  const previous = combineCores(artists.map((artist) => artist.previous));
  // Comparable only when every artist's history covers the previous window.
  const comparable = artists.length > 0 && artists.every((artist) => artist.comparable);
  const conversion = conversionRate(current);
  const previousConversion = conversionRate(previous);
  const enquiries = delta(current.enquiries, previous.enquiries);

  const replyCoverage = replyEvidenceComplete(result.from);
  const attention: AttentionItem[] = [];
  if (replyCoverage && current.reply.unanswered > 0) {
    attention.push({ id: 'unanswered', params: { count: current.reply.unanswered }, target: '/inbox' });
  }
  // Empty weeks in the next eight, counting from next week: this week is
  // already half gone and says little.
  const nextEight = current.upcoming.weeks.slice(1, 9);
  const empty = nextEight.filter((week) => week.tattoo_sessions === 0);
  if (empty.length > 0) {
    attention.push({
      id: 'emptyWeeks',
      params: { count: empty.length, first: empty[0].week_start },
      target: '/appointments',
    });
  }
  for (const channel of current.channels) {
    if (['direct', 'manual', 'internal'].includes(channel.kind)) continue;
    if (channel.matured >= INSIGHT_MINIMUMS.channel && channel.matured_booked === 0) {
      attention.push({
        id: 'channelNoBookings',
        params: { channel: channelLabel(channel), enquiries: channel.matured },
        target: '#stats-channels',
      });
    }
  }
  if (current.consultations_awaiting_outcome > 0) {
    attention.push({
      id: 'consultationsAwaitingOutcome',
      params: { count: current.consultations_awaiting_outcome },
      target: '/appointments#consultation-outcomes',
    });
  }
  const openCount = current.finance?.open.reduce((total, entry) => total + (entry.count ?? 0), 0) ?? 0;
  if (openCount > 0) {
    attention.push({ id: 'openPayments', params: { count: openCount }, target: '/payments' });
  }

  const insights: Insight[] = [];
  if (
    comparable
    && enquiries.current >= INSIGHT_MINIMUMS.enquiryTrend
    && enquiries.previous >= INSIGHT_MINIMUMS.enquiryTrend
    && enquiries.percent !== null
    && Math.abs(enquiries.percent) >= 10
  ) {
    insights.push({
      id: enquiries.percent > 0 ? 'insight.enquiriesUp' : 'insight.enquiriesDown',
      params: { percent: Math.abs(Math.round(enquiries.percent)) },
      tone: enquiries.percent > 0 ? 'good' : 'bad',
    });
  }
  if (
    comparable
    && conversion !== null
    && previousConversion !== null
    && current.conversion.mature >= INSIGHT_MINIMUMS.conversionTrend
    && previous.conversion.mature >= INSIGHT_MINIMUMS.conversionTrend
    && Math.abs(conversion - previousConversion) >= 5
  ) {
    insights.push({
      id: conversion > previousConversion ? 'insight.conversionUp' : 'insight.conversionDown',
      params: { from: Math.round(previousConversion), to: Math.round(conversion), mature: current.conversion.mature },
      tone: conversion > previousConversion ? 'good' : 'bad',
    });
  }

  return {
    artistCount: artists.length,
    comparable,
    current,
    previous,
    replyMedians: artists.map((artist) => ({
      artistId: artist.artist_id,
      hours: artist.current.reply.median_first_reply_hours,
    })),
    bookingMedians: artists.map((artist) => ({
      artistId: artist.artist_id,
      days: artist.current.conversion.median_days_to_booking,
    })),
    replyCoverage,
    enquiries,
    bookings: delta(current.bookings_made.tattoo, previous.bookings_made.tattoo),
    completed: delta(current.sessions.completed, previous.sessions.completed),
    conversion,
    conversionDelta: rateDelta(conversion, previousConversion),
    attention,
    insights,
  };
}
