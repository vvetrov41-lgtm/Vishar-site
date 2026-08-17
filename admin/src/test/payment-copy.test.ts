import { describe, expect, it } from 'vitest';
import { paymentCopy } from '../lib/payment-copy';

describe('Payments localisation', () => {
  it('provides Russian copy for the full Monzo payments workflow', () => {
    const copy = paymentCopy('ru');

    expect(copy.connectionTitle).toBe('Подключение Monzo');
    expect(copy.depositsTitle).toBe('Депозиты');
    expect(copy.requestTitle).toBe('Запросить депозит');
    expect(copy.reconciliationTitle).toBe('Сверка платежей Monzo');
    expect(copy.noCandidates).toBe('Нет платежей Monzo для сверки.');
    expect(copy.match).toBe('Сопоставить');
    expect(copy.confirmPayment).toBe('Подтвердить платёж');
    expect(copy.ignore).toBe('Игнорировать');
    expect(copy.createAmountLink(250)).toBe('Создать ссылку на £250');
    expect(copy.connectionConnected('Vladimir')).toContain('Подключение счёта Monzo');
  });

  it('keeps English copy available for language switching', () => {
    const copy = paymentCopy('en');

    expect(copy.connectionTitle).toBe('Monzo account connection');
    expect(copy.reconciliationTitle).toBe('Monzo reconciliation');
    expect(copy.confirmPayment).toBe('Confirm payment');
    expect(copy.createAmountLink(100)).toBe('Create £100 link');
  });
});
