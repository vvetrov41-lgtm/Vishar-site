import { ApiError, friendlyMessage, type CrmClient } from './api';

export type CalendarConnectorAlias = 'vladimir' | 'kristina';

export interface CalendarConnectionStatus {
  artist_id: string;
  artist_slug: CalendarConnectorAlias;
  artist_display_name: string;
  provider: 'google';
  integration_key: 'google_calendar_vladimir' | 'google_calendar_kristina';
  connected: boolean;
  external_account_label: string | null;
  connection_updated_at: string | null;
  last_successful_sync_at: string | null;
  queued_jobs: number;
  retrying_jobs: number;
  failed_jobs: number;
  last_error_code: string | null;
}

const EXPECTED_KEYS: Record<CalendarConnectorAlias, CalendarConnectionStatus['integration_key']> = {
  vladimir: 'google_calendar_vladimir',
  kristina: 'google_calendar_kristina',
};

function isAlias(value: unknown): value is CalendarConnectorAlias {
  return value === 'vladimir' || value === 'kristina';
}

function validateRow(value: unknown): CalendarConnectionStatus {
  if (!value || typeof value !== 'object') throw new ApiError('Could not load calendar connections. Please try again.');
  const row = value as Record<string, unknown>;
  if (
    typeof row.artist_id !== 'string'
    || !isAlias(row.artist_slug)
    || typeof row.artist_display_name !== 'string'
    || row.provider !== 'google'
    || row.integration_key !== EXPECTED_KEYS[row.artist_slug]
    || typeof row.connected !== 'boolean'
    || !Number.isInteger(row.queued_jobs)
    || !Number.isInteger(row.retrying_jobs)
    || !Number.isInteger(row.failed_jobs)
  ) {
    throw new ApiError('Could not load calendar connections. Please try again.');
  }
  return row as unknown as CalendarConnectionStatus;
}

export function createCalendarConnectionsApi(client: CrmClient) {
  return {
    async listCalendarConnectionStatus(): Promise<CalendarConnectionStatus[]> {
      const result = await client.rpc('list_calendar_connection_status');
      if (result.error) {
        throw new ApiError(
          friendlyMessage(result.error, 'load calendar connections'),
          result.error,
        );
      }
      if (!Array.isArray(result.data)) return [];
      return result.data.map(validateRow);
    },
  };
}

export type CalendarConnectionsApi = ReturnType<typeof createCalendarConnectionsApi>;

export const __testing = { validateRow };
