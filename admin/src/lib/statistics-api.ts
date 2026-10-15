// Reads for the Statistics screen: one call to public.get_statistics.
//
// Every figure is computed by crm_private.statistics_core on the server
// (supabase/migrations/20261015120000_statistics_core.sql), the same core
// gpt_get_statistics reads. The browser no longer pages raw enquiries,
// projects and sessions to count them.
//
// Access: get_statistics authorizes each artist with
// has_artist_capability(view) before reading, and includes money only where
// the caller holds view_finance. An artist id the caller may not view is an
// error. With no artist chosen the server answers for every artist the caller
// may view, one entry each; the screen combines counts, never rates.

import { ApiError, type CrmClient } from './api';
import { describeApiFailure } from './api-errors';
import { currentLanguage } from './i18n';
import type { ChannelKind, CurrencyAmount, Period } from './statistics';

export interface StatisticsChannelRow {
  key: string;
  kind: ChannelKind;
  value: string | null;
  enquiries: number;
  consulted: number;
  booked: number;
  matured: number;
  matured_booked: number;
}

export interface StatisticsWeek {
  /** Local Monday, `YYYY-MM-DD`, in the artist's timezone. */
  week_start: string;
  tattoo_sessions: number;
  tattoo_hours: number;
  consultations: number;
}

export interface StatisticsFinanceBlock {
  received: CurrencyAmount[];
  refunded: CurrencyAmount[];
  open: CurrencyAmount[];
  partially_paid: number;
  forecast: {
    confirmed_sessions: number;
    priced_sessions: number;
    booked_value: CurrencyAmount[];
    remaining_after_deposits: CurrencyAmount[];
  };
  deposits_paid_by_channel: Record<string, number>;
}

/** One window of crm_private.statistics_core, as JSON. */
export interface StatisticsCore {
  enquiries: number;
  unique_clients: number;
  discovery: Record<string, number>;
  bookings_made: { tattoo: number; tattoo_cancelled: number; consultations: number };
  conversion: {
    cohort: number;
    mature: number;
    converted: number;
    pending: number;
    pending_converted: number;
    median_days_to_booking: number | null;
  };
  funnel: { enquiries: number; answered: number; consultations: number; booked: number; completed: number };
  reply: {
    median_first_reply_hours: number | null;
    timed: number;
    answered_without_time: number;
    unanswered: number;
  };
  channels: StatisticsChannelRow[];
  sessions: {
    booked: number;
    completed: number;
    planned: number;
    cancelled: number;
    no_show: number;
    hours: number;
    consultations_held: number;
    consultations_cancelled: number;
  };
  returning_clients: { active: number; returning: number };
  upcoming: { weeks: StatisticsWeek[]; tattoo_sessions_later: number };
  /** null when the caller holds no finance access on the artist. */
  finance: StatisticsFinanceBlock | null;
}

export interface StatisticsArtistResult {
  artist_id: string;
  finance: boolean;
  history_start: string | null;
  /** The previous window lies inside the artist's recorded history. */
  comparable: boolean;
  current: StatisticsCore;
  previous: StatisticsCore;
}

export interface StatisticsResult {
  generated_at: string;
  from: string;
  to: string;
  previous_from: string;
  maturity_days: number;
  artists: StatisticsArtistResult[];
}

export interface StatisticsRequest {
  window: Period;
  artistId?: string;
}

export function createStatisticsApi(client: CrmClient) {
  return {
    async loadStatistics(request: StatisticsRequest): Promise<StatisticsResult> {
      const { data, error } = await client.rpc('get_statistics', {
        p_artist_ids: request.artistId ? [request.artistId] : null,
        p_from: request.window.from,
        p_to: request.window.to,
      });
      if (error) {
        throw new ApiError(describeApiFailure(error, 'load statistics', currentLanguage()), error);
      }
      return data as StatisticsResult;
    },
  };
}

export type StatisticsApi = ReturnType<typeof createStatisticsApi>;
