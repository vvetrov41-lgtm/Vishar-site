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

/**
 * Where a suggested price came from. Every source is a suggestion: the only
 * authoritative session price is the one the operator saves (`sessions.price`).
 * - `project`: the project estimate's hourly rate times this session's length.
 *   The final price can still depend on the actual time worked.
 * - `artist`: the artist's optional general rates.
 * A project's total estimate is never split across sessions, and a day price
 * is never inferred from an hourly rate: it is only suggested when an explicit
 * full-day price is configured.
 */
export type PriceSource = 'project' | 'artist';

export interface PriceSuggestion {
  price: number;
  basis: PriceBasis;
  source: PriceSource;
  hours: number;
  rate: number;
  currency: string;
}

export interface SessionPriceInputs {
  /** `projects.hourly_rate` of the project this session belongs to. */
  projectHourlyRate?: number | null;
  projectCurrency?: string | null;
  /** Optional per-artist convenience rates. */
  artistPricing?: ArtistSessionPricing | null;
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
  /** The one channel the card uses: the client's newest real conversation. */
  channel: BookingCardChannel | null;
  channel_outcome: BookingCardChannelOutcome | null;
  channel_evidence_source: string | null;
  channel_evidence_at: string | null;
  channel_decided_at: string | null;
  deliveries: BookingCardDelivery[];
}

export type BookingCardChannel = 'email' | 'whatsapp' | 'instagram';

export type BookingCardChannelOutcome =
  | 'selected'
  | 'no_conversation_channel'
  | 'conversation_channel_unsupported'
  | 'conversation_channel_disabled'
  | 'conversation_channel_unreachable'
  | 'delivery_unavailable';

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function artistFullDay(pricing: ArtistSessionPricing | null | undefined) {
  return pricing && pricing.full_day_rate != null && pricing.full_day_hours != null
    ? { rate: Number(pricing.full_day_rate), hours: Number(pricing.full_day_hours) }
    : null;
}

/**
 * Suggest (never decide) a price for one tattoo session.
 * - With a project hourly rate: hours x that rate. If the project uses the
 *   artist's standard hourly rate and the artist has an explicit full-day
 *   price, a session at least that long suggests the explicit day price.
 * - Without one: the artist's explicit full-day price for a full day,
 *   otherwise hours x the artist's hourly rate.
 * No cap or discount is invented: a long part-day is not reduced to a day
 * price unless that day price is explicitly configured and applies.
 * Returns null when nothing applies.
 */
export function suggestSessionPrice(
  durationMinutes: number | null | undefined,
  pricingOrInputs: ArtistSessionPricing | SessionPriceInputs | null | undefined
): PriceSuggestion | null {
  if (!durationMinutes || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const inputs: SessionPriceInputs = pricingOrInputs && 'artist_id' in pricingOrInputs
    ? { artistPricing: pricingOrInputs as ArtistSessionPricing }
    : (pricingOrInputs as SessionPriceInputs | null) ?? {};
  const hours = durationMinutes / 60;
  const artist = inputs.artistPricing ?? null;
  const fullDay = artistFullDay(artist);

  const projectRate = inputs.projectHourlyRate != null ? Number(inputs.projectHourlyRate) : null;
  if (projectRate != null && Number.isFinite(projectRate) && projectRate > 0) {
    const currency = inputs.projectCurrency || artist?.currency || 'GBP';
    const standardRate = artist?.hourly_rate != null && Number(artist.hourly_rate) === projectRate;
    if (fullDay && standardRate && hours >= fullDay.hours) {
      return { price: roundMoney(fullDay.rate), basis: 'full_day', source: 'project', hours, rate: fullDay.rate, currency };
    }
    return { price: roundMoney(projectRate * hours), basis: 'hourly', source: 'project', hours, rate: projectRate, currency };
  }

  if (!artist) return null;
  if (fullDay && hours >= fullDay.hours) {
    return { price: roundMoney(fullDay.rate), basis: 'full_day', source: 'artist', hours, rate: fullDay.rate, currency: artist.currency };
  }
  if (artist.hourly_rate != null) {
    const rate = Number(artist.hourly_rate);
    return { price: roundMoney(rate * hours), basis: 'hourly', source: 'artist', hours, rate, currency: artist.currency };
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
  locale: string,
  { showSource = true }: { showSource?: boolean } = {}
): string {
  const price = formatSessionMoney(suggestion.price, suggestion.currency, locale);
  const rate = formatSessionMoney(suggestion.rate, suggestion.currency, locale);
  if (suggestion.basis === 'full_day') {
    return language === 'ru'
      ? `${price} · полный день, цена дня из настроек`
      : `${price} · full day, configured day price`;
  }
  const hours = formatHours(suggestion.hours);
  const from = showSource && suggestion.source === 'project'
    ? (language === 'ru' ? ', по ставке проекта' : ', from the project rate')
    : '';
  return language === 'ru' ? `${price} · ${hours} ч × ${rate}${from}` : `${price} · ${hours} h × ${rate}${from}`;
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
    session_price_missing: 'No session price yet: set it in "Sessions without a price" above.',
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
    session_price_missing: 'Нет цены сеанса: укажи её в блоке «Сеансы без цены» выше.',
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

export function bookingCardChannelName(channel: string | null): string {
  if (channel === 'email') return 'Email';
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  return channel ?? '';
}

/** Why a card has no delivery channel; empty when a channel is selected. */
export function bookingCardChannelLabel(
  outcome: string | null,
  channel: string | null,
  language: 'en' | 'ru'
): string {
  const name = bookingCardChannelName(channel);
  const ru = language === 'ru';
  switch (outcome) {
    case null:
    case 'selected':
      return '';
    case 'no_conversation_channel':
      return ru ? 'пока нет канала переписки' : 'no conversation channel yet';
    case 'conversation_channel_unsupported':
      return ru
        ? `последняя переписка в ${name}, туда карточки пока не отправляются`
        : `the latest conversation is on ${name}, where cards can't be sent yet`;
    case 'conversation_channel_disabled':
      return ru ? `отправка карточек в ${name} выключена` : `card sending to ${name} is off`;
    case 'conversation_channel_unreachable':
      return ru ? `клиент недоступен в ${name}` : `the client can't be reached on ${name}`;
    case 'delivery_unavailable':
      return ru ? `карточку для ${name} не удалось подготовить` : `the ${name} card could not be prepared`;
    default:
      return outcome;
  }
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
