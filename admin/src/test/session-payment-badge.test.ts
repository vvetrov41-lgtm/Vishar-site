import { describe, expect, it } from 'vitest';
import { paymentBadgeKind } from '../lib/session-payment-badge';

describe('sessions payment badge does not imply unpaid consultation debt', () => {
  it('never shows a debt or paid badge for either free consultation', () => {
    for (const appointment_type of ['in_person_consultation','video_consultation'] as const) {
      for (const payment_status of ['unpaid','paid','deposit_paid'] as const) {
        expect(paymentBadgeKind({ appointment_type, payment_status })).toBeNull();
      }
    }
  });
  it('keeps tattoo and touch-up settlements visible without asserting a debt', () => {
    for (const appointment_type of ['tattoo_session','touch_up'] as const) {
      expect(paymentBadgeKind({ appointment_type, payment_status: 'unpaid' })).toBe('not_recorded');
      expect(paymentBadgeKind({ appointment_type, payment_status: 'deposit_paid' })).toBe('deposit_paid');
      expect(paymentBadgeKind({ appointment_type, payment_status: 'part_paid' })).toBe('part_paid');
      expect(paymentBadgeKind({ appointment_type, payment_status: 'paid' })).toBe('paid');
      expect(paymentBadgeKind({ appointment_type, payment_status: 'refunded' })).toBe('refunded');
    }
  });
});
