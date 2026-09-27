import { useEffect, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { formatDateTime } from '../lib/format';
import { useApi } from '../lib/session';
import {
  bookingCardReasonLabel,
  formatSessionMoney,
  type BookingCardStatus,
} from '../lib/session-pricing';

/**
 * Shows, for one appointment, whether the Email/WhatsApp booking card goes
 * out and with which amounts, or exactly what is missing. Read-only: the
 * card itself is produced by the database from the stored CRM facts.
 */
export function BookingCardStatusLine({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  refreshKey?: string | number;
}) {
  const api = useApi();
  const { language, locale } = useLanguage();
  const [status, setStatus] = useState<BookingCardStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSessionBookingCardStatus(sessionId)
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [api, sessionId, refreshKey]);

  if (!status) return null;
  const ru = language === 'ru';
  if (status.reason === 'appointment_type_without_card' || status.reason === 'appointment_in_past') {
    return null;
  }

  const label = ru ? 'Карточка записи' : 'Booking card';
  if (!status.eligible) {
    return (
      <p className="meta booking-card-status" data-state="blocked">
        {label}: {bookingCardReasonLabel(status.reason, language)}
      </p>
    );
  }

  const money = status.card_kind === 'tattoo_deposit_paid'
    && status.currency
    && status.deposit_paid != null
    && status.remaining_balance != null
    ? (ru
      ? ` · депозит ${formatSessionMoney(status.deposit_paid, status.currency, locale)}, остаток ${formatSessionMoney(status.remaining_balance, status.currency, locale)}`
      : ` · deposit ${formatSessionMoney(status.deposit_paid, status.currency, locale)}, balance ${formatSessionMoney(status.remaining_balance, status.currency, locale)}`)
    : '';

  let delivery: string;
  if (!status.channels_enabled) {
    delivery = ru ? 'отправка карточек выключена' : 'card sending is off';
  } else if (!status.in_rollout_window) {
    delivery = ru
      ? `отправка для записей с ${status.rollout_starts_at ? formatDateTime(status.rollout_starts_at, language) : '—'}`
      : `sending starts with appointments from ${status.rollout_starts_at ? formatDateTime(status.rollout_starts_at, language) : '—'}`;
  } else if (status.deliveries.length) {
    delivery = status.deliveries
      .map((item) => `${item.channel === 'email' ? 'Email' : 'WhatsApp'}: ${deliveryLabel(item.status, ru)}`)
      .join(', ');
  } else {
    delivery = ru ? 'будет отправлена' : 'will be sent';
  }

  return (
    <p className="meta booking-card-status" data-state="ready">
      {label}{money} · {delivery}
    </p>
  );
}

function deliveryLabel(status: string, ru: boolean): string {
  const labels: Record<string, [string, string]> = {
    pending: ['pending', 'ожидает'],
    queued: ['queued', 'в очереди'],
    sent: ['sent', 'отправлена'],
    failed: ['failed', 'ошибка'],
    skipped: ['skipped', 'пропущена'],
    superseded: ['replaced', 'заменена'],
  };
  const pair = labels[status];
  return pair ? pair[ru ? 1 : 0] : status;
}
