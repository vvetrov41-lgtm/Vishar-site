import { describe, expect, it, vi } from 'vitest';
import { META_WHATSAPP_APP_ID, META_WHATSAPP_CONFIG_ID } from '../lib/meta-whatsapp-embedded-signup';
import {
  beginEmbeddedSignupRedirect,
  captureEmbeddedSignupCallback,
  createSignupState,
  embeddedSignupDialogUrl,
  META_OAUTH_REDIRECT_URI,
  PENDING_SIGNUP_KEY,
  PENDING_SIGNUP_MAX_AGE_MS,
  setCapturedEmbeddedSignupCallbackForTest,
  takeEmbeddedSignupCallback,
} from '../lib/meta-whatsapp-signup-redirect';

const KRISTINA_ID = '22222222-2222-4222-8222-222222222222';
const NOW = 1_790_000_000_000;
const CODE = 'AQD-one-time-meta-code_for.test';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function fixedRandom(byte: number) {
  return (bytes: Uint8Array) => bytes.fill(byte);
}

function begin(storage = memoryStorage(), now = NOW) {
  const navigate = vi.fn();
  beginEmbeddedSignupRedirect(KRISTINA_ID, { storage, navigate, now: () => now, random: fixedRandom(7) });
  const dialog = new URL(navigate.mock.calls[0][0] as string);
  return { storage, navigate, dialog, state: dialog.searchParams.get('state') as string };
}

describe('CRM-owned Embedded Signup redirect', () => {
  it('builds the Coexistence dialog with one explicit CRM redirect_uri', () => {
    const state = createSignupState(fixedRandom(1));
    const url = new URL(embeddedSignupDialogUrl(state));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: META_WHATSAPP_APP_ID,
      config_id: META_WHATSAPP_CONFIG_ID,
      redirect_uri: 'https://crm.vishartattoo.com/',
      response_type: 'code',
      override_default_response_type: 'true',
      state,
      extras: JSON.stringify({ featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }),
    });
    // No SDK arbiter, no fallback to the current page.
    expect(url.searchParams.has('fallback_redirect_uri')).toBe(false);
    expect(url.searchParams.getAll('redirect_uri')).toEqual([META_OAUTH_REDIRECT_URI]);
  });

  it('creates 256-bit url-safe state and refuses malformed state', () => {
    const state = createSignupState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSignupState()).not.toBe(state);
    expect(() => embeddedSignupDialogUrl('short')).toThrow();
  });

  it('stores the pending artist and navigates this tab, with no popup', () => {
    const open = vi.spyOn(window, 'open');
    const { storage, navigate, state } = begin();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(storage.values.get(PENDING_SIGNUP_KEY) as string)).toEqual({
      state,
      artistId: KRISTINA_ID,
      createdAt: NOW,
    });
    open.mockRestore();
  });

  it('refuses to start for a malformed artist id', () => {
    const navigate = vi.fn();
    expect(() => beginEmbeddedSignupRedirect('../kristina', { storage: memoryStorage(), navigate })).toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns the code once for the matching state and cleans the address bar', () => {
    const { storage, state } = begin();
    const replaceUrl = vi.fn();
    const href = `https://crm.vishartattoo.com/?code=${encodeURIComponent(CODE)}&state=${state}`;

    expect(captureEmbeddedSignupCallback(href, { storage, replaceUrl, now: () => NOW + 5_000 })).toEqual({
      status: 'code',
      artistId: KRISTINA_ID,
      code: CODE,
    });
    expect(replaceUrl).toHaveBeenCalledWith('/#/integrations/whatsapp');
    expect(storage.values.has(PENDING_SIGNUP_KEY)).toBe(false);

    // Replaying the same callback finds no pending state.
    expect(captureEmbeddedSignupCallback(href, { storage, replaceUrl, now: () => NOW + 6_000 })).toEqual({
      status: 'rejected',
      reason: 'state_missing',
    });
  });

  it('rejects a forged state and still burns the pending one', () => {
    const { storage } = begin();
    const forged = 'A'.repeat(43);
    expect(captureEmbeddedSignupCallback(
      `https://crm.vishartattoo.com/?code=${CODE}&state=${forged}`,
      { storage, replaceUrl: vi.fn(), now: () => NOW },
    )).toEqual({ status: 'rejected', reason: 'state_mismatch' });
    expect(storage.values.has(PENDING_SIGNUP_KEY)).toBe(false);
  });

  it('rejects a callback without a started flow in this tab', () => {
    expect(captureEmbeddedSignupCallback(
      `https://crm.vishartattoo.com/?code=${CODE}&state=${'B'.repeat(43)}`,
      { storage: memoryStorage(), replaceUrl: vi.fn(), now: () => NOW },
    )).toEqual({ status: 'rejected', reason: 'state_missing' });
  });

  it('rejects an expired flow', () => {
    const { storage, state } = begin();
    expect(captureEmbeddedSignupCallback(
      `https://crm.vishartattoo.com/?code=${CODE}&state=${state}`,
      { storage, replaceUrl: vi.fn(), now: () => NOW + PENDING_SIGNUP_MAX_AGE_MS + 1 },
    )).toEqual({ status: 'rejected', reason: 'state_expired' });
  });

  it('rejects a malformed code', () => {
    const { storage, state } = begin();
    expect(captureEmbeddedSignupCallback(
      `https://crm.vishartattoo.com/?code=${encodeURIComponent('bad code')}&state=${state}`,
      { storage, replaceUrl: vi.fn(), now: () => NOW },
    )).toEqual({ status: 'rejected', reason: 'code_invalid' });
  });

  it('reports a Meta cancellation for the started artist', () => {
    const { storage, state } = begin();
    expect(captureEmbeddedSignupCallback(
      `https://crm.vishartattoo.com/?error=access_denied&error_reason=user_denied&state=${state}`,
      { storage, replaceUrl: vi.fn(), now: () => NOW },
    )).toEqual({ status: 'cancelled', artistId: KRISTINA_ID });
  });

  it('leaves unrelated URLs and the pending flow untouched', () => {
    const { storage, state } = begin();
    const replaceUrl = vi.fn();
    for (const href of [
      'https://crm.vishartattoo.com/#/integrations/whatsapp',
      `https://crm.vishartattoo.com/?state=${state}`,
      `https://crm.vishartattoo.com/team/?code=${CODE}&state=${state}`,
      `https://evil.example/?code=${CODE}&state=${state}`,
      'not a url',
    ]) {
      expect(captureEmbeddedSignupCallback(href, { storage, replaceUrl, now: () => NOW })).toBeNull();
    }
    expect(replaceUrl).not.toHaveBeenCalled();
    expect(storage.values.has(PENDING_SIGNUP_KEY)).toBe(true);
  });

  it('takes the vetted callback exactly once', () => {
    setCapturedEmbeddedSignupCallbackForTest({ status: 'code', artistId: KRISTINA_ID, code: CODE });
    expect(takeEmbeddedSignupCallback()).toEqual({ status: 'code', artistId: KRISTINA_ID, code: CODE });
    expect(takeEmbeddedSignupCallback()).toBeNull();
  });

  it('runs the same flow for desktop and iPhone Safari user agents', () => {
    const agents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ];
    const outcomes = agents.map((agent) => {
      const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(agent);
      try {
        const { storage, dialog, state } = begin();
        const callback = captureEmbeddedSignupCallback(
          `${dialog.searchParams.get('redirect_uri')}?code=${CODE}&state=${state}`,
          { storage, replaceUrl: vi.fn(), now: () => NOW + 1_000 },
        );
        return { dialog: dialog.toString(), callback };
      } finally {
        userAgent.mockRestore();
      }
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0].callback).toEqual({ status: 'code', artistId: KRISTINA_ID, code: CODE });
  });
});
