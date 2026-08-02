import { describe, expect, it } from 'vitest';
import { humanise, translate } from '../lib/i18n';

describe('CRM translations', () => {
  it('translates core navigation and workflow labels into Russian', () => {
    expect(translate('ru', 'nav.enquiries')).toBe('Заявки');
    expect(translate('ru', 'enquiryStatus.accepted')).toBe('Принята');
    expect(translate('ru', 'project.convertButton')).toBe('project.convertButton');
    expect(translate('ru', 'enquiry.convertButton')).toBe('Создать проект');
    expect(translate('ru', 'event.client.created')).toBe('Клиент создан');
    expect(translate('ru', 'actor.worker')).toBe('система');
  });

  it('interpolates values without executing or dropping text', () => {
    expect(translate('ru', 'project.depositAmount', { currency: 'GBP' }))
      .toBe('Сумма депозита (GBP)');
    expect(translate('en', 'common.attemptOf', { attempt: 2, max: 5, date: 'today' }))
      .toBe('attempt 2 of 5 · today');
  });

  it('falls back safely for unknown database labels', () => {
    expect(translate('ru', 'unknown.key')).toBe('unknown.key');
    expect(humanise('waiting_for_client')).toBe('waiting for client');
    expect(humanise('enquiry.status_changed')).toBe('enquiry status changed');
  });
});
