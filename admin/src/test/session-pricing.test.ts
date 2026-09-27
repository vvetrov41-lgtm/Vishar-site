import { describe, expect, it } from 'vitest';
import {
  bookingCardReasonLabel,
  formatSessionMoney,
  priceSuggestionLabel,
  suggestSessionPrice,
  type ArtistSessionPricing,
} from '../lib/session-pricing';

const vladimir: ArtistSessionPricing = {
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  configured: true,
  currency: 'GBP',
  hourly_rate: 140,
  full_day_rate: 980,
  full_day_hours: 7,
  session_deposit_amount: 250,
  updated_at: null,
};

// Kristina sets her own values in the CRM; these are test values, not hers.
const otherArtist: ArtistSessionPricing = {
  ...vladimir,
  artist_id: 'a2222222-2222-4222-8222-222222222222',
  hourly_rate: 120,
  full_day_rate: 750,
  full_day_hours: 6.5,
  session_deposit_amount: null,
};

describe('suggestSessionPrice', () => {
  it('prices a full day at the full-day rate', () => {
    expect(suggestSessionPrice(7 * 60, vladimir)).toMatchObject({ price: 980, basis: 'full_day' });
    expect(suggestSessionPrice(8 * 60, vladimir)).toMatchObject({ price: 980, basis: 'full_day' });
  });

  it('prices a shorter session by the hour', () => {
    expect(suggestSessionPrice(4 * 60, vladimir)).toMatchObject({ price: 560, basis: 'hourly', hours: 4 });
    expect(suggestSessionPrice(3 * 60, vladimir)).toMatchObject({ price: 420, basis: 'hourly' });
    expect(suggestSessionPrice(90, vladimir)).toMatchObject({ price: 210, basis: 'hourly' });
  });

  it('uses each artist\'s own configuration, never another artist\'s prices', () => {
    expect(suggestSessionPrice(6.5 * 60, otherArtist)).toMatchObject({ price: 750, basis: 'full_day' });
    expect(suggestSessionPrice(5 * 60, otherArtist)).toMatchObject({ price: 600, basis: 'hourly' });
    // 6 h x £120 = £720, still below that artist's £750 day.
    expect(suggestSessionPrice(6 * 60, otherArtist)).toMatchObject({ price: 720 });
  });

  it('never makes a part day dearer than a full day', () => {
    const steepHourly = { ...otherArtist, hourly_rate: 140 };
    expect(suggestSessionPrice(6 * 60, steepHourly)).toMatchObject({ price: 750, basis: 'hourly' });
  });

  it('suggests nothing without configured rates or a duration', () => {
    const empty: ArtistSessionPricing = {
      ...vladimir, configured: false, hourly_rate: null, full_day_rate: null, full_day_hours: null,
    };
    expect(suggestSessionPrice(420, empty)).toBeNull();
    expect(suggestSessionPrice(420, null)).toBeNull();
    expect(suggestSessionPrice(0, vladimir)).toBeNull();
    expect(suggestSessionPrice(null, vladimir)).toBeNull();
  });

  it('with only a full-day rate, a short session gets no guess', () => {
    const dayOnly = { ...vladimir, hourly_rate: null };
    expect(suggestSessionPrice(4 * 60, dayOnly)).toBeNull();
    expect(suggestSessionPrice(7 * 60, dayOnly)).toMatchObject({ price: 980 });
  });
});

describe('labels', () => {
  it('formats money and the suggestion basis', () => {
    expect(formatSessionMoney(1500, 'GBP', 'en-GB')).toBe('£1,500');
    expect(formatSessionMoney(62.5, 'GBP', 'en-GB')).toBe('£62.50');
    expect(priceSuggestionLabel(suggestSessionPrice(420, vladimir)!, 'en', 'en-GB')).toBe('£980 · full day');
    expect(priceSuggestionLabel(suggestSessionPrice(240, vladimir)!, 'en', 'en-GB')).toBe('£560 · 4 h × £140');
  });

  it('explains why a card is blocked', () => {
    expect(bookingCardReasonLabel('session_price_missing', 'en')).toMatch(/session price/);
    expect(bookingCardReasonLabel('deposit_not_paid_for_session', 'ru')).toMatch(/депозит/);
    expect(bookingCardReasonLabel('unknown_reason', 'en')).toBe('unknown_reason');
  });
});
