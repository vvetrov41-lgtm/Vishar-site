import { cancelLabelFor, confirmDialog } from './confirm-dialog';
import type { Language } from './i18n';
import type { EnquiryStatus } from './types';

/**
 * Only transitions a stray tap would make costly ask first: declining or
 * closing takes the enquiry off the active board, and "deposit paid" records
 * money and starts the deposit conversion. Every other move stays one tap.
 */
export const CONSEQUENTIAL_ENQUIRY_STATUSES: ReadonlySet<EnquiryStatus> = new Set<EnquiryStatus>([
  'declined',
  'closed',
  'deposit_paid',
]);

const COPY: Record<Language, Record<'declined' | 'closed' | 'deposit_paid', { title: string; message: string; action: string }>> = {
  en: {
    declined: { title: 'Decline this enquiry?', message: 'It leaves the active board. You can still find it with the status filter.', action: 'Decline' },
    closed: { title: 'Close this enquiry?', message: 'It leaves the active board. You can still find it with the status filter.', action: 'Close' },
    deposit_paid: { title: 'Mark the deposit as paid?', message: 'Do this only when the money has arrived. It records the deposit and moves the enquiry on.', action: 'Mark paid' },
  },
  ru: {
    declined: { title: 'Отклонить заявку?', message: 'Она уйдёт с активной доски. Найти её можно через фильтр статуса.', action: 'Отклонить' },
    closed: { title: 'Закрыть заявку?', message: 'Она уйдёт с активной доски. Найти её можно через фильтр статуса.', action: 'Закрыть' },
    deposit_paid: { title: 'Отметить депозит оплаченным?', message: 'Только если деньги уже пришли. Депозит будет записан, заявка пойдёт дальше.', action: 'Отметить' },
  },
};

export async function confirmEnquiryTransition(
  to: EnquiryStatus,
  language: Language,
  clientName?: string | null
): Promise<boolean> {
  if (!CONSEQUENTIAL_ENQUIRY_STATUSES.has(to)) return true;
  const copy = COPY[language][to as 'declined' | 'closed' | 'deposit_paid'];
  return confirmDialog({
    title: copy.title,
    message: clientName ? `${clientName}. ${copy.message}` : copy.message,
    confirmLabel: copy.action,
    cancelLabel: cancelLabelFor(language),
    tone: to === 'deposit_paid' ? 'primary' : 'danger',
  });
}
