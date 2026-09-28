import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationCopy } from '../pages/NotificationsPage';
import { operationalLabel } from '../lib/operational-labels';

describe('notificationCopy in Russian', () => {
  it('translates the new-enquiry template and keeps the client name and AI text', () => {
    expect(notificationCopy({
      notification_type: 'enquiry.created',
      title: 'New enquiry: Anna Client',
      body: 'AI summary:\nWants a forearm piece.',
    }, 'ru')).toEqual({ title: 'Новая заявка: Anna Client', body: 'AI-сводка:\nWants a forearm piece.' });
  });

  it('translates the next-action frame around the model reason', () => {
    expect(notificationCopy({
      notification_type: 'client_ai.next_action',
      title: 'Needs you: Anna Client',
      body: 'Suggested next step: offer_dates\nКлиент готов к записи.\nThis is a suggestion for your review. Nothing has been sent to the client.',
    }, 'ru')).toEqual({
      title: 'Нужно ваше решение: Anna Client',
      body: 'Предлагаемый шаг: Предложить даты\nКлиент готов к записи.\nЭто подсказка для вашей проверки. Клиенту ничего не отправлено.',
    });
  });

  it('keeps the count in failure alerts', () => {
    const copy = notificationCopy({
      notification_type: 'system.integration_delivery_failed',
      title: 'Integration deliveries need attention',
      body: '4 notification, calendar or message deliveries stopped retrying in the last 24 hours. Open Activity for this artist and check the failed items.',
    }, 'ru');
    expect(copy.title).toBe('Доставки интеграций требуют внимания');
    expect(copy.body).toContain(': 4.');
  });

  it('leaves English mode and person-written text alone', () => {
    const english = { notification_type: 'enquiry.created', title: 'New enquiry: Ben', body: 'New enquiry received.' };
    expect(notificationCopy(english, 'en')).toEqual({ title: 'New enquiry: Ben', body: 'New enquiry received.' });
    expect(notificationCopy({ notification_type: 'follow_up.due', title: 'Call Ben', body: 'About the sleeve' }, 'ru'))
      .toEqual({ title: 'Call Ben', body: 'About the sleeve' });
  });

  it('labels production activity events in Russian instead of raw codes', () => {
    expect(operationalLabel('ru', 'event', 'client_ai.state_refreshed')).toBe('AI-бриф обновлён');
    expect(operationalLabel('en', 'event', 'client_ai.state_refreshed')).toBe('AI brief updated');
    expect(operationalLabel('ru', 'integrationError', 'database_unavailable')).toBe('База данных временно недоступна');
  });
});

const api = vi.hoisted(() => ({ setMyUiLanguage: vi.fn() }));
const lang = vi.hoisted(() => ({ current: 'ru' as 'en' | 'ru' }));
vi.mock('../lib/session', () => ({
  useApi: () => api,
  useSession: () => ({ profile: { id: 'p-1' } }),
}));
vi.mock('../lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('../lib/i18n')>('../lib/i18n');
  return { ...actual, useLanguage: () => ({ language: lang.current }) };
});

import { LanguageSync } from '../components/LanguageSync';

describe('LanguageSync', () => {
  beforeEach(() => {
    api.setMyUiLanguage.mockReset();
    api.setMyUiLanguage.mockResolvedValue(undefined);
  });

  it('records the interface language on the profile once per change', async () => {
    const view = render(<LanguageSync />);
    await waitFor(() => expect(api.setMyUiLanguage).toHaveBeenCalledWith('ru'));
    view.rerender(<LanguageSync />);
    expect(api.setMyUiLanguage).toHaveBeenCalledTimes(1);
    lang.current = 'en';
    view.rerender(<LanguageSync />);
    await waitFor(() => expect(api.setMyUiLanguage).toHaveBeenLastCalledWith('en'));
  });
});
