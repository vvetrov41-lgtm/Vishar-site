import type { Language } from './i18n';
import type { OutboxJob } from './types';

export type OperationalLabelGroup = 'event' | 'integrationKind' | 'integrationError';

export const ACTIVITY_EVENT_TYPES = [
  'artist.work_transferred',
  'client.created',
  'enquiry.assigned',
  'enquiry.converted',
  'enquiry.created',
  'enquiry.intake_completed',
  'enquiry.reviewed',
  'enquiry.source_resolved',
  'enquiry.status_changed',
  'finance.updated',
  'follow_up.completed',
  'follow_up.created',
  'integration.configured',
  'integration.queued',
  'membership.updated',
  'note.created',
  'outbox.failed',
  'outbox.succeeded',
  'owner.bootstrapped',
  'payment.recorded',
  'profile.activated',
  'profile.deactivated',
  'profile.role_changed',
  'profile.updated',
  'project.deposit_changed',
  'project.reviewed',
  'session.created',
  'session.scheduled',
  'session.status_changed',
] as const;

const LABELS: Record<Language, Record<OperationalLabelGroup, Record<string, string>>> = {
  en: {
    event: {
      'artist.work_transferred': 'Artist work transferred',
      'client.created': 'Client created',
      'enquiry.assigned': 'Enquiry assigned',
      'enquiry.converted': 'Enquiry converted',
      'enquiry.created': 'Enquiry created',
      'enquiry.intake_completed': 'Enquiry intake completed',
      'enquiry.reviewed': 'Enquiry reviewed',
      'enquiry.source_resolved': 'Enquiry source resolved',
      'enquiry.status_changed': 'Enquiry status changed',
      'finance.updated': 'Finance details updated',
      'follow_up.completed': 'Follow-up completed',
      'follow_up.created': 'Follow-up created',
      'integration.configured': 'Integration configured',
      'integration.queued': 'Integration queued',
      'membership.updated': 'Artist access updated',
      'note.created': 'Note created',
      'outbox.failed': 'Integration job failed',
      'outbox.succeeded': 'Integration job succeeded',
      'owner.bootstrapped': 'Owner access created',
      'payment.recorded': 'Payment recorded',
      'profile.activated': 'User activated',
      'profile.deactivated': 'User deactivated',
      'profile.role_changed': 'User role changed',
      'profile.updated': 'User profile updated',
      'project.deposit_changed': 'Deposit changed',
      'project.reviewed': 'Project reviewed',
      'session.created': 'Session created',
      'session.scheduled': 'Session scheduled',
      'session.status_changed': 'Session status changed',
    },
    integrationKind: {
      calendar_create: 'Calendar event',
      telegram_notification: 'Telegram notification',
    },
    integrationError: {
      calendar_not_configured: 'Calendar is not configured',
      provider_route_unavailable: 'Provider route unavailable',
      telegram_rejected: 'Telegram rejected the request',
    },
  },
  ru: {
    event: {
      'artist.work_transferred': 'Работа передана другому мастеру',
      'client.created': 'Клиент создан',
      'enquiry.assigned': 'Назначен исполнитель',
      'enquiry.converted': 'Заявка преобразована в проект',
      'enquiry.created': 'Заявка создана',
      'enquiry.intake_completed': 'Приём заявки завершён',
      'enquiry.reviewed': 'Заявка проверена',
      'enquiry.source_resolved': 'Источник заявки определён',
      'enquiry.status_changed': 'Статус заявки изменён',
      'finance.updated': 'Финансовые данные обновлены',
      'follow_up.completed': 'Напоминание выполнено',
      'follow_up.created': 'Напоминание создано',
      'integration.configured': 'Интеграция настроена',
      'integration.queued': 'Интеграция поставлена в очередь',
      'membership.updated': 'Доступ к мастеру обновлён',
      'note.created': 'Заметка создана',
      'outbox.failed': 'Ошибка интеграции',
      'outbox.succeeded': 'Интеграция выполнена',
      'owner.bootstrapped': 'Доступ владельца создан',
      'payment.recorded': 'Платёж зарегистрирован',
      'profile.activated': 'Пользователь активирован',
      'profile.deactivated': 'Пользователь деактивирован',
      'profile.role_changed': 'Роль пользователя изменена',
      'profile.updated': 'Профиль пользователя обновлён',
      'project.deposit_changed': 'Статус депозита изменён',
      'project.reviewed': 'Проект проверен',
      'session.created': 'Сеанс создан',
      'session.scheduled': 'Сеанс запланирован',
      'session.status_changed': 'Статус сеанса изменён',
    },
    integrationKind: {
      calendar_create: 'Событие календаря',
      telegram_notification: 'Telegram-уведомление',
    },
    integrationError: {
      calendar_not_configured: 'Календарь не настроен',
      provider_route_unavailable: 'Маршрут интеграции недоступен',
      telegram_rejected: 'Telegram отклонил запрос',
    },
  },
};

function humanise(value: string): string {
  const text = value.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '—';
}

export function operationalLabel(
  language: Language,
  group: OperationalLabelGroup,
  value: string | null | undefined
): string {
  if (!value) return '—';
  return LABELS[language][group][value] ?? LABELS.en[group][value] ?? humanise(value);
}

export interface FailedJobGroup {
  key: string;
  kind: string;
  status: OutboxJob['status'];
  errorCode: string | null;
  count: number;
  latestJob: OutboxJob;
}

export function groupFailedJobs(jobs: OutboxJob[]): FailedJobGroup[] {
  const groups = new Map<string, FailedJobGroup>();

  for (const job of jobs) {
    const key = `${job.kind}\u0000${job.last_error_code ?? job.status}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        key,
        kind: job.kind,
        status: job.status,
        errorCode: job.last_error_code,
        count: 1,
        latestJob: job,
      });
      continue;
    }

    existing.count += 1;
    if (new Date(job.updated_at).getTime() > new Date(existing.latestJob.updated_at).getTime()) {
      existing.latestJob = job;
    }
  }

  return Array.from(groups.values()).sort(
    (left, right) => new Date(right.latestJob.updated_at).getTime() - new Date(left.latestJob.updated_at).getTime()
  );
}
