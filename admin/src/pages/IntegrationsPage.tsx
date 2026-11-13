// The integrations hub.
//
// Provider connections and booking entry points share one administration hub.
// Safe status metadata comes from list_integration_status(); forms/websites
// have their own capability-scoped management RPCs and screen. Telegram is
// intentionally absent: all Telegram notification settings live on the
// Notifications page so users do not see two contradictory connection states.

import { useMemo } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { safeDeliveryErrorCode, splitDeliveryIssues } from '../lib/integration-issues';
import type { OutboxJob } from '../lib/types';
import { visibleIntegrationArtistIds } from '../lib/integration-visibility';
import {
  integrationHealth,
  type IntegrationChannel,
  type IntegrationHealth,
  type IntegrationStatus,
} from '../lib/platform-api';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';

const CHANNEL_ORDER: IntegrationChannel[] = [
  'calendar',
  'email',
  'whatsapp',
  'instagram',
  'payments',
  'gpt',
];

const CHANNEL_LABELS: Record<IntegrationChannel, { en: string; ru: string }> = {
  telegram: { en: 'Telegram', ru: 'Telegram' },
  calendar: { en: 'Calendar', ru: 'Календарь' },
  email: { en: 'Email', ru: 'Почта' },
  whatsapp: { en: 'WhatsApp', ru: 'WhatsApp' },
  instagram: { en: 'Instagram', ru: 'Instagram' },
  payments: { en: 'Payments', ru: 'Платежи' },
  gpt: { en: 'Assistant', ru: 'Ассистент' },
};

const CHANNEL_ROUTES: Partial<Record<IntegrationChannel, string>> = {
  calendar: '/integrations/calendar',
  whatsapp: '/integrations/whatsapp',
  instagram: '/integrations/instagram',
  payments: '/payments',
};

// The production Gmail Worker pins each OAuth flow to one exact artist and
// verifies the Google mailbox on callback. Never derive an OAuth target from a
// provider label or display name: both are editable UI metadata.
const GMAIL_ARTIST_SLUG_BY_ID: Readonly<Record<string, 'vladimir' | 'kristina'>> = {
  'a1111111-1111-4111-8111-111111111111': 'vladimir',
  'a2222222-2222-4222-8222-222222222222': 'kristina',
};

export function gmailOAuthStartUrl(
  status: Pick<IntegrationStatus, 'owner_kind' | 'owner_id' | 'integration_type' | 'provider'>,
): string | null {
  if (status.integration_type !== 'email' || status.owner_kind !== 'artist' || status.provider !== 'google') {
    return null;
  }
  const slug = GMAIL_ARTIST_SLUG_BY_ID[status.owner_id];
  return slug ? `https://gmail.vishartattoo.com/oauth/google/start/${slug}` : null;
}

const HEALTH_LABELS: Record<IntegrationHealth, { en: string; ru: string }> = {
  connected: { en: 'Connected', ru: 'Подключено' },
  not_connected: { en: 'Not connected', ru: 'Не подключено' },
  needs_attention: { en: 'Needs attention', ru: 'Требует внимания' },
  error: { en: 'Error', ru: 'Ошибка' },
};

export function IntegrationsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language, t } = useLanguage();
  const state = useAsync(async () => {
    const [statuses, artists, failedJobs, pluginAuth] = await Promise.all([
      api.listIntegrationStatus(),
      api.listAccessibleArtists(),
      api.listFailedJobs().catch(() => null),
      // A missing RPC during a DB-first rollout must not break other integrations.
      Promise.resolve().then(() => api.refreshMyChatgptPluginAuthStatus()).catch(() => null),
    ]);
    const visibleArtistIds = visibleIntegrationArtistIds(profile, artists, memberships);
    return {
      statuses: statuses.filter(
        (status) => status.owner_kind !== 'artist' || visibleArtistIds.has(status.owner_id),
      ),
      hasVisibleArtist: visibleArtistIds.size > 0,
      failedJobs: failedJobs?.filter((job) => visibleArtistIds.has(job.artist_id)) ?? null,
      pluginAuth,
    };
  }, [api, memberships, profile]);

  const byChannel = useMemo(() => {
    const groups = new Map<IntegrationChannel, IntegrationStatus[]>();
    for (const row of state.data?.statuses ?? []) {
      const existing = groups.get(row.integration_type);
      if (existing) existing.push(row);
      else groups.set(row.integration_type, [row]);
    }
    return groups;
  }, [state.data]);

  if (state.loading) return <LoadingState label={t('app.checkingAccess')} />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const channels = CHANNEL_ORDER.filter((channel) => byChannel.has(channel));
  const showCalendarAvailability = Boolean(
    state.data?.hasVisibleArtist && !byChannel.has('calendar'),
  );
  const hasAvailableIntegrations = showCalendarAvailability;

  return (
    <div className="stack">
      <DeliveryIssuesSection jobs={state.data?.failedJobs ?? null} />
      {state.data?.pluginAuth && state.data.pluginAuth.connection_state !== 'not_configured' ? (
        <Section title="ChatGPT Plugin">
          <div className="card" data-testid="chatgpt-plugin-auth-card" data-chatgpt-oauth-state={state.data.pluginAuth.connection_state}>
            <div className="card-header">
              <strong>Vishar CRM</strong>
              <span className={`badge badge-${state.data.pluginAuth.connection_state === 'reconnect_required' ? 'needs_attention' : 'not_connected'}`}>
                {state.data.pluginAuth.connection_state === 'reconnect_required'
                  ? (language === 'ru' ? 'Требует внимания' : 'Needs attention')
                  : (language === 'ru' ? 'OAuth-статус' : 'OAuth status')}
              </span>
            </div>
            {state.data.pluginAuth.connection_state === 'reconnect_required' ? (
              <p className="notice warn" role="alert">
                {language === 'ru'
                  ? 'Авторизация плагина больше не подтверждается. В ChatGPT открой Настройки → Плагины → Vishar CRM и переподключи аккаунт.'
                  : 'Plugin authorization is no longer confirmed. In ChatGPT, open Settings → Plugins → Vishar CRM and reconnect.'}
              </p>
            ) : (
              <p className="muted">
                {language === 'ru'
                  ? 'Авторизация сохранена в Supabase. Это не проверка работы ChatGPT: отсутствие активности не считается ошибкой.'
                  : 'Supabase stores a Plugin authorization. This is not a live ChatGPT tool test; inactivity is not an error.'}
              </p>
            )}
            {state.data.pluginAuth.last_oauth_refresh_at ? (
              <p className="muted">
                {language === 'ru' ? 'Последнее обновление OAuth: ' : 'Last OAuth refresh: '}
                {formatDate(state.data.pluginAuth.last_oauth_refresh_at, language)}
              </p>
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section title={language === 'ru' ? 'Формы и сайты' : 'Forms and websites'}>
        <div className="card">
          <div className="card-header">
            <strong>{language === 'ru' ? 'Источники заявок' : 'Booking sources'}</strong>
          </div>
          <p className="muted">
            {language === 'ru'
              ? 'Создавайте hosted-формы Vishar или подключайте существующие сайты без ручной настройки Artist routing.'
              : 'Create Vishar-hosted forms or connect existing websites without manual Artist-routing configuration.'}
          </p>
          <div className="actions">
            <Link to="/integrations/forms">{language === 'ru' ? 'Управлять' : 'Manage'}</Link>
          </div>
        </div>
      </Section>

      {hasAvailableIntegrations ? (
        <Section title={language === 'ru' ? 'Доступные интеграции' : 'Available integrations'}>
          <ul className="card-list">
            {showCalendarAvailability ? <AvailableCalendarCard /> : null}
          </ul>
        </Section>
      ) : null}

      {channels.length === 0 && !hasAvailableIntegrations ? (
        <EmptyState
          title={language === 'ru' ? 'Провайдеры пока не подключены' : 'No providers connected yet'}
          hint={language === 'ru'
            ? 'Формами и сайтами уже можно управлять выше.'
            : 'Forms and websites can already be managed above.'}
        />
      ) : channels.map((channel) => (
        <Section key={channel} title={CHANNEL_LABELS[channel][language]}>
          <ul className="card-list">
            {(byChannel.get(channel) ?? []).map((row) => (
              <IntegrationCard key={row.integration_id} status={row} channel={channel} />
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function DeliveryIssuesSection({ jobs }: { jobs: OutboxJob[] | null }) {
  const { language } = useLanguage();
  const { actionable, cancelled } = splitDeliveryIssues(jobs ?? []);
  return (
    <Section title={language === 'ru' ? 'Ошибки доставки' : 'Delivery issues'}>
      <div className="card" id="delivery-issues">
        {jobs === null ? (
          <p className="muted">
            {language === 'ru'
              ? 'Не удалось загрузить журнал отправки. Состояние подключений ниже не означает, что сообщения доставлены.'
              : 'Could not load delivery history. A connected account below does not guarantee message delivery.'}
          </p>
        ) : (
          <>
            <p className="muted" data-testid="actionable-delivery-count">
              {actionable.length === 0
                ? (language === 'ru' ? 'Нет ошибок, требующих действий.' : 'No deliveries require action.')
                : (language === 'ru'
                  ? `Ошибок, требующих действий: ${actionable.length}`
                  : `Deliveries requiring action: ${actionable.length}`)}
            </p>
            {actionable.length > 0 ? (
              <ul className="card-list" data-testid="actionable-delivery-list">
                {actionable.map((job) => <DeliveryIssueRow key={job.id} job={job} />)}
              </ul>
            ) : null}
            {cancelled.length > 0 ? (
              <details>
                <summary>
                  {language === 'ru'
                    ? `Ранее отменены вручную: ${cancelled.length}`
                    : `Previously cancelled by an operator: ${cancelled.length}`}
                </summary>
                <ul className="card-list">
                  {cancelled.map((job) => <DeliveryIssueRow key={job.id} job={job} cancelled />)}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>
    </Section>
  );
}

function DeliveryIssueRow({ job, cancelled = false }: { job: OutboxJob; cancelled?: boolean }) {
  const { language } = useLanguage();
  const kind = job.kind === 'approved_email'
    ? (language === 'ru' ? 'Письмо' : 'Email')
    : job.kind === 'whatsapp_message'
      ? 'WhatsApp'
      : job.kind.replaceAll('_', ' ');
  const cause = job.last_error_code === 'operator_cancelled'
    ? (language === 'ru' ? 'Отменено оператором' : 'Cancelled by operator')
    : job.last_error_code === 'cancelled_by_artist_for_direct_gmail_send'
      ? (language === 'ru' ? 'Отменено для прямой отправки через Gmail' : 'Cancelled for direct Gmail send')
      : safeDeliveryErrorCode(job.last_error_code);
  return (
    <li className="card">
      <div className="card-header">
        <strong>{kind}</strong>
        <span className="muted">{formatDate(job.updated_at, language)}</span>
      </div>
      <p className="muted">{cause}</p>
      {!cancelled ? (
        <p className="muted">
          {language === 'ru'
            ? `Попыток: ${job.attempt_count} из ${job.max_attempts}`
            : `Attempts: ${job.attempt_count} of ${job.max_attempts}`}
        </p>
      ) : null}
    </li>
  );
}

function AvailableCalendarCard() {
  const { language } = useLanguage();
  return (
    <li className="card" data-integration="calendar" data-health="not_connected">
      <div className="card-header">
        <strong>Google Calendar</strong>
        <span className="badge badge-not_connected">
          {HEALTH_LABELS.not_connected[language]}
        </span>
      </div>
      <p className="muted">
        {language === 'ru'
          ? 'Подключите Google Calendar для мастера, которым вы управляете. Конкретный мастер и права повторно проверяются сервером перед OAuth.'
          : 'Connect Google Calendar for an artist you manage. The server re-checks the exact artist and your permission before OAuth.'}
      </p>
      <div className="actions">
        <Link to="/integrations/calendar">
          {language === 'ru' ? 'Подключить' : 'Connect'}
        </Link>
      </div>
    </li>
  );
}

function IntegrationCard({
  status,
  channel,
}: {
  status: IntegrationStatus;
  channel: IntegrationChannel;
}) {
  const { language } = useLanguage();
  const health = integrationHealth(status);
  const route = CHANNEL_ROUTES[channel];
  const gmailUrl = gmailOAuthStartUrl(status);
  const gmailRequiresReconnect = Boolean(
    gmailUrl && !status.is_enabled && status.last_error_category === 'permission_revoked',
  );

  const ownerLine = status.owner_kind === 'workspace'
    ? `${language === 'ru' ? 'Студия' : 'Studio'} · ${status.owner_label ?? ''}`
    : status.owner_label ?? '';

  return (
    <li className="card" data-integration={channel} data-health={health}>
      <div className="card-header">
        <strong>{ownerLine}</strong>
        <span className={`badge badge-${health}`}>{HEALTH_LABELS[health][language]}</span>
      </div>

      {status.display_label ? <p className="muted">{status.display_label}</p> : null}

      {gmailRequiresReconnect ? (
        <p className="notice warn" role="alert" data-testid="gmail-reconnect-required">
          {language === 'ru'
            ? 'Google отозвал доступ к Gmail. Письма не будут синхронизироваться, пока ты не переподключишь аккаунт.'
            : 'Google revoked Gmail access. Email sync is paused until you reconnect this account.'}
        </p>
      ) : null}

      <dl className="meta">
        {status.connected_at ? (
          <>
            <dt>{language === 'ru' ? 'Подключено' : 'Connected'}</dt>
            <dd>{formatDate(status.connected_at, language)}</dd>
          </>
        ) : null}
        {status.last_success_at ? (
          <>
            <dt>{language === 'ru' ? 'Последний успех' : 'Last success'}</dt>
            <dd>{formatDate(status.last_success_at, language)}</dd>
          </>
        ) : null}
      </dl>

      {status.owner_kind === 'workspace' ? (
        <p className="muted">
          {language === 'ru' ? 'Назначено мастерам: ' : 'Assigned to artists: '}
          {status.assigned_artist_ids.length}
        </p>
      ) : null}

      {status.is_selected_route ? (
        <p className="muted">
          {language === 'ru'
            ? 'Используется для этого канала.'
            : 'In use for this channel.'}
        </p>
      ) : null}

      <div className="actions">
        {gmailUrl ? (
          <a href={gmailUrl} rel="noreferrer" aria-label={`${health === 'not_connected' ? (language === 'ru' ? 'Подключить Gmail' : 'Connect Gmail') : (language === 'ru' ? 'Переподключить Gmail' : 'Reconnect Gmail')}: ${status.owner_label ?? ''}`}>
            {health === 'not_connected'
              ? (language === 'ru' ? 'Подключить Gmail' : 'Connect Gmail')
              : (language === 'ru' ? 'Переподключить Gmail' : 'Reconnect Gmail')}
          </a>
        ) : route ? (
          <Link to={route}>
            {health === 'not_connected'
              ? (language === 'ru' ? 'Подключить' : 'Connect')
              : (language === 'ru' ? 'Управлять' : 'Manage')}
          </Link>
        ) : (
          <span className="muted">
            {language === 'ru'
              ? 'Настраивается вместе с вашим мастером.'
              : 'Set up with your artist.'}
          </span>
        )}
      </div>
    </li>
  );
}

function formatDate(value: string, language: 'en' | 'ru'): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
