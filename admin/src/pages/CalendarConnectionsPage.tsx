import { useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import {
  isCalendarConnectorAlias,
  type CalendarConnectionStatus,
  type CalendarConnectorAlias,
} from '../lib/calendar-connections-api';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { canShowArtistIntegration } from '../lib/integration-visibility';
import { operationalLabel } from '../lib/operational-labels';
import { useApi, useSession } from '../lib/session';
import { readCalendarConnectorOrigin } from '../lib/supabase';

const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
const CONNECTOR_ORIGIN = readCalendarConnectorOrigin(browserEnv, import.meta.env.DEV);

const RECONNECT_ERROR_CODES = new Set([
  'calendar_oauth_expired',
  'calendar_scope_missing',
  'calendar_token_invalid',
  'google_account_mismatch',
  'google_contacts_permission_denied',
  'google_contacts_scope_missing',
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
  if (!isCalendarConnectorAlias(alias)) throw new Error('Unknown calendar artist.');
  return `${connectorOrigin}/oauth/google/${action}/${alias}`;
}

export function connectionResultNotice(
  search: string,
  language: Language,
  visibleArtists?: ReadonlyMap<string, string>,
): string | null {
  const params = new URLSearchParams(search);
  const result = params.get('calendar');
  const artist = params.get('artist');
  if (!artist || !isCalendarConnectorAlias(artist) || !result) return null;
  const name = visibleArtists?.get(artist);
  if (!name) return null;
  if (result === 'connected') {
    return language === 'ru'
      ? `Google для ${name} подключён. Calendar и Contacts разрешения активированы.`
      : `${name}’s Google account is connected. Calendar and Contacts permissions are enabled.`;
  }
  if (result === 'disconnected') {
    return language === 'ru'
      ? `Google для ${name} отключён. Автосохранение WhatsApp-клиентов в Contacts остановлено.`
      : `${name}’s Google account is disconnected. Automatic WhatsApp-client saving to Contacts is stopped.`;
  }
  return null;
}

export function calendarConnectionHealth(
  connection: Pick<CalendarConnectionStatus, 'connected' | 'failed_jobs' | 'last_error_code'>,
): CalendarConnectionHealth {
  if (connection.last_error_code && RECONNECT_ERROR_CODES.has(connection.last_error_code)) return 'reconnect';
  if (connection.failed_jobs > 0 || connection.last_error_code) return 'attention';
  return connection.connected ? 'connected' : 'disconnected';
}

export function CalendarConnectionsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const { data, loading, error, reload } = useAsync(async () => {
    const connections = await api.listCalendarConnectionStatus();
    return connections.filter((connection) => canShowArtistIntegration(
      profile,
      { id: connection.artist_id, slug: connection.artist_slug, display_name: connection.artist_display_name },
      memberships,
    ));
  }, [api, memberships, profile]);
  const visibleArtists = useMemo(
    () => new Map((data ?? []).map((connection) => [connection.artist_slug, connection.artist_display_name])),
    [data],
  );
  const resultNotice = useMemo(
    () => connectionResultNotice(window.location.search, language, visibleArtists),
    [language, visibleArtists],
  );

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) return <EmptyState title={copy.noneTitle} hint={copy.noneHint} />;

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
            onReload={reload}
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
  onReload,
}: {
  connection: CalendarConnectionStatus;
  language: Language;
  connectorOrigin: string;
  onReload: () => void;
}) {
  const api = useApi();
  const copy = COPY[language];
  const [clearing, setClearing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
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
      <div className="title" id={`calendar-${connection.artist_slug}`}>{connection.artist_display_name}</div>
      <div className="meta">
        <span className={statusClass}>{status}</span>{' '}
        <span className="badge">Google Calendar + Contacts</span>
      </div>

      <dl className="details" style={{ marginTop: 12 }}>
        <div><dt>{copy.account}</dt><dd>{connection.external_account_label ?? copy.noAccount}</dd></div>
        <div><dt>{copy.connectionUpdated}</dt><dd>{formatOptionalDate(connection.connection_updated_at, language)}</dd></div>
        <div><dt>{copy.lastSuccessfulSync}</dt><dd>{formatOptionalDate(connection.last_successful_sync_at, language)}</dd></div>
        <div>
          <dt>{copy.queue}</dt>
          <dd>{copy.queueValue
            .replace('{queued}', String(connection.queued_jobs))
            .replace('{retrying}', String(connection.retrying_jobs))
            .replace('{failed}', String(connection.failed_jobs))}</dd>
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
            disabled={connecting}
            onClick={async () => {
              setConnectError(null);
              setConnecting(true);
              try {
                const authorizeUrl = await api.beginCalendarOAuth(connectorOrigin, connection.artist_slug);
                window.location.assign(authorizeUrl);
              } catch (error) {
                setConnectError(error instanceof Error ? error.message : copy.connectFailed);
                setConnecting(false);
              }
            }}
            aria-label={`${startLabel}: ${connection.artist_display_name}`}
          >
            {connecting ? copy.connecting : startLabel}
          </button>
          {connection.connected ? (
            <button
              type="button"
              className="danger"
              onClick={() => window.location.assign(calendarConnectorUrl(connectorOrigin, 'disconnect', connection.artist_slug))}
              aria-label={`${copy.disconnect}: ${connection.artist_display_name}`}
            >
              {copy.disconnect}
            </button>
          ) : null}
          {!connection.connected && connection.external_account_label ? (
            <button
              type="button"
              disabled={clearing}
              onClick={async () => {
                setClearError(null);
                setClearing(true);
                try {
                  await api.resetCalendarExpectedAccount(connection.artist_id);
                  onReload();
                } catch (error) {
                  setClearError(error instanceof Error ? error.message : copy.changeAccountFailed);
                } finally {
                  setClearing(false);
                }
              }}
              aria-label={`${copy.changeAccount}: ${connection.artist_display_name}`}
            >
              {copy.changeAccount}
            </button>
          ) : null}
        </div>
      ) : null}
      {connectError ? <p className="notice warn" role="alert">{connectError}</p> : null}
      {clearError ? <p className="notice warn" role="alert">{clearError}</p> : null}
    </section>
  );
}

function formatOptionalDate(value: string | null, language: Language): string {
  return value ? formatDateTime(value, language) : '—';
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    title: 'Google connections', loading: 'Loading Google connections…',
    noneTitle: 'No Google connections are available',
    noneHint: 'Your current artist memberships do not allow integration management.',
    intro: 'Each artist can connect their own Google account for Calendar and Contacts. Once authorised, CRM can save a linked WhatsApp client to Google Contacts using only the client name, phone number and optional email. Provider credentials stay server-side.',
    connectorDisabled: 'Google connection controls are disabled in this environment. Existing CRM metadata remains read-only.',
    securityNotice: 'Connect uses your current CRM session and then opens Google for explicit Calendar and Contacts consent. Automatic contact saving runs only after CRM has linked the WhatsApp conversation to a client. Disconnect stops both Google projections.',
    connected: 'Connected', disconnected: 'Not connected', attentionRequired: 'Attention required', reconnectRequired: 'Reconnect required',
    connect: 'Connect Google', reconnect: 'Reconnect Google', connecting: 'Opening Google…', connectFailed: 'Could not start the Google connection.',
    disconnect: 'Disconnect', changeAccount: 'Change Google account', changeAccountFailed: 'Could not clear the recorded Google account.',
    account: 'Google account', noAccount: 'No connected account', connectionUpdated: 'Connection metadata updated',
    lastSuccessfulSync: 'Last successful calendar sync', queue: 'Calendar queue', queueValue: '{queued} queued · {retrying} retrying · {failed} failed',
    lastError: 'Last current error', noError: 'No current error',
  },
  ru: {
    title: 'Подключения Google', loading: 'Загрузка подключений Google…',
    noneTitle: 'Нет доступных подключений Google', noneHint: 'Твои текущие права на мастеров не разрешают управление интеграциями.',
    intro: 'Каждый мастер может подключить свой Google-аккаунт для Calendar и Contacts. После разрешения CRM сможет сохранять linked WhatsApp-клиента в Google Contacts, передавая только имя, номер телефона и при наличии email. Данные доступа остаются только на сервере.',
    connectorDisabled: 'Управление подключением Google отключено в этом окружении. Существующие метаданные CRM доступны только для просмотра.',
    securityNotice: 'Подключение проверяет текущую CRM-сессию и открывает Google для явного разрешения Calendar и Contacts. Автосохранение контакта запускается только после того, как CRM связала WhatsApp-диалог с клиентом. Отключение останавливает обе Google-интеграции.',
    connected: 'Подключён', disconnected: 'Не подключён', attentionRequired: 'Требует внимания', reconnectRequired: 'Нужно переподключить',
    connect: 'Подключить Google', reconnect: 'Переподключить Google', connecting: 'Открываю Google…', connectFailed: 'Не удалось начать подключение Google.',
    disconnect: 'Отключить', changeAccount: 'Сменить Google-аккаунт', changeAccountFailed: 'Не удалось очистить записанный Google-аккаунт.',
    account: 'Google-аккаунт', noAccount: 'Аккаунт не подключён', connectionUpdated: 'Метаданные подключения обновлены',
    lastSuccessfulSync: 'Последняя успешная синхронизация календаря', queue: 'Очередь календаря', queueValue: 'в очереди: {queued} · повтор: {retrying} · ошибок: {failed}',
    lastError: 'Последняя текущая ошибка', noError: 'Текущих ошибок нет',
  },
};