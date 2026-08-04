import { describe, expect, it } from 'vitest';
import { groupFailedJobs, operationalLabel } from '../lib/operational-labels';
import type { OutboxJob } from '../lib/types';

function job(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: 'job-1',
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    kind: 'telegram_notification',
    status: 'failed',
    attempt_count: 1,
    max_attempts: 8,
    next_attempt_at: '2026-08-04T08:00:00Z',
    last_error_code: 'provider_route_unavailable',
    updated_at: '2026-08-04T07:30:00Z',
    ...overrides,
  };
}

describe('operational labels', () => {
  it('localises retained-staging and appointment event codes', () => {
    expect(operationalLabel('en', 'event', 'membership.updated')).toBe('Artist access updated');
    expect(operationalLabel('ru', 'event', 'profile.deactivated')).toBe('Пользователь деактивирован');
    expect(operationalLabel('ru', 'event', 'session.scheduled')).toBe('Сеанс запланирован');
    expect(operationalLabel('en', 'event', 'appointment.scheduled')).toBe('Appointment scheduled');
    expect(operationalLabel('ru', 'event', 'appointment.status_changed')).toBe('Статус записи изменён');
    expect(operationalLabel('ru', 'integrationKind', 'telegram_notification')).toBe('Telegram-уведомление');
    expect(operationalLabel('ru', 'integrationError', 'provider_route_unavailable')).toBe('Маршрут интеграции недоступен');
  });

  it('keeps an unknown value readable without exposing separators', () => {
    expect(operationalLabel('en', 'event', 'future.event_code')).toBe('Future event code');
  });
});

describe('failed integration grouping', () => {
  it('groups repeated failures and retains the latest attempt', () => {
    const groups = groupFailedJobs([
      job(),
      job({ id: 'job-2', attempt_count: 2, updated_at: '2026-08-04T07:45:00Z' }),
      job({
        id: 'job-3',
        kind: 'calendar_create',
        last_error_code: 'calendar_not_configured',
        updated_at: '2026-08-04T07:40:00Z',
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: 'telegram_notification',
      errorCode: 'provider_route_unavailable',
      count: 2,
      latestJob: { id: 'job-2', attempt_count: 2 },
    });
    expect(groups[1]).toMatchObject({
      kind: 'calendar_create',
      errorCode: 'calendar_not_configured',
      count: 1,
    });
  });
});
