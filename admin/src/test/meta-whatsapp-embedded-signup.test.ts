import { describe, expect, it, vi } from 'vitest';
import {
  describeWhatsAppEmbeddedSignupError,
  FACEBOOK_ALLOWED_MESSAGE_ORIGINS,
  launchWhatsAppEmbeddedSignup,
  parseEmbeddedSignupMessage,
  prepareWhatsAppEmbeddedSignup,
  WhatsAppEmbeddedSignupError,
} from '../lib/meta-whatsapp-embedded-signup';

describe('Meta WhatsApp Embedded Signup event boundary', () => {
  it('accepts only the exact desktop, web and mobile Facebook origins', () => {
    expect([...FACEBOOK_ALLOWED_MESSAGE_ORIGINS].sort()).toEqual([
      'https://m.facebook.com',
      'https://web.facebook.com',
      'https://www.facebook.com',
    ]);
  });

  it('extracts WABA and phone-number ids from a standard FINISH event', () => {
    expect(parseEmbeddedSignupMessage('https://m.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '12345678901', phone_number_id: '10987654321' },
    })).toEqual({
      event: 'FINISH',
      wabaId: '12345678901',
      phoneNumberId: '10987654321',
      currentStep: null,
      providerError: null,
    });
  });

  it('accepts the WhatsApp Business App coexistence completion with WABA only', () => {
    expect(parseEmbeddedSignupMessage('https://www.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      version: 3,
      data: { waba_id: '12345678901' },
    })).toEqual({
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      wabaId: '12345678901',
      phoneNumberId: null,
      currentStep: null,
      providerError: null,
    });
  });

  it('rejects spoofed origins and malformed provider ids', () => {
    expect(parseEmbeddedSignupMessage('https://evil.example', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '12345678901', phone_number_id: '10987654321' },
    })).toBeNull();

    expect(parseEmbeddedSignupMessage('https://www.facebook.com', JSON.stringify({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { waba_id: '../bad', phone_number_id: 'phone' },
    }))).toEqual({
      event: 'FINISH',
      wabaId: null,
      phoneNumberId: null,
      currentStep: null,
      providerError: null,
    });
  });

  it('preserves credential-free CANCEL and ERROR diagnostics as terminal Meta events', () => {
    expect(parseEmbeddedSignupMessage('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'phone_number_verification' },
    })).toEqual({
      event: 'CANCEL',
      wabaId: null,
      phoneNumberId: null,
      currentStep: 'phone_number_verification',
      providerError: null,
    });
    expect(parseEmbeddedSignupMessage('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'ERROR',
      data: {
        current_step: '../unsafe',
        error_message: 'Account 12345678901 for owner@example.com failed at https://example.com/private',
      },
    })).toEqual({
      event: 'ERROR',
      wabaId: null,
      phoneNumberId: null,
      currentStep: null,
      providerError: 'Account [id] for [email] failed at [url]',
    });
  });

  it('formats stable localized diagnostic codes without provider identifiers', () => {
    const cause = new WhatsAppEmbeddedSignupError('WA_META_PROVIDER_ERROR', {
      currentStep: 'business_information',
      providerError: 'Configuration is unavailable',
    });
    expect(describeWhatsAppEmbeddedSignupError(cause, 'en')).toBe(
      '[WA_META_PROVIDER_ERROR] Meta reported an Embedded Signup error. '
      + '(step=business_information, provider=Configuration is unavailable)',
    );
    expect(describeWhatsAppEmbeddedSignupError(cause, 'ru')).toContain('[WA_META_PROVIDER_ERROR]');
  });

  it('calls FB.login synchronously after the SDK has been prepared', async () => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    let loginCalls = 0;
    window.FB = {
      init() {},
      login(callback) {
        loginCalls += 1;
        callback({ status: 'not_authorized' });
      },
    };
    try {
      await prepareWhatsAppEmbeddedSignup();
      const result = launchWhatsAppEmbeddedSignup();
      expect(loginCalls).toBe(1);
      await expect(result).rejects.toMatchObject({ code: 'WA_META_LOGIN_NOT_AUTHORIZED' });
    } finally {
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });

  it('re-initializes a replaced FB object synchronously before login', async () => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    let replacementInitCalls = 0;
    let replacementLoginCalls = 0;
    window.FB = {
      init() {},
      login(callback) {
        callback({ status: 'not_authorized' });
      },
    };
    try {
      await prepareWhatsAppEmbeddedSignup();
      window.FB = {
        init() { replacementInitCalls += 1; },
        login(callback) {
          replacementLoginCalls += 1;
          callback({ status: 'not_authorized' });
        },
      };
      const result = launchWhatsAppEmbeddedSignup();
      expect(replacementInitCalls).toBe(1);
      expect(replacementLoginCalls).toBe(1);
      await expect(result).rejects.toMatchObject({ code: 'WA_META_LOGIN_NOT_AUTHORIZED' });
    } finally {
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });

  it.each([
    ['unknown', 'WA_META_LOGIN_UNKNOWN'],
    ['connected', 'WA_META_LOGIN_CONNECTED_NO_CODE'],
    ['unexpected', 'WA_META_LOGIN_NO_CODE'],
    [undefined, 'WA_META_LOGIN_EMPTY_RESPONSE'],
  ] as const)('classifies a %s login callback without a code', async (status, code) => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    window.FB = {
      init() {},
      login(callback) { callback({ status }); },
    };
    try {
      await prepareWhatsAppEmbeddedSignup();
      await expect(launchWhatsAppEmbeddedSignup()).rejects.toMatchObject({ code });
    } finally {
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });

  it('keeps FB.login synchronous and resolves only after code plus FINISH', async () => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    let loginCallback: ((response: { authResponse?: { code?: string }; status?: string }) => void) | null = null;
    let loginOptions: Record<string, unknown> | null = null;
    window.FB = {
      init() {},
      login(callback, options) {
        loginCallback = callback;
        loginOptions = options;
      },
    };
    try {
      await prepareWhatsAppEmbeddedSignup();
      const result = launchWhatsAppEmbeddedSignup();
      expect(loginCallback).not.toBeNull();
      expect(loginOptions).toMatchObject({
        config_id: '4468652066715473',
        response_type: 'code',
        override_default_response_type: true,
      });
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://www.facebook.com',
        data: {
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'FINISH',
          data: { waba_id: '12345678901', phone_number_id: '10987654321' },
        },
      }));
      const capturedLoginCallback = loginCallback as null | ((response: {
        authResponse?: { code?: string };
        status?: string;
      }) => void);
      if (!capturedLoginCallback) throw new Error('FB.login callback was not captured');
      capturedLoginCallback({ status: 'connected', authResponse: { code: ' one-time-code ' } });
      await expect(result).resolves.toEqual({
        authorizationCode: 'one-time-code',
        wabaId: '12345678901',
        phoneNumberId: '10987654321',
        event: 'FINISH',
      });
    } finally {
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });

  it('fails when Meta never returns the login callback', async () => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    vi.useFakeTimers();
    window.FB = { init() {}, login() {} };
    try {
      await prepareWhatsAppEmbeddedSignup();
      const result = launchWhatsAppEmbeddedSignup();
      const rejection = expect(result).rejects.toMatchObject({ code: 'WA_META_TIMEOUT_WAITING_FOR_LOGIN' });
      await vi.advanceTimersByTimeAsync(60000);
      await rejection;
    } finally {
      vi.useRealTimers();
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });

  it('returns a code-only result when Meta omits the WhatsApp session message', async () => {
    const originalFb = window.FB;
    const originalAsyncInit = window.fbAsyncInit;
    vi.useFakeTimers();
    window.FB = {
      init() {},
      login(callback) {
        callback({ status: 'connected', authResponse: { code: 'one-time-code' } });
      },
    };
    try {
      await prepareWhatsAppEmbeddedSignup();
      const result = launchWhatsAppEmbeddedSignup();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(result).resolves.toEqual({
        authorizationCode: 'one-time-code',
        event: 'CODE_ONLY',
        wabaId: null,
        phoneNumberId: null,
      });
    } finally {
      vi.useRealTimers();
      window.FB = originalFb;
      window.fbAsyncInit = originalAsyncInit;
    }
  });
});
