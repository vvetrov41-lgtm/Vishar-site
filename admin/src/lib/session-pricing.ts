import { ApiError, friendlyMessage, type ApiOperation, type CrmClient } from './api';

/**
 * Per-artist session rates. They only ever *suggest* a session price in the
 * CRM; the stored `sessions.price` is the single source of truth used by
 * booking cards, so Email and WhatsApp never recalculate money.
 */
export interface ArtistSessionPricing {
  artist_id: string;
  configured: boolean;
  currency: string;
  hourly_rate: number | null;
  full_day_rate: number | null;
  full_day_hours: number | null;
  session_deposit_amount: number | null;
  updated_at: string | null;
}

export interface SessionPricingInput {
  artistId: string;
  hourlyRate: number | null;
  fullDayRate: number | null;
  fullDayHours: number | null;
  sessionDepositAmount: number | null;
  currency?: string;
}

export type PriceBasis = 'full_day' | 'hourly';

export interface PriceSuggestion {
  price: number;
  basis: PriceBasis;
  hours: number;
  rate: number;
  currency: string;
}

export type BookingCardReason =
  | 'ready'
  | 'session_not_found'
  | 'artist_inactive'
  | 'client_archived'
  | 'not_confirmed'
  | 'appointment_in_past'
  | 'artist_timezone_missing'
  | 'appointment_type_without_card'
  | 'session_price_missing'
  | 'deposit_not_paid_for_session'
  | 'deposit_currency_mismatch'
  | 'deposit_exceeds_price';

export interface BookingCardDelivery {
  channel: 'email' | 'whatsapp';
  status: 'pending' | 'skipped' | 'queued' | 'sent' | 'failed' | 'superseded';
  skip_reason: string | null;
  queued_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
}

export interface BookingCardStatus {
  session_id: string;
  eligible: boolean;
  reason: BookingCardReason | string | null;
  card_kind: 'tattoo_deposit_paid' | 'consultation_booked' | null;
  currency: string | null;
  session_price: number | null;
  deposit_paid: number | null;
  remaining_balance: number | null;
  deposit_source: string | null;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  channels_enabled: boolean;
  in_rollout_window: boolean;
  rollout_starts_at: string | null;
  card: { revision: number; created_at: string; card_kind: string } | null;
  deliveries: BookingCardDelivery[];
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

/**
 * Suggest a price for one tattoo session from the artist's own rates:
 * a session at least as long as the artist's full day is the full-day rate,
 * a shorter one is hours × hourly rate (capped at the full-day rate, so a
 * long part-day is never dearer than a whole day). Returns null when the
 * artist has not configured a rate that applies.
 */
export function suggestSessionPrice(
  durationMinutes: number | null | undefined,
  pricing: ArtistSessionPricing | null | undefined
): PriceSuggestion | null {
  if (!pricing || !durationMinutes || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const hours = durationMinutes / 60;
  const fullDay = pricing.full_day_rate != null && pricing.full_day_hours != null
    ? { rate: Number(pricing.full_day_rate), hours: Number(pricing.full_day_hours) }
    : null;

  if (fullDay && hours >= fullDay.hours) {
    return { price: roundMoney(fullDay.rate), basis: 'full_day', hours, rate: fullDay.rate, currency: pricing.currency };
  }
  if (pricing.hourly_rate != null) {
    const rate = Number(pricing.hourly_rate);
    const hourly = roundMoney(rate * hours);
    const price = fullDay ? Math.min(hourly, roundMoney(fullDay.rate)) : hourly;
    return { price, basis: 'hourly', hours, rate, currency: pricing.currency };
  }
  return null;
}

export function formatSessionMoney(amount: number, currency: string, locale: string): string {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, '');
}

export function priceSuggestionLabel(
  suggestion: PriceSuggestion,
  language: 'en' | 'ru',
  locale: string
): string {
  const price = formatSessionMoney(suggestion.price, suggestion.currency, locale);
  const rate = formatSessionMoney(suggestion.rate, suggestion.currency, locale);
  if (suggestion.basis === 'full_day') {
    return language === 'ru' ? `${price} · полный день` : `${price} · full day`;
  }
  const hours = formatHours(suggestion.hours);
  return language === 'ru' ? `${price} · ${hours} ч × ${rate}` : `${price} · ${hours} h × ${rate}`;
}

const REASON_COPY: Record<'en' | 'ru', Record<string, string>> = {
  en: {
    ready: 'Ready',
    not_confirmed: 'Sent only for a confirmed appointment.',
    appointment_in_past: 'The appointment is in the past.',
    client_archived: 'The client is archived.',
    artist_inactive: 'The artist is inactive.',
    artist_timezone_missing: 'The artist has no time zone set.',
    appointment_type_without_card: 'This appointment type has no booking card.',
    session_price_missing: 'Set the session price to send the booking card.',
    deposit_not_paid_for_session: 'No paid deposit covers this session yet.',
    deposit_currency_mismatch: 'The deposit currency differs from the session currency.',
    deposit_exceeds_price: 'The deposit is larger than the session price. Check the price.',
    session_not_found: 'Appointment not found.',
  },
  ru: {
    ready: 'Готово',
    not_confirmed: 'Отправляется только для подтверждённой записи.',
    appointment_in_past: 'Запись уже в прошлом.',
    client_archived: 'Клиент в архиве.',
    artist_inactive: 'Артист неактивен.',
    artist_timezone_missing: 'У артиста не указан часовой пояс.',
    appointment_type_without_card: 'Для этого типа записи карточка не отправляется.',
    session_price_missing: 'Укажи стоимость сеанса, чтобы отправить карточку.',
    deposit_not_paid_for_session: 'Оплаченный депозит пока не покрывает этот сеанс.',
    deposit_currency_mismatch: 'Валюта депозита не совпадает с валютой сеанса.',
    deposit_exceeds_price: 'Депозит больше стоимости сеанса. Проверь цену.',
    session_not_found: 'Запись не найдена.',
  },
};

export function bookingCardReasonLabel(reason: string | null, language: 'en' | 'ru'): string {
  if (!reason) return '';
  return REASON_COPY[language][reason] ?? reason;
}

function unwrap<T>(result: { data: T | null; error: any }, what: ApiOperation): T {
  if (result.error) {
    throw new ApiError(friendlyMessage(result.error, what), result.error);
  }
  return result.data as T;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalisePricing(raw: Record<string, unknown>): ArtistSessionPricing {
  return {
    artist_id: String(raw.artist_id),
    configured: Boolean(raw.configured),
    currency: typeof raw.currency === 'string' ? raw.currency : 'GBP',
    hourly_rate: toNumber(raw.hourly_rate),
    full_day_rate: toNumber(raw.full_day_rate),
    full_day_hours: toNumber(raw.full_day_hours),
    session_deposit_amount: toNumber(raw.session_deposit_amount),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

function normaliseStatus(raw: Record<string, unknown>): BookingCardStatus {
  return {
    ...(raw as unknown as BookingCardStatus),
    session_price: toNumber(raw.session_price),
    deposit_paid: toNumber(raw.deposit_paid),
    remaining_balance: toNumber(raw.remaining_balance),
    deliveries: Array.isArray(raw.deliveries) ? (raw.deliveries as BookingCardDelivery[]) : [],
  };
}

export function createSessionPricingApi(client: CrmClient) {
  return {
    async getArtistSessionPricing(artistId: string): Promise<ArtistSessionPricing> {
      return normalisePricing(unwrap<Record<string, unknown>>(
        await client.rpc('get_artist_session_pricing', { p_artist_id: artistId }),
        'load the session rates'
      ));
    },

    async setArtistSessionPricing(input: SessionPricingInput): Promise<ArtistSessionPricing> {
      return normalisePricing(unwrap<Record<string, unknown>>(
        await client.rpc('set_artist_session_pricing', {
          p_artist_id: input.artistId,
          p_hourly_rate: input.hourlyRate,
          p_full_day_rate: input.fullDayRate,
          p_full_day_hours: input.fullDayHours,
          p_session_deposit_amount: input.sessionDepositAmount,
          p_currency: input.currency ?? 'GBP',
        }),
        'save the session rates'
      ));
    },

    async getSessionBookingCardStatus(sessionId: string): Promise<BookingCardStatus> {
      return normaliseStatus(unwrap<Record<string, unknown>>(
        await client.rpc('get_session_booking_card_status', { p_session_id: sessionId }),
        'load the booking card status'
      ));
    },
  };
}

export type SessionPricingApi = ReturnType<typeof createSessionPricingApi>;
