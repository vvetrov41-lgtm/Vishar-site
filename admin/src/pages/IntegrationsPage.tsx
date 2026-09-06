// The integrations hub.
//
// Provider connections and booking entry points share one administration hub.
// Safe status metadata comes from list_integration_status(); forms/websites
// have their own capability-scoped management RPCs and screen.

import { useMemo } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
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
  'telegram',
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
  telegram: '/integrations/telegram',
  calendar: '/integrations/calendar',
  whatsapp: '/integrations/whatsapp',
  instagram: '/integrations/instagram',
  payments: '/payments',
};

const HEALTH_LABELS: Record<IntegrationHealth, { en: string; ru: string }> = {
  connected: { en: 'Connected', ru: 'Подключено' },
  not_connected: { en: 'Not connected', ru: 'Не подключено' },
  needs_attention: { en: 'Needs attention', ru: 'Требует внимания' },
  error: { en: 'Error', ru: 'Ошибка' },
};

const TELEGRAM_PURPOSE = {
  en: 'Telegram is used only for artist notifications. It is not a client messaging channel.',
  ru: 'Telegram работает только для уведомлений мастеру. Это не канал переписки с клиентами.',
};

export function IntegrationsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language, t } = useLanguage();
  const state = useAsync(async () => {
    const [statuses, artists] = await Promise.all([
      api.listIntegrationStatus(),
      api.listAccessibleArtists(),
    ]);
    const visibleArtistIds = visibleIntegrationArtistIds(profile, artists, memberships);
    return {
      statuses: statuses.filter(
        (status) => status.owner_kind !== 'artist' || visibleArtistIds.has(status.owner_id),
      ),
      hasVisibleArtist: visibleArtistIds.size > 0,
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
  const showTelegramAvailability = Boolean(
    state.data?.hasVisibleArtist && !byChannel.has('telegram'),
  );
  const showCalendarAvailability = Boolean(
    state.data?.hasVisibleArtist && !byChannel.has('calendar'),
  );
  const hasAvailableIntegrations = showTelegramAvailability || showCalendarAvailability;

  return (
    <div className="stack">
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
            {showTelegramAvailability ? <AvailableTelegramCard /> : null}
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

function AvailableTelegramCard() {
  const { language } = useLanguage();
  return (
    <li className="card" data-integration="telegram" data-health="not_connected">
      <div className="card-header">
        <strong>Telegram</strong>
        <span className="badge badge-not_connected">
          {HEALTH_LABELS.not_connected[language]}
        </span>
      </div>
      <p className="muted">{TELEGRAM_PURPOSE[language]}</p>
      <div className="actions">
        <Link to="/integrations/telegram">
          {language === 'ru' ? 'Подключить' : 'Connect'}
        </Link>
      </div>
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

  const ownerLine = status.owner_kind === 'workspace'
    ? `${language === 'ru' ? 'Студия' : 'Studio'} · ${status.owner_label ?? ''}`
    : status.owner_label ?? '';

  return (
    <li className="card" data-integration={channel} data-health={health}>
      <div className="card-header">
        <strong>{ownerLine}</strong>
        <span className={`badge badge-${health}`}>{HEALTH_LABELS[health][language]}</span>
      </div>

      {channel === 'telegram' ? <p className="muted">{TELEGRAM_PURPOSE[language]}</p> : null}
      {status.display_label ? <p className="muted">{status.display_label}</p> : null}

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
        {route ? (
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
