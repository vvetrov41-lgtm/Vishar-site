import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';

// Any active artist slug is a valid connector alias. The shape mirrors the
// `artists_slug_shape` database constraint, so the CRM rejects a row the
// database could never have produced without carrying its own artist list.
export type CalendarConnectorAlias = string;

export interface CalendarConnectionStatus {
  artist_id: string;
  artist_slug: CalendarConnectorAlias;
  artist_display_name: string;
  provider: 'google';
  integration_key: string;
  connected: boolean;
  external_account_label: string | null;
  connection_updated_at: string | null;
  last_successful_sync_at: string | null;
  queued_jobs: number;
  retrying_jobs: number;
  failed_jobs: number;
  last_error_code: string | null;
}

const ARTIST_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_CONNECTIONS = 500;

function invalidResponse(): ApiError {
  return new ApiError(apiMessage('Could not load calendar connections. Please try again.'));
}

function oauthStartFailure(): ApiError {
  return new ApiError(apiMessage('The authorization decision could not be completed.'));
}

export function isCalendarConnectorAlias(value: unknown): value is CalendarConnectorAlias {
  return typeof value === 'string' && ARTIST_SLUG_PATTERN.test(value);
}

export function calendarIntegrationKey(alias: CalendarConnectorAlias): string {
  return `google_calendar_${alias}`;
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
    || !isCalendarConnectorAlias(row.artist_slug)
    || typeof row.artist_display_name !== 'string'
    || row.artist_display_name.trim().length === 0
    || row.provider !== 'google'
    || row.integration_key !== calendarIntegrationKey(row.artist_slug)
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
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) throw invalidResponse();
  const rows = value.map(validateRow);
  const aliases = new Set(rows.map((row) => row.artist_slug));
  const artistIds = new Set(rows.map((row) => row.artist_id));
  if (aliases.size !== rows.length || artistIds.size !== rows.length) throw invalidResponse();
  return rows;
}

function connectorStartUrl(origin: string, alias: CalendarConnectorAlias): string {
  if (!origin) throw new ApiError(apiMessage('The CRM is not configured.'));
  if (!isCalendarConnectorAlias(alias)) throw oauthStartFailure();
  return `${origin}/oauth/google/start/${alias}`;
}

function validatedAuthorizeUrl(value: unknown): string {
  if (typeof value !== 'string') throw oauthStartFailure();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw oauthStartFailure();
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') {
    throw oauthStartFailure();
  }
  return parsed.toString();
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

    async beginCalendarOAuth(connectorOrigin: string, alias: CalendarConnectorAlias): Promise<string> {
      const session = await client.auth.getSession();
      const accessToken = session.data?.session?.access_token;
      if (!accessToken) throw new ApiError(apiMessage('Your session has expired. Sign in again.'));
      const response = await fetch(connectorStartUrl(connectorOrigin, alias), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const payload = await response.json().catch(() => null) as { authorize_url?: unknown; code?: unknown } | null;
      if (!response.ok) {
        if (payload?.code === 'calendar_session_required') {
          throw new ApiError(apiMessage('Your session has expired. Sign in again.'));
        }
        throw oauthStartFailure();
      }
      return validatedAuthorizeUrl(payload?.authorize_url);
    },

    // Clears the Google account the backend pinned for this artist so a
    // different account can be authorised. The database refuses while the
    // integration is still enabled.
    async resetCalendarExpectedAccount(artistId: string): Promise<void> {
      const result = await client.rpc('reset_calendar_expected_account', {
        p_artist_id: artistId,
      });
      if (result.error) {
        throw new ApiError(
          friendlyMessage(result.error, 'clear the recorded Google account'),
          result.error,
        );
      }
    },
  };
}

export type CalendarConnectionsApi = ReturnType<typeof createCalendarConnectionsApi>;

export const __testing = {
  validateRow,
  validateResult,
  connectorStartUrl,
  validatedAuthorizeUrl,
  MAX_CONNECTIONS,
};
