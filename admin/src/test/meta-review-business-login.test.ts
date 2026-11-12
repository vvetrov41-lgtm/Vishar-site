import { describe, expect, it, vi } from 'vitest';
import {
  beginBusinessReviewLogin,
  businessReviewDialogUrl,
  businessReviewWasInterrupted,
  captureBusinessReviewCallback,
  BUSINESS_REVIEW_REDIRECT_URI,
  BUSINESS_REVIEW_PENDING_KEY,
  BUSINESS_REVIEW_MAX_AGE_MS,
} from '../lib/meta-review-business-login';

const CONFIG_ID = '123456789012345';
const NOW = 1_790_000_000_000;
const CODE = 'AQD-unique-business-review-authorization-code';
function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}
function begin() {
  const store = storage();
  const navigate = vi.fn();
  beginBusinessReviewLogin(CONFIG_ID, {
    origin: 'https://app.vishartattoo.com',
    storage: store, navigate, now: () => NOW,
    random: (bytes) => bytes.fill(7),
  });
  const dialog = new URL(navigate.mock.calls[0][0] as string);
  return { store, dialog, state: dialog.searchParams.get('state') as string };
}
describe('isolated business_management login', () => {
  it('asks for General Business Login without WhatsApp onboarding extras', () => {
    const { dialog, store } = begin();
    expect(dialog.origin).toBe('https://www.facebook.com');
    expect(dialog.searchParams.get('config_id')).toBe(CONFIG_ID);
    expect(dialog.searchParams.get('client_id')).toBe('1481226093843982');
    expect(dialog.searchParams.get('redirect_uri')).toBe(BUSINESS_REVIEW_REDIRECT_URI);
    expect(dialog.searchParams.has('extras')).toBe(false);
    expect(dialog.searchParams.has('scope')).toBe(false); // configured in Meta, not overridden.
    expect(dialog.searchParams.has('fallback_redirect_uri')).toBe(false);
    expect(store.entries.has(BUSINESS_REVIEW_PENDING_KEY)).toBe(true);
    expect(() => businessReviewDialogUrl('../unsafe', 'invalid')).toThrow();
  });
  it('supports a separate fallback that requests only business_management without config_id', () => {
    const store = storage();
    const navigate = vi.fn();
    beginBusinessReviewLogin(CONFIG_ID, {
      origin: 'https://app.vishartattoo.com',
      storage: store,
      navigate,
      ios: true,
      method: 'permission',
      now: () => NOW,
      random: (bytes) => bytes.fill(9),
    });
    const dialog = new URL(navigate.mock.calls[0][0] as string);
    expect(dialog.origin).toBe('https://m.facebook.com');
    expect(dialog.searchParams.get('scope')).toBe('business_management');
    expect(dialog.searchParams.has('config_id')).toBe(false);
    expect(dialog.searchParams.has('override_default_response_type')).toBe(false);
    expect(dialog.searchParams.has('extras')).toBe(false);
    expect(dialog.searchParams.get('client_id')).toBe('1481226093843982');
    expect(dialog.searchParams.get('redirect_uri')).toBe(BUSINESS_REVIEW_REDIRECT_URI);
    const state = dialog.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = `https://app.vishartattoo.com/?meta_business_review=1&state=${state}&code=${CODE}`;
    expect(captureBusinessReviewCallback(callback, {
      storage: store, replaceUrl: vi.fn(), now: () => NOW + 100,
    })).toEqual({ status: 'code', code: CODE });
    expect(store.entries.has(BUSINESS_REVIEW_PENDING_KEY)).toBe(false);
  });
  it('rejects unknown login methods before navigating', () => {
    const navigate = vi.fn();
    expect(() => beginBusinessReviewLogin(CONFIG_ID, {
      origin: 'https://app.vishartattoo.com',
      storage: storage(), navigate, method: 'invalid' as never,
      random: (bytes) => bytes.fill(2),
    })).toThrow('Meta review login method invalid');
    expect(navigate).not.toHaveBeenCalled();
  });
  it('routes iOS web login to mobile Facebook without changing the scope or redirect URI', () => {
    const store = storage();
    const navigate = vi.fn();
    beginBusinessReviewLogin(CONFIG_ID, {
      origin: 'https://app.vishartattoo.com',
      storage: store,
      navigate,
      ios: true,
      now: () => NOW,
      random: (bytes) => bytes.fill(11),
    });
    const dialog = new URL(navigate.mock.calls[0][0] as string);
    expect(dialog.origin).toBe('https://m.facebook.com');
    expect(dialog.pathname).toBe('/v25.0/dialog/oauth');
    expect(dialog.searchParams.get('display')).toBe('touch');
    expect(dialog.searchParams.get('config_id')).toBe(CONFIG_ID);
    expect(dialog.searchParams.get('redirect_uri')).toBe(BUSINESS_REVIEW_REDIRECT_URI);
    expect(dialog.searchParams.get('response_type')).toBe('code');
    expect(dialog.searchParams.has('scope')).toBe(false);
    expect(dialog.searchParams.has('extras')).toBe(false);
  });
  it('detects Safari returning unchanged after Facebook app steals the navigation', () => {
    const { store, state } = begin();
    expect(businessReviewWasInterrupted('https://app.vishartattoo.com/#/integrations/whatsapp', store))
      .toBe(true);
    expect(businessReviewWasInterrupted('https://app.vishartattoo.com/?meta_business_review=1&code=abc&state=' + state, store))
      .toBe(false);
    expect(businessReviewWasInterrupted('https://crm.vishartattoo.com/#/integrations/whatsapp', store))
      .toBe(false);
    expect(businessReviewWasInterrupted('https://facebook.com/v25.0/dialog/oauth', store))
      .toBe(false);
    store.removeItem(BUSINESS_REVIEW_PENDING_KEY);
    expect(businessReviewWasInterrupted('https://app.vishartattoo.com/#/integrations/whatsapp', store))
      .toBe(false);
  });
  it('refuses to start on public CRM and cannot touch WhatsApp setup', () => {
    const navigate = vi.fn();
    expect(() => beginBusinessReviewLogin(CONFIG_ID, {
      origin: 'https://crm.vishartattoo.com', navigate, storage: storage(),
    })).toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('accepts only one matching code and immediately clears the address', () => {
    const { store, state } = begin();
    const replaceUrl = vi.fn();
    const callback = `https://app.vishartattoo.com/?meta_business_review=1&state=${state}&code=${encodeURIComponent(CODE)}`;
    expect(captureBusinessReviewCallback(callback, { storage: store, replaceUrl, now: () => NOW + 100 }))
      .toEqual({ status: 'code', code: CODE });
    expect(replaceUrl).toHaveBeenCalledWith('/#/integrations/whatsapp');
    expect(store.entries.has(BUSINESS_REVIEW_PENDING_KEY)).toBe(false);
    expect(captureBusinessReviewCallback(callback, { storage: store, replaceUrl, now: () => NOW + 101 }))
      .toEqual({ status: 'rejected', reason: 'state_missing' });
  });
  it('rejects modified state, expired state and foreign origins', () => {
    const { store, state } = begin();
    const base = `https://app.vishartattoo.com/?meta_business_review=1&code=${CODE}&state=`;
    expect(captureBusinessReviewCallback(base + 'm'.repeat(43), { storage: store, replaceUrl: vi.fn(), now: () => NOW }))
      .toEqual({ status: 'rejected', reason: 'state_mismatch' });
    expect(captureBusinessReviewCallback(base + state, { storage: store, replaceUrl: vi.fn(), now: () => NOW }))
      .toEqual({ status: 'rejected', reason: 'state_missing' });
    const fresh = begin();
    expect(captureBusinessReviewCallback(base + fresh.state, {
      storage: fresh.store, replaceUrl: vi.fn(), now: () => NOW + BUSINESS_REVIEW_MAX_AGE_MS + 1,
    })).toEqual({ status: 'rejected', reason: 'state_expired' });
    expect(captureBusinessReviewCallback('https://crm.vishartattoo.com/?meta_business_review=1&code=xxx', {
      storage: storage(), replaceUrl: vi.fn(),
    })).toBeNull();
  });
  it('returns cancellation without an authorization code', () => {
    const { store, state } = begin();
    expect(captureBusinessReviewCallback(
      `https://app.vishartattoo.com/?meta_business_review=1&state=${state}&error=access_denied`,
      { storage: store, replaceUrl: vi.fn(), now: () => NOW + 100 },
    )).toEqual({ status: 'cancelled' });
  });
});
