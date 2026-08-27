import { describe, expect, it } from 'vitest';
import { paymentCopy } from '../lib/payment-copy';

describe('Payments localisation', () => {
  it('provides Russian copy for the full Monzo payments workflow', () => {
    const copy = paymentCopy('ru');

    expect(copy.connectionTitle).toBe('Подключение Monzo');
    expect(copy.depositsTitle).toBe('Депозиты');
    expect(copy.requestTitle).toBe('Создать новый депозит для отдельного сеанса');
    expect(copy.reconciliationTitle).toBe('Деньги уже пришли? Сопоставить платёж Monzo');
    expect(copy.noCandidates).toBe('Нет платежей Monzo для сверки.');
    expect(copy.match).toBe('Сопоставить');
    expect(copy.confirmPayment).toBe('Подтвердить платёж');
    expect(copy.ignore).toBe('Игнорировать');
    expect(copy.createAmountLink(250)).toBe('Создать новый депозит сеанса на £250');
    expect(copy.requestDescription).toContain('7-часового сеанса');
    expect(copy.requestDescription).toContain('£250');
    expect(copy.requestDescription).toContain('если деньги уже пришли');
    expect(copy.connectionConnected('Vladimir')).toContain('Подключение счёта Monzo');
  });

  it('keeps English copy available for language switching', () => {
    const copy = paymentCopy('en');

    expect(copy.connectionTitle).toBe('Monzo account connection');
    expect(copy.reconciliationTitle).toBe('Already received money? Reconcile Monzo payment');
    expect(copy.confirmPayment).toBe('Confirm payment');
    expect(copy.createAmountLink(100)).toBe('Create new £100 session deposit');
    expect(copy.requestDescription).toContain('7-hour session');
    expect(copy.requestDescription).toContain('already arrived');
  });
});