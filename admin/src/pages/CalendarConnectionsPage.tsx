import { useMemo } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import type {
  CalendarConnectionStatus,
  CalendarConnectorAlias,
} from '../lib/calendar-connections-api';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { useApi } from '../lib/session';

const CONNECTOR_ORIGIN = 'https://calendar-staging.vishartattoo.com';

export function calendarConnectorUrl(
  action: 'start' | 'disconnect',
  alias: CalendarConnectorAlias,
): string {
  return `${CONNECTOR_ORIGIN}/oauth/google/${action}/${alias}`;
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
        {resultNotice ? <p className="notice ok" role="status">{resultNotice}</p> : null}
      </Section>

      <div className="list" aria-label={copy.title}>
        {data.map((connection) => (
          <ConnectionCard key={connection.artist_id} connection={connection} language={language} />
        ))}
      </div>

      <p className="notice">{copy.securityNotice}</p>
    </>
  );
}

function ConnectionCard({
  connection,
  language,
}: {
  connection: CalendarConnectionStatus;
  language: Language;
}) {
  const copy = COPY[language];
  const reconnectRequired = connection.last_error_code === 'google_token_revoked'
    || connection.last_error_code === 'google_refresh_invalid_grant'
    || connection.last_error_code === 'google_account_mismatch';
  const status = reconnectRequired
    ? copy.reconnectRequired
    : connection.connected
      ? copy.connected
      : copy.disconnected;
  const statusClass = reconnectRequired || connection.failed_jobs > 0
    ? 'badge warn'
    : connection.connected
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
          <dd>{connection.last_error_code ?? copy.noError}</dd>
        </div>
      </dl>

      <div className="actions">
        <button
          type="button"
          onClick={() => window.location.assign(calendarConnectorUrl('start', connection.artist_slug))}
          aria-label={`${startLabel}: ${connection.artist_display_name}`}
        >
          {startLabel}
        </button>
        {connection.connected ? (
          <button
            type="button"
            className="danger"
            onClick={() => window.location.assign(calendarConnectorUrl('disconnect', connection.artist_slug))}
            aria-label={`${copy.disconnect}: ${connection.artist_display_name}`}
          >
            {copy.disconnect}
          </button>
        ) : null}
      </div>
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
    securityNotice: 'Connect and disconnect use a top-level navigation through the Access-protected Calendar connector. Query parameters only display a notice; Supabase remains the source of truth.',
    connected: 'Connected',
    disconnected: 'Not connected',
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
    lastError: 'Last safe error code',
    noError: 'No current error',
  },
  ru: {
    title: 'Подключения календаря',
    loading: 'Загрузка подключений календаря…',
    noneTitle: 'Нет доступных подключений календаря',
    noneHint: 'Ваши текущие права на мастеров не разрешают управление интеграциями.',
    intro: 'Владимир и Кристина используют отдельные Google-аккаунты, зашифрованные token envelopes и основные календари. CRM не получает данные доступа провайдера.',
    securityNotice: 'Подключение и отключение открываются отдельной страницей через Calendar connector, защищённый Access. Параметры URL показывают только уведомление; источником истины остаётся Supabase.',
    connected: 'Подключён',
    disconnected: 'Не подключён',
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
    lastError: 'Последний безопасный код ошибки',
    noError: 'Текущих ошибок нет',
  },
};
