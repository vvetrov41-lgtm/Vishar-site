import type { CrmSession, PaymentStatus } from './types';

/**
 * Sessions are operational records, not a ledger of debts.
 * Free consultations have no payment due, although their underlying status
 * defaults to "unpaid". For tattoo work, show a non-accusatory status if
 * the operator has not recorded settlement. Never infer money from duration.
 */
export function paymentBadgeKind(session: Pick<CrmSession, 'appointment_type' | 'payment_status'>): PaymentStatus | 'not_recorded' | null {
  if (session.appointment_type === 'in_person_consultation'
    || session.appointment_type === 'video_consultation') return null;
  if (session.payment_status === 'unpaid') return 'not_recorded';
  return session.payment_status;
}
