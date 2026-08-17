import type { Language } from './i18n';
import type { OutboxJob } from './types';

export type OperationalLabelGroup = 'event' | 'integrationKind' | 'integrationError';

export const ACTIVITY_EVENT_TYPES = [
  'appointment.rescheduled',
  'appointment.scheduled',
  'appointment.status_changed',
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
  'payment.manual_recorded',
  'payment.recorded',
  'payment.reconciliation_confirmed',
  'payment.reconciliation_ignored',
  'payment.reconciliation_matched',
  'payment.request_cancelled',
  'payment.request_created',
  'profile.activated',
  'profile.deactivated',
  'profile.invite_requested',
  'profile.provisioned',
  'profile.role_changed',
  'profile.updated',
  'project.deposit_changed',
  'project.reviewed',
  'project.status_changed',
  'session.created',
  'session.scheduled',
  'session.status_changed',
] as const;

const LABELS: Record<Language, Record<OperationalLabelGroup, Record<string, string>>> = {
  en: {
    event: {
      'appointment.rescheduled': 'Appointment rescheduled',
      'appointment.scheduled': 'Appointment scheduled',
      'appointment.status_changed': 'Appointment status changed',
      'artist.work_transferred': 'Artist work transferred',
      'client.created': 'Client created',
      'enquiry.assigned': 'Enquiry assigned',
      'enquiry.converted': 'Enquiry converted to project',
      'enquiry.created': 'Enquiry created',
      'enquiry.intake_completed': 'Enquiry intake completed',
      'enquiry.reviewed': 'Enquiry reviewed',
      'enquiry.source_resolved': 'Enquiry source resolved',
      'enquiry.status_changed': 'Enquiry status changed',
      'finance.updated': 'Project estimate updated',
      'follow_up.completed': 'Follow-up completed',
      'follow_up.created': 'Follow-up created',
      'integration.configured': 'Integration configured',
      'integration.queued': 'Integration queued',
      'membership.updated': 'Artist access updated',
      'note.created': 'Internal note added',
      'outbox.failed': 'Integration sync failed',
      'outbox.succeeded': 'Integration sync completed',
      'owner.bootstrapped': 'Owner access created',
      'payment.manual_recorded': 'Manual payment recorded',
      'payment.recorded': 'Payment recorded',
      'payment.reconciliation_confirmed': 'Monzo payment confirmed',
      'payment.reconciliation_ignored': 'Monzo transfer ignored',
      'payment.reconciliation_matched': 'Monzo transfer matched',
      'payment.request_cancelled': 'Payment request cancelled',
      'payment.request_created': 'Payment request created',
      'profile.activated': 'User activated',
      'profile.deactivated': 'User deactivated',
      'profile.invite_requested': 'Staff invitation requested',
      'profile.provisioned': 'Staff access provisioned',
      'profile.role_changed': 'User role changed',
      'profile.updated': 'User profile updated',
      'project.deposit_changed': 'Project deposit status changed',
      'project.reviewed': 'Project reviewed',
      'project.status_changed': 'Project status changed',
      'session.created': 'Session created',
      'session.scheduled': 'Session scheduled',
      'session.status_changed': 'Session status changed',
    },
    integrationKind: {
      calendar_create: 'Create calendar event',
      calendar_update: 'Update calendar event',
      calendar_cancel: 'Cancel calendar event',
      telegram_notification: 'Telegram notification',
    },
    integrationError: {
      artist_route_unconfigured: 'Artist calendar route is not configured',
      calendar_connector_error: 'Calendar connector failed',
      calendar_encryption_key_invalid: 'Calendar token encryption is misconfigured',
      calendar_event_missing: 'Calendar event reference is missing',
      calendar_job_invalid: 'Calendar job is invalid',
      calendar_not_configured: 'Calendar is not configured',
      calendar_oauth_expired: 'Calendar connection has expired',
      calendar_provider_rejected: 'Calendar provider rejected the request',
      calendar_provider_unavailable: 'Calendar provider is temporarily unavailable',
      calendar_scope_missing: 'Calendar permission is missing',
      calendar_token_invalid: 'Stored Calendar connection is invalid',
      google_account_mismatch: 'The connected Google account does not match this artist',
      google_rate_limited: 'Google Calendar rate limit reached',
      google_refresh_invalid_grant: 'Google Calendar access grant is invalid',
      google_token_revoked: 'Google Calendar access was revoked',
      provider_route_invalid: 'Calendar provider route is invalid',
      provider_route_unavailable: 'Provider route unavailable',
      telegram_rejected: 'Telegram rejected the request',
    },
  },
  ru: {
    event: {
      'appointment.rescheduled': 'Запись перенесена',
      'appointment.scheduled': 'Запись запланирована',
      'appointment.status_changed': 'Статус записи изменён',
      'artist.work_transferred': 'Работа передана другому мастеру',
      'client.created': 'Клиент создан',
      'enquiry.assigned': 'Назначен исполнитель',
      'enquiry.converted': 'Заявка преобразована в проект',
      'enquiry.created': 'Заявка создана',
      'enquiry.intake_completed': 'Приём заявки завершён',
      'enquiry.reviewed': 'Заявка проверена',
      'enquiry.source_resolved': 'Источник заявки определён',
      'enquiry.status_changed': 'Статус заявки изменён',
      'finance.updated': 'Расчёт проекта обновлён',
      'follow_up.completed': 'Напоминание выполнено',
      'follow_up.created': 'Напоминание создано',
      'integration.configured': 'Интеграция настроена',
      'integration.queued': 'Синхронизация поставлена в очередь',
      'membership.updated': 'Доступ к мастеру обновлён',
      'note.created': 'Добавлена внутренняя заметка',
      'outbox.failed': 'Ошибка синхронизации интеграции',
      'outbox.succeeded': 'Синхронизация интеграции выполнена',
      'owner.bootstrapped': 'Доступ владельца создан',
      'payment.manual_recorded': 'Ручная оплата зафиксирована',
      'payment.recorded': 'Платёж зарегистрирован',
      'payment.reconciliation_confirmed': 'Оплата Monzo подтверждена',
      'payment.reconciliation_ignored': 'Перевод Monzo проигнорирован',
      'payment.reconciliation_matched': 'Перевод Monzo сопоставлен',
      'payment.request_cancelled': 'Платёжный запрос отменён',
      'payment.request_created': 'Платёжный запрос создан',
      'profile.activated': 'Пользователь активирован',
      'profile.deactivated': 'Пользователь деактивирован',
      'profile.invite_requested': 'Запрошено приглашение сотрудника',
      'profile.provisioned': 'Доступ сотрудника подготовлен',
      'profile.role_changed': 'Роль пользователя изменена',
      'profile.updated': 'Профиль пользователя обновлён',
      'project.deposit_changed': 'Статус депозита проекта изменён',
      'project.reviewed': 'Проект проверен',
      'project.status_changed': 'Статус проекта изменён',
      'session.created': 'Сеанс создан',
      'session.scheduled': 'Сеанс запланирован',
      'session.status_changed': 'Статус сеанса изменён',
    },
    integrationKind: {
      calendar_create: 'Создание события календаря',
      calendar_update: 'Обновление события календаря',
      calendar_cancel: 'Отмена события календаря',
      telegram_notification: 'Telegram-уведомление',
    },
    integrationError: {
      artist_route_unconfigured: 'Маршрут календаря мастера не настроен',
      calendar_connector_error: 'Ошибка Calendar connector',
      calendar_encryption_key_invalid: 'Неверно настроено шифрование токена календаря',
      calendar_event_missing: 'Отсутствует ссылка на событие календаря',
      calendar_job_invalid: 'Некорректная задача календаря',
      calendar_not_configured: 'Календарь не настроен',
      calendar_oauth_expired: 'Подключение календаря истекло',
      calendar_provider_rejected: 'Календарь отклонил запрос',
      calendar_provider_unavailable: 'Календарь временно недоступен',
      calendar_scope_missing: 'Отсутствует разрешение на работу с календарём',
      calendar_token_invalid: 'Сохранённое подключение календаря повреждено',
      google_account_mismatch: 'Подключённый Google-аккаунт не соответствует мастеру',
      google_rate_limited: 'Превышен лимит запросов Google Calendar',
      google_refresh_invalid_grant: 'Разрешение Google Calendar недействительно',
      google_token_revoked: 'Доступ Google Calendar отозван',
      provider_route_invalid: 'Некорректный маршрут Calendar provider',
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
