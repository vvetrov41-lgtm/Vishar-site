// What the calendar did with a booking, said in the operator's terms.
//
// Two pages carried a private copy of this function, and both ended a failed
// row with the raw drain code:
//
//   Calendar: failed: calendar_oauth_expired
//
// That is a worker-internal identifier. It is safe to show - the column is
// documented as a non-secret failure code - but it tells a tattoo artist
// nothing about whether the client's booking reached Google, or what to do
// about it. Every code the drain can record is mapped to the one thing the
// operator can act on, and the code itself no longer reaches the screen.

import type { Language } from './i18n';
import type { Appointment } from './appointment-api';

type Remedy =
  | 'reconnect'
  | 'notConnected'
  | 'accessDenied'
  | 'unavailable'
  | 'rejected'
  | 'eventMissing'
  | 'unknown';

// Sourced from workers/lib/calendar-drain.js and workers/lib/google-calendar.js.
// An unlisted code is not a defect here: it falls through to `unknown`, which
// still sends the operator to the one screen that can fix a calendar.
const REMEDIES: Record<string, Remedy> = {
  calendar_oauth_expired: 'reconnect',
  calendar_token_invalid: 'reconnect',
  calendar_scope_missing: 'reconnect',
  calendar_encryption_key_invalid: 'reconnect',
  google_account_mismatch: 'reconnect',
  calendar_provider_not_connected: 'notConnected',
  calendar_not_configured: 'notConnected',
  artist_route_unconfigured: 'notConnected',
  provider_route_invalid: 'notConnected',
  calendar_artist_access_denied: 'accessDenied',
  calendar_actor_authorization_failed: 'accessDenied',
  calendar_provider_unavailable: 'unavailable',
  calendar_provider_rejected: 'rejected',
  calendar_event_missing: 'eventMissing',
  calendar_event_not_found: 'eventMissing',
};

const STATUS: Record<Language, Record<Appointment['calendar_sync_status'], string>> = {
  en: {
    not_connected: 'not connected',
    queued: 'queued',
    synced: 'synced',
    retrying: 'retrying',
    failed: 'failed',
  },
  ru: {
    not_connected: 'не подключён',
    queued: 'в очереди',
    synced: 'синхронизирован',
    retrying: 'повторная попытка',
    failed: 'ошибка',
  },
};

const REMEDY_COPY: Record<Language, Record<Remedy, string>> = {
  en: {
    reconnect: 'reconnect the calendar in Integrations',
    notConnected: 'this artist has no calendar connected',
    accessDenied: 'that account cannot write to this calendar',
    unavailable: 'Google did not answer — it will try again',
    rejected: 'Google refused this change',
    eventMissing: 'the event is no longer in the calendar',
    unknown: 'check Calendar Connections in Integrations',
  },
  ru: {
    reconnect: 'переподключите календарь в разделе «Интеграции»',
    notConnected: 'у этого мастера не подключён календарь',
    accessDenied: 'у этого аккаунта нет прав на запись в календарь',
    unavailable: 'Google не ответил — попытка повторится',
    rejected: 'Google отклонил это изменение',
    eventMissing: 'этого события больше нет в календаре',
    unknown: 'проверьте подключения календаря в разделе «Интеграции»',
  },
};

/**
 * The whole sentence for one booking: the state, and - when it failed - what
 * the operator should do about it. The drain's error code never appears.
 */
export function calendarSyncLabel(
  appointment: Pick<Appointment, 'calendar_sync_status' | 'calendar_last_error_code'>,
  language: Language,
): string {
  const state = STATUS[language][appointment.calendar_sync_status];
  if (appointment.calendar_sync_status !== 'failed') return state;
  return `${state} — ${REMEDY_COPY[language][remedyFor(appointment.calendar_last_error_code)]}`;
}

export function remedyFor(code: string | null | undefined): Remedy {
  if (!code) return 'unknown';
  return REMEDIES[code] ?? 'unknown';
}
