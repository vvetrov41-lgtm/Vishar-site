import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

function invalidResponse(): ApiError {
  return new ApiError(apiMessage('Could not load calendar connections. Please try again.'));
}

function isAlias(value: unknown): value is CalendarConnectorAlias {
  return value === 'vladimir' || value === 'kristina';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableDate(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateRow(value: unknown): CalendarConnectionStatus {
  if (!value || typeof value !== 'object') throw invalidResponse();
  const row = value as Record<string, unknown>;
  if (
    typeof row.artist_id !== 'string'
    || !UUID_PATTERN.test(row.artist_id)
    || !isAlias(row.artist_slug)
    || typeof row.artist_display_name !== 'string'
    || row.artist_display_name.trim().length === 0
    || row.provider !== 'google'
    || row.integration_key !== EXPECTED_KEYS[row.artist_slug]
    || typeof row.connected !== 'boolean'
    || !isNullableString(row.external_account_label)
    || !isNullableDate(row.connection_updated_at)
    || !isNullableDate(row.last_successful_sync_at)
    || !isCount(row.queued_jobs)
    || !isCount(row.retrying_jobs)
    || !isCount(row.failed_jobs)
    || !(row.last_error_code === null
      || (typeof row.last_error_code === 'string' && SAFE_ERROR_PATTERN.test(row.last_error_code)))
  ) {
    throw invalidResponse();
  }
  return row as unknown as CalendarConnectionStatus;
}

function validateResult(value: unknown): CalendarConnectionStatus[] {
  if (!Array.isArray(value) || value.length > 2) throw invalidResponse();
  const rows = value.map(validateRow);
  const aliases = new Set(rows.map((row) => row.artist_slug));
  const artistIds = new Set(rows.map((row) => row.artist_id));
  if (aliases.size !== rows.length || artistIds.size !== rows.length) throw invalidResponse();
  return rows;
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
      return validateResult(result.data);
    },
  };
}

export type CalendarConnectionsApi = ReturnType<typeof createCalendarConnectionsApi>;

export const __testing = { validateRow, validateResult };
