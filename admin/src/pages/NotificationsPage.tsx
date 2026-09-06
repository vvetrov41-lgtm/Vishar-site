// The notification centre.
//
// A notification is addressed to a person, not to an artist scope. Personal
// Telegram delivery is configured here for the same reason: it belongs to the
// signed-in profile and must never be confused with an Artist's shared group.

import { useCallback, useState } from 'react';
import { PersonalTelegramNotifications } from '../components/PersonalTelegramNotifications';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { snoozeUntil, type CrmNotification } from '../lib/platform-api';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';

type SnoozeChoice = '15m' | '1h' | 'tomorrow';

const SNOOZE_LABELS: Record<SnoozeChoice, { en: string; ru: string }> = {
  '15m': { en: '15 minutes', ru: '15 минут' },
  '1h': { en: '1 hour', ru: '1 час' },
  tomorrow: { en: 'Tomorrow', ru: 'Завтра' },
};

export function NotificationsPage() {
  const api = useApi();
  const { language } = useLanguage();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = useAsync(() => api.listNotifications(), [api]);

  const act = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await run();
        state.reload();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : (language === 'ru' ? 'Не удалось выполнить действие.' : 'That did not work.'));
      } finally {
        setBusyId(null);
      }
    },
    [state, language],
  );

  const notifications = state.data ?? [];
  const unread = notifications.filter((item) => item.status !== 'read');
  const read = notifications.filter((item) => item.status === 'read');

  return (
    <div className="stack">
      <PersonalTelegramNotifications />

      {actionError ? <ErrorState message={actionError} /> : null}

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && notifications.length === 0 ? (
        <EmptyState
          title={language === 'ru' ? 'Пока ничего' : 'Nothing waiting'}
          hint={language === 'ru'
            ? 'Здесь появятся напоминания и уведомления, адресованные вам.'
            : 'Reminders and notifications addressed to you will appear here.'}
        />
      ) : null}

      {!state.loading && !state.error && unread.length > 0 ? (
        <Section title={`${language === 'ru' ? 'Новые' : 'Unread'} (${unread.length})`}>
          <ul className="card-list">
            {unread.map((item) => (
              <NotificationCard
                key={item.id}
                notification={item}
                busy={busyId === item.id}
                onRead={() => act(item.id, () => api.markNotificationRead(item.id))}
                onSnooze={(choice) => act(item.id, async () => {
                  if (item.entity_type !== 'follow_up' || !item.entity_id) return;
                  await api.snoozeFollowUp(item.entity_id, snoozeUntil(choice));
                  await api.markNotificationRead(item.id);
                })}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {!state.loading && !state.error && read.length > 0 ? (
        <Section title={language === 'ru' ? 'Прочитанные' : 'Read'}>
          <ul className="card-list">
            {read.map((item) => (
              <NotificationCard key={item.id} notification={item} busy={false} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function NotificationCard({
  notification,
  busy,
  onRead,
  onSnooze,
}: {
  notification: CrmNotification;
  busy: boolean;
  onRead?: () => void;
  onSnooze?: (choice: SnoozeChoice) => void;
}) {
  const { language } = useLanguage();
  const overdue = describeDue(notification.scheduled_at, language);
  const copy = notificationCopy(notification, language);
  const target = entityLink(notification);
  const canSnooze = Boolean(onSnooze) && notification.entity_type === 'follow_up';

  return (
    <li className="card" data-priority={notification.priority} data-status={notification.status}>
      <div className="card-header">
        <strong>{copy.title}</strong>
        {notification.artist_label ? (
          <span className="badge">{notification.artist_label}</span>
        ) : null}
      </div>

      {copy.body ? <p>{copy.body}</p> : null}
      <p className="muted">{overdue}</p>

      <div className="actions">
        {target ? (
          <Link to={target}>{language === 'ru' ? 'Открыть' : 'Open'}</Link>
        ) : null}

        {onRead ? (
          <button type="button" disabled={busy} onClick={onRead}>
            {language === 'ru' ? 'Прочитано' : 'Mark read'}
          </button>
        ) : null}

        {canSnooze
          ? (['15m', '1h', 'tomorrow'] as SnoozeChoice[]).map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              onClick={() => onSnooze?.(choice)}
            >
              {SNOOZE_LABELS[choice][language]}
            </button>
          ))
          : null}
      </div>
    </li>
  );
}

export function entityLink(notification: CrmNotification): string | null {
  if (!notification.entity_type || !notification.entity_id) return null;
  switch (notification.entity_type) {
    case 'enquiry': return `/enquiries/${notification.entity_id}`;
    case 'project': return `/projects/${notification.entity_id}`;
    case 'client': return `/clients/${notification.entity_id}`;
    case 'conversation': return `/inbox/${notification.entity_id}`;
    case 'session': return `/appointments/${encodeURIComponent(notification.entity_id)}`;
    case 'payment_request': return '/payments';
    case 'integration': return '/integrations';
    default: return null;
  }
}

export function notificationCopy(
  notification: Pick<CrmNotification, 'notification_type' | 'title' | 'body'>,
  language: 'en' | 'ru',
): { title: string; body: string | null } {
  if (language === 'ru' && notification.notification_type === 'automation.lifecycle_execution_failed') {
    return {
      title: 'Не удалось подготовить автоматические письма',
      body: 'За последние 24 часа возникли ошибки при подготовке как минимум 3 писем. Открой раздел «Автоматизации» нужного мастера и проверь ошибки.',
    };
  }
  if (language === 'ru' && notification.notification_type === 'automation.lifecycle_delivery_failed') {
    return {
      title: 'Возникли ошибки доставки автоматических писем',
      body: 'За последние 24 часа ошибки доставки затронули как минимум 3 письма. Открой раздел «Автоматизации» нужного мастера и проверь историю отправок.',
    };
  }
  return { title: notification.title, body: notification.body };
}

export function describeDue(scheduledAt: string, language: 'en' | 'ru', now = new Date()): string {
  const due = new Date(scheduledAt);
  if (Number.isNaN(due.getTime())) return scheduledAt;

  const minutes = Math.round((now.getTime() - due.getTime()) / 60_000);

  if (minutes >= 60 * 24) {
    const days = Math.floor(minutes / (60 * 24));
    return language === 'ru' ? `Просрочено на ${days} дн.` : `Overdue by ${days}d`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return language === 'ru' ? `Просрочено на ${hours} ч.` : `Overdue by ${hours}h`;
  }
  if (minutes >= 1) {
    return language === 'ru' ? `Просрочено на ${minutes} мин.` : `Overdue by ${minutes}m`;
  }
  if (minutes > -60) {
    return language === 'ru' ? `Через ${-minutes} мин.` : `Due in ${-minutes}m`;
  }
  const hours = Math.floor(-minutes / 60);
  return language === 'ru' ? `Через ${hours} ч.` : `Due in ${hours}h`;
}
