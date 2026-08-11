import { useMemo } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import type {
  CalendarConnectionStatus,
  CalendarConnectorAlias,
} from '../lib/calendar-connections-api';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { operationalLabel } from '../lib/operational-labels';
import { useApi } from '../lib/session';
import { readCalendarConnectorOrigin } from '../lib/supabase';

const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
const CONNECTOR_ORIGIN = readCalendarConnectorOrigin(browserEnv, import.meta.env.DEV);

const RECONNECT_ERROR_CODES = new Set([
  'calendar_oauth_expired',
  'calendar_scope_missing',
  'calendar_token_invalid',
  'google_account_mismatch',
  'google_refresh_invalid_grant',
  'google_token_revoked',
]);

export type CalendarConnectionHealth = 'connected' | 'disconnected' | 'attention' | 'reconnect';

export function calendarConnectorUrl(
  connectorOrigin: string,
  action: 'start' | 'disconnect',
  alias: CalendarConnectorAlias,
): string {
  if (!connectorOrigin) throw new Error('Calendar connector is not configured.');
  return `${connectorOrigin}/oauth/google/${action}/${alias}`;
}

export function connectionResultNotice(search: string, language: Language): string | null {
  const params = new URLSearchParams(search);
  const result = params.get('calendar');
  const artist = params.get('artist');
  if ((artist !== 'vladimir' && artist !== 'kristina') || !result) return null;
  const name = artist === 'vladimir' ? 'Vladimir' : 'Kristina';
  if (result === 'connected') {
    return language === 'ru'
      ? `Google Calendar для ${name} подключён. Статус ниже повторно загружен из CRM.`
      : `${name}’s Google Calendar is connected. The status below was reloaded from the CRM.`;
  }
  if (result === 'disconnected') {
    return language === 'ru'
      ? `Google Calendar для ${name} отключён. Статус ниже повторно загружен из CRM.`
      : `${name}’s Google Calendar is disconnected. The status below was reloaded from the CRM.`;
  }
  return null;
}

export function calendarConnectionHealth(
  connection: Pick<CalendarConnectionStatus, 'connected' | 'failed_jobs' | 'last_error_code'>,
): CalendarConnectionHealth {
  if (connection.last_error_code && RECONNECT_ERROR_CODES.has(connection.last_error_code)) {
    return 'reconnect';
  }
  if (connection.failed_jobs > 0 || connection.last_error_code) return 'attention';
  return connection.connected ? 'connected' : 'disconnected';
}

export function CalendarConnectionsPage() {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const { data, loading, error, reload } = useAsync(
    () => api.listCalendarConnectionStatus(),
    [api],
  );
  const resultNotice = useMemo(
    () => connectionResultNotice(window.location.search, language),
    [language],
  );

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) {
    return <EmptyState title={copy.noneTitle} hint={copy.noneHint} />;
  }

  return (
    <>
      <Section title={copy.title}>
        <p className="notice">{copy.intro}</p>
        {!CONNECTOR_ORIGIN ? <p className="notice">{copy.connectorDisabled}</p> : null}
        {resultNotice ? <p className="notice ok" role="status">{resultNotice}</p> : null}
      </Section>

      <div className="list" aria-label={copy.title}>
        {data.map((connection) => (
          <ConnectionCard
            key={connection.artist_id}
            connection={connection}
            language={language}
            connectorOrigin={CONNECTOR_ORIGIN}
          />
        ))}
      </div>

      <p className="notice">{copy.securityNotice}</p>
    </>
  );
}

function ConnectionCard({
  connection,
  language,
  connectorOrigin,
}: {
  connection: CalendarConnectionStatus;
  language: Language;
  connectorOrigin: string;
}) {
  const copy = COPY[language];
  const health = calendarConnectionHealth(connection);
  const status = health === 'reconnect'
    ? copy.reconnectRequired
    : health === 'attention'
      ? copy.attentionRequired
      : health === 'connected'
        ? copy.connected
        : copy.disconnected;
  const statusClass = health === 'reconnect' || health === 'attention'
    ? 'badge warn'
    : health === 'connected'
      ? 'badge ok'
      : 'badge';
  const startLabel = connection.connected ? copy.reconnect : copy.connect;

  return (
    <section className="row" aria-labelledby={`calendar-${connection.artist_slug}`}>
      <div className="title" id={`calendar-${connection.artist_slug}`}>
        {connection.artist_display_name}
      </div>
      <div className="meta">
        <span className={statusClass}>{status}</span>{' '}
        <span className="badge">Google Calendar</span>
      </div>

      <dl className="details" style={{ marginTop: 12 }}>
        <div>
          <dt>{copy.account}</dt>
          <dd>{connection.external_account_label ?? copy.noAccount}</dd>
        </div>
        <div>
          <dt>{copy.connectionUpdated}</dt>
          <dd>{formatOptionalDate(connection.connection_updated_at, language)}</dd>
        </div>
        <div>
          <dt>{copy.lastSuccessfulSync}</dt>
          <dd>{formatOptionalDate(connection.last_successful_sync_at, language)}</dd>
        </div>
        <div>
          <dt>{copy.queue}</dt>
          <dd>
            {copy.queueValue
              .replace('{queued}', String(connection.queued_jobs))
              .replace('{retrying}', String(connection.retrying_jobs))
              .replace('{failed}', String(connection.failed_jobs))}
          </dd>
        </div>
        <div>
          <dt>{copy.lastError}</dt>
          <dd>{connection.last_error_code
            ? operationalLabel(language, 'integrationError', connection.last_error_code)
            : copy.noError}</dd>
        </div>
      </dl>

      {connectorOrigin ? (
        <div className="actions">
          <button
            type="button"
            onClick={() => window.location.assign(
              calendarConnectorUrl(connectorOrigin, 'start', connection.artist_slug)
            )}
            aria-label={`${startLabel}: ${connection.artist_display_name}`}
          >
            {startLabel}
          </button>
          {connection.connected ? (
            <button
              type="button"
              className="danger"
              onClick={() => window.location.assign(
                calendarConnectorUrl(connectorOrigin, 'disconnect', connection.artist_slug)
              )}
              aria-label={`${copy.disconnect}: ${connection.artist_display_name}`}
            >
              {copy.disconnect}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function formatOptionalDate(value: string | null, language: Language): string {
  return value ? formatDateTime(value, language) : '—';
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Calendar connections',
    loading: 'Loading calendar connections…',
    noneTitle: 'No calendar connections are available',
    noneHint: 'Your current artist memberships do not allow integration management.',
    intro: 'Vladimir and Kristina use separate Google accounts, encrypted token envelopes and primary calendars. The CRM never receives provider credentials.',
    connectorDisabled: 'Calendar connection controls are disabled in this environment. Existing CRM metadata remains read-only.',
    securityNotice: 'Connect and disconnect use a top-level navigation through the Access-protected Calendar connector. Query parameters only display a notice; Supabase remains the source of truth.',
    connected: 'Connected',
    disconnected: 'Not connected',
    attentionRequired: 'Attention required',
    reconnectRequired: 'Reconnect required',
    connect: 'Connect',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    account: 'Google account',
    noAccount: 'No connected account',
    connectionUpdated: 'Connection metadata updated',
    lastSuccessfulSync: 'Last successful sync',
    queue: 'Calendar queue',
    queueValue: '{queued} queued · {retrying} retrying · {failed} failed',
    lastError: 'Last current error',
    noError: 'No current error',
  },
  ru: {
    title: 'Подключения календаря',
    loading: 'Загрузка подключений календаря…',
    noneTitle: 'Нет доступных подключений календаря',
    noneHint: 'Ваши текущие права на мастеров не разрешают управление интеграциями.',
    intro: 'Владимир и Кристина используют отдельные Google-аккаунты, зашифрованные token envelopes и основные календари. CRM не получает данные доступа провайдера.',
    connectorDisabled: 'Управление подключением календаря отключено в этом окружении. Существующие метаданные CRM доступны только для просмотра.',
    securityNotice: 'Подключение и отключение открываются отдельной страницей через Calendar connector, защищённый Access. Параметры URL показывают только уведомление; источником истины остаётся Supabase.',
    connected: 'Подключён',
    disconnected: 'Не подключён',
    attentionRequired: 'Требует внимания',
    reconnectRequired: 'Нужно переподключить',
    connect: 'Подключить',
    reconnect: 'Переподключить',
    disconnect: 'Отключить',
    account: 'Google-аккаунт',
    noAccount: 'Аккаунт не подключён',
    connectionUpdated: 'Метаданные подключения обновлены',
    lastSuccessfulSync: 'Последняя успешная синхронизация',
    queue: 'Очередь календаря',
    queueValue: 'в очереди: {queued} · повтор: {retrying} · ошибок: {failed}',
    lastError: 'Последняя текущая ошибка',
    noError: 'Текущих ошибок нет',
  },
};
