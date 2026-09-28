// The notification centre.
//
// Telegram delivery belongs here rather than in the generic integrations hub.
// One profile-scoped Telegram connection delivers both new enquiry alerts and
// personal CRM notifications. A second artist/group destination is not exposed.

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
  const { t } = useLanguage();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The list is the newest page; whether anything is unread is asked
  // separately, so an unread row older than the page still offers mark-all.
  const state = useAsync(async () => {
    const [items, delivered, pending] = await Promise.all([
      api.listNotifications(),
      api.listNotifications('delivered', 1),
      api.listNotifications('pending', 1),
    ]);
    return { items, anyUnread: delivered.length + pending.length > 0 };
  }, [api]);

  const act = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusyId(id);
      setActionError(null);
      try {
        await run();
        state.reload();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : t('notifications.actionFailed'));
      } finally {
        setBusyId(null);
      }
    },
    [state, t],
  );

  // One server-side update covers every unread row the caller can see, not
  // only the ones this page loaded.
  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    setActionError(null);
    try {
      await api.markAllNotificationsRead();
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('notifications.actionFailed'));
    } finally {
      setMarkingAll(false);
    }
  }, [api, state, t]);

  const notifications = state.data?.items ?? [];
  const visible = notifications.filter((item) => item.status !== 'dismissed');
  const unread = visible.filter((item) => item.status !== 'read');
  const read = visible.filter((item) => item.status === 'read');

  return (
    <div className="stack">
      <PersonalTelegramNotifications />
      {actionError ? <ErrorState message={actionError} /> : null}

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && visible.length === 0 ? (
        <EmptyState title={t('notifications.emptyTitle')} hint={t('notifications.emptyHint')} />
      ) : null}

      {!state.loading && !state.error && (unread.length > 0 || state.data?.anyUnread) ? (
        <div className="actions">
          <button type="button" disabled={markingAll || busyId !== null} onClick={markAllRead}>
            {t('notifications.markAllRead')}
          </button>
        </div>
      ) : null}

      {!state.loading && !state.error && unread.length > 0 ? (
        <Section title={t('notifications.unread', { count: unread.length })}>
          <ul className="card-list">
            {unread.map((item) => (
              <NotificationCard
                key={item.id}
                notification={item}
                busy={markingAll || busyId === item.id}
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
        <Section title={t('notifications.read')}>
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
  const { language, t } = useLanguage();
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
          <Link to={target}>{t('notifications.open')}</Link>
        ) : null}

        {onRead ? (
          <button type="button" disabled={busy} onClick={onRead}>
            {t('notifications.markRead')}
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

// Russian labels for the CRM-AI action types. Mirrors
// crm_private.client_ai_action_label() in the database.
const ACTION_LABELS_RU: Record<string, string> = {
  request_information: 'Запросить у клиента недостающие детали',
  artist_review: 'Нужна ваша проверка',
  prepare_quote: 'Подготовить оценку стоимости',
  offer_dates: 'Предложить даты',
  request_deposit: 'Запросить депозит',
  confirm_booking: 'Подтвердить запись',
  follow_up: 'Напомнить о себе',
  await_client: 'Ждём ответа клиента',
  no_action: 'Действий не требуется',
};

const AI_DISCLAIMER_EN = 'This is a suggestion for your review. Nothing has been sent to the client.';

/**
 * The server's fixed English templates in Russian.
 *
 * New rows already arrive in the recipient's language (the database localises
 * them on insert, crm_private.localize_notification_copy); this covers rows
 * written before that, so Russian mode shows no English system text. Only the
 * fixed template is replaced: client names, the AI's own text and anything a
 * person wrote are passed through untouched.
 */
function russianCopy(type: string, title: string, body: string | null): { title: string; body: string | null } {
  const rest = (value: string, prefix: string) => (value.startsWith(prefix) ? value.slice(prefix.length) : null);

  switch (type) {
    case 'enquiry.created': {
      const name = rest(title, 'New enquiry: ');
      let text = body;
      if (body === 'New enquiry received.') text = 'Новая заявка получена.';
      else if (body === 'New enquiry received. AI summary is being prepared.') text = 'Новая заявка получена. AI-сводка готовится.';
      else if (body?.startsWith('AI summary:\n')) text = `AI-сводка:\n${body.slice('AI summary:\n'.length)}`;
      return { title: name !== null ? `Новая заявка: ${name}` : title, body: text };
    }
    case 'client_ai.next_action': {
      const name = rest(title, 'Needs you: ');
      let text = body;
      if (body?.startsWith('Suggested next step: ')) {
        const lines = body.split('\n');
        const action = lines[0].slice('Suggested next step: '.length);
        lines[0] = `Предлагаемый шаг: ${ACTION_LABELS_RU[action] ?? ACTION_LABELS_RU.artist_review}`;
        if (lines[lines.length - 1] === AI_DISCLAIMER_EN) {
          lines[lines.length - 1] = 'Это подсказка для вашей проверки. Клиенту ничего не отправлено.';
        }
        text = lines.join('\n');
      }
      return { title: name !== null ? `Нужно ваше решение: ${name}` : title, body: text };
    }
    case 'system.ai_processing_failed': {
      const count = body?.match(/^([0-9]+) AI summaries could not be produced in the last 24 hours\./)?.[1];
      return {
        title: title === 'AI processing needs attention' ? 'AI-обработка требует внимания' : title,
        body: count
          ? `За последние 24 часа не удалось подготовить AI-сводки: ${count}. Заявки сохранены — откройте их, чтобы разобрать вручную или повторить AI.`
          : body,
      };
    }
    case 'system.integration_delivery_failed': {
      const count = body?.match(/^([0-9]+) notification, calendar or message deliveries stopped retrying in the last 24 hours\./)?.[1];
      return {
        title: title === 'Integration deliveries need attention' ? 'Доставки интеграций требуют внимания' : title,
        body: count
          ? `За последние 24 часа прекратились повторные попытки доставки уведомлений, календаря или сообщений: ${count}. Откройте «Журнал» этого мастера и проверьте ошибки.`
          : body,
      };
    }
    case 'automation.lifecycle_execution_failed':
      return {
        title: 'Не удалось подготовить автоматические письма',
        body: 'За последние 24 часа возникли ошибки при подготовке как минимум 3 писем. Открой раздел «Автоматизации» нужного мастера и проверь ошибки.',
      };
    case 'automation.lifecycle_delivery_failed':
      return {
        title: 'Возникли ошибки доставки автоматических писем',
        body: 'За последние 24 часа ошибки доставки затронули как минимум 3 письма. Открой раздел «Автоматизации» нужного мастера и проверь историю отправок.',
      };
    case 'appointment.attendance_confirmed':
      return title === 'Client confirmed attendance'
        ? { title: 'Клиент подтвердил визит', body: 'Клиент подтвердил, что придёт на эту запись.' }
        : { title, body };
    case 'appointment.reschedule_requested':
      return title === 'Client requested a reschedule'
        ? {
          title: 'Клиент просит перенести запись',
          body: 'Время записи не изменилось. Свяжитесь с клиентом и выберите новое время, прежде чем переносить запись в CRM.',
        }
        : { title, body };
    case 'appointment.cancelled_by_client':
      return title === 'Client cancelled an appointment'
        ? { title: 'Клиент отменил запись', body: 'Клиент отменил эту запись по защищённой ссылке из напоминания.' }
        : { title, body };
    default:
      return { title, body };
  }
}

export function notificationCopy(
  notification: Pick<CrmNotification, 'notification_type' | 'title' | 'body'>,
  language: 'en' | 'ru',
): { title: string; body: string | null } {
  if (language === 'ru') return russianCopy(notification.notification_type, notification.title, notification.body);
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
