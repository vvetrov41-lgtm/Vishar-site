// The integrations hub.
//
// Until now Calendar, WhatsApp and Instagram were three peers in the
// navigation, which worked while there were three of them. This screen is one
// entry point that lists every channel the signed-in person can actually see,
// artist-owned and workspace-owned together, and hands off to the existing
// per-provider screens for the connect flows.
//
// Everything rendered here comes from public.list_integration_status(), which
// returns no token, no chat id, no provider account identifier and no
// configuration blob. There is deliberately nothing on this page that could
// leak one.

import { useMemo } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import {
  integrationHealth,
  type IntegrationChannel,
  type IntegrationHealth,
  type IntegrationStatus,
} from '../lib/platform-api';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';

// Channel order is by how often somebody comes here to deal with it, not
// alphabetical. Forms and websites will join this list when hosted forms land.
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

// Where the connect flow for a channel lives today. A channel with no entry
// has no self-service flow yet and says so rather than offering a dead button.
const CHANNEL_ROUTES: Partial<Record<IntegrationChannel, string>> = {
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

export function IntegrationsPage() {
  const api = useApi();
  const { language, t } = useLanguage();
  const state = useAsync(() => api.listIntegrationStatus(), [api]);

  const byChannel = useMemo(() => {
    const groups = new Map<IntegrationChannel, IntegrationStatus[]>();
    for (const row of state.data ?? []) {
      const existing = groups.get(row.integration_type);
      if (existing) existing.push(row);
      else groups.set(row.integration_type, [row]);
    }
    return groups;
  }, [state.data]);

  if (state.loading) return <LoadingState label={t('app.checkingAccess')} />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const channels = CHANNEL_ORDER.filter((channel) => byChannel.has(channel));

  if (channels.length === 0) {
    return (
      <EmptyState
        title={language === 'ru' ? 'Интеграций пока нет' : 'No integrations yet'}
        hint={language === 'ru'
          ? 'Подключите первый канал, чтобы заявки и напоминания доходили до вас.'
          : 'Connect your first channel so enquiries and reminders reach you.'}
      />
    );
  }

  return (
    <div className="stack">
      {channels.map((channel) => (
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

      {/* Safe metadata only: an account label the provider itself shows the
          user. Never an account id, a chat id or a token. */}
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
