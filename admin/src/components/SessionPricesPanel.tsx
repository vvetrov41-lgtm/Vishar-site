import { useEffect, useMemo, useState } from 'react';
import type { Appointment } from '../lib/appointment-api';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import {
  formatSessionMoney,
  priceSuggestionLabel,
  suggestSessionPrice,
} from '../lib/session-pricing';
import { useArtistSessionPricing } from './SessionPriceSuggestion';

export function sessionsNeedingPrice(
  appointments: Appointment[],
  priceFor: (appointmentId: string) => number | null,
  now = Date.now()
): Appointment[] {
  return appointments
    .filter((appointment) => appointment.appointment_type === 'tattoo_session')
    .filter((appointment) => ['proposed', 'confirmed'].includes(appointment.status))
    .filter((appointment) => new Date(appointment.end_at).getTime() > now)
    .filter((appointment) => priceFor(appointment.id) === null)
    .sort((left, right) => left.start_at.localeCompare(right.start_at));
}

function minutesOf(appointment: Appointment): number {
  return Math.round((Date.parse(appointment.end_at) - Date.parse(appointment.start_at)) / 60_000);
}

function parsePrice(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 && parsed <= 100000 ? parsed : null;
}

/**
 * Tattoo sessions of this project that still have no price, in one place.
 * Rows are pre-filled with a price SUGGESTION (project estimate rate or the
 * artist's optional rates). Nothing is written until the operator reviews the
 * amounts and confirms Save; only then do they become real session prices,
 * which booking cards use.
 */
export function SessionPricesPanel({
  artistId,
  appointments,
  priceFor,
  projectHourlyRate,
  currency,
  onSaved,
}: {
  artistId: string;
  appointments: Appointment[];
  priceFor: (appointmentId: string) => number | null;
  projectHourlyRate: number | null;
  currency: string;
  onSaved: () => void;
}) {
  const api = useApi();
  const { language, locale } = useLanguage();
  const ru = language === 'ru';
  const artistPricing = useArtistSessionPricing(artistId, true);
  const pending = useMemo(() => sessionsNeedingPrice(appointments, priceFor), [appointments, priceFor]);
  const suggestions = useMemo(() => new Map(pending.map((appointment) => [
    appointment.id,
    suggestSessionPrice(minutesOf(appointment), {
      projectHourlyRate,
      projectCurrency: currency,
      artistPricing,
    }),
  ])), [pending, projectHourlyRate, currency, artistPricing]);
  const [values, setValues] = useState<Record<string, string>>({});
  // Rows the operator has typed into keep their value; untouched rows follow
  // the suggestion, which can arrive after the first render (rates load
  // asynchronously).
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `priceFor` is rebuilt on every parent render; key the pre-fill on the
  // actual rows and suggestions so it runs only when they change.
  const pendingKey = pending
    .map((appointment) => `${appointment.id}:${suggestions.get(appointment.id)?.price ?? ''}`)
    .join('|');

  useEffect(() => {
    setValues((current) => {
      const next: Record<string, string> = {};
      for (const appointment of pending) {
        const suggestion = suggestions.get(appointment.id);
        next[appointment.id] = touched.has(appointment.id)
          ? current[appointment.id] ?? ''
          : (suggestion ? suggestion.price.toFixed(2) : '');
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  if (pending.length === 0) return null;

  const ready = pending
    .map((appointment) => ({ appointment, price: parsePrice(values[appointment.id] ?? '') }))
    .filter((row): row is { appointment: Appointment; price: number } => row.price !== null);
  const invalid = pending.some((appointment) => {
    const raw = (values[appointment.id] ?? '').trim();
    return raw !== '' && parsePrice(raw) === null;
  });

  async function save() {
    if (!ready.length || invalid) return;
    const approved = await confirmDialog({
      title: ru ? 'Сохранить реальные цены сеансов?' : 'Save real session prices?',
      message: ru
        ? `Суммы станут реальными ценами сеансов (${ready.length}). Для подтверждённого сеанса с оплаченным депозитом после этого может сразу уйти карточка записи клиенту по Email и WhatsApp, если отправка включена. Проверь каждую сумму.`
        : `These amounts become real session prices (${ready.length}). For a confirmed session with its deposit paid, the booking card can then go to the client by email and WhatsApp straight away when sending is on. Check every amount.`,
      confirmLabel: ru ? 'Сохранить' : 'Save',
      cancelLabel: cancelLabelFor(language),
      tone: 'primary',
    });
    if (!approved) return;
    setSaving(true);
    setError(null);
    try {
      for (const row of ready) {
        await api.setAppointmentPrice(row.appointment.id, row.price);
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="notice warn session-prices-panel" role="region" aria-label={ru ? 'Цены сеансов' : 'Session prices'}>
      <p style={{ margin: '0 0 8px' }}>
        <strong>{ru ? 'Сеансы без цены' : 'Sessions without a price'}</strong>
        {' · '}
        {ru
          ? 'Ниже только предложения по ставкам. Цена станет настоящей, когда ты её проверишь и сохранишь.'
          : 'These are suggestions from the rates. A price becomes real only when you check and save it.'}
      </p>
      <div className="list">
        {pending.map((appointment) => {
          const suggestion = suggestions.get(appointment.id);
          return (
            <label key={appointment.id} className="row session-price-row" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ flex: '1 1 auto' }}>
                {formatDateTime(appointment.start_at, language)}
                {' · '}
                {(minutesOf(appointment) / 60).toLocaleString(locale)} {ru ? 'ч' : 'h'}
                <span className="meta" style={{ display: 'block' }}>
                  {suggestion
                    ? `${ru ? 'Предложение' : 'Suggestion'}: ${priceSuggestionLabel(suggestion, language, locale)}`
                    : (ru ? 'Нет ставки: укажи цену' : 'No rate: enter the price')}
                </span>
              </span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={ru ? 'Цена сеанса' : 'Session price'}
                style={{ width: '7.5rem', minHeight: 44 }}
                value={values[appointment.id] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setTouched((current) => new Set(current).add(appointment.id));
                  setValues((current) => ({ ...current, [appointment.id]: value }));
                }}
                placeholder={currency}
              />
            </label>
          );
        })}
      </div>
      {invalid ? (
        <p className="notice warn" role="alert">
          {ru ? 'Проверь суммы: не больше двух знаков после точки.' : 'Check the amounts: at most two decimal places.'}
        </p>
      ) : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="primary"
          disabled={saving || invalid || ready.length === 0}
          onClick={() => { void save(); }}
        >
          {saving
            ? (ru ? 'Сохраняем…' : 'Saving…')
            : ru
              ? `Сохранить цены (${ready.length})${ready.length ? ` · ${formatSessionMoney(ready.reduce((sum, row) => sum + row.price, 0), currency, locale)}` : ''}`
              : `Save prices (${ready.length})${ready.length ? ` · ${formatSessionMoney(ready.reduce((sum, row) => sum + row.price, 0), currency, locale)}` : ''}`}
        </button>
      </div>
    </div>
  );
}
