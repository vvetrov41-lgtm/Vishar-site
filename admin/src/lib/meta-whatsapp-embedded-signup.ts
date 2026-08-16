export const META_WHATSAPP_APP_ID = '894809783179152';
export const META_WHATSAPP_CONFIG_ID = '1321039629476766';

const FACEBOOK_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
export const FACEBOOK_ALLOWED_MESSAGE_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
  'https://m.facebook.com',
]);

interface FacebookLoginResponse {
  authResponse?: {
    code?: string;
  };
  status?: string;
}

interface FacebookSdk {
  init(config: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: {
        setup: Record<string, never>;
        featureType: 'whatsapp_business_app_onboarding';
        sessionInfoVersion: '3';
      };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

export interface WhatsAppEmbeddedSignupResult {
  authorizationCode: string;
  wabaId: string;
  phoneNumberId: string;
  event: 'FINISH';
}

export interface EmbeddedSignupMessage {
  event: 'FINISH' | 'CANCEL' | 'ERROR';
  wabaId: string | null;
  phoneNumberId: string | null;
}

let sdkPromise: Promise<FacebookSdk> | null = null;

function numericProviderId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]{5,32}$/.test(value.trim()) ? value.trim() : null;
}

export function parseEmbeddedSignupMessage(origin: string, data: unknown): EmbeddedSignupMessage | null {
  if (!FACEBOOK_ALLOWED_MESSAGE_ORIGINS.has(origin)) return null;

  let payload = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  if (record.type !== 'WA_EMBEDDED_SIGNUP') return null;
  if (record.event !== 'FINISH' && record.event !== 'CANCEL' && record.event !== 'ERROR') return null;

  const session = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : {};

  return {
    event: record.event,
    wabaId: numericProviderId(session.waba_id),
    phoneNumberId: numericProviderId(session.phone_number_id),
  };
}

function loadFacebookSdk(): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-vishar-meta-sdk="true"]');
    const script = existing ?? document.createElement('script');

    const timeout = window.setTimeout(() => reject(new Error('Meta SDK did not load in time.')), 15000);
    window.fbAsyncInit = () => {
      window.clearTimeout(timeout);
      if (!window.FB) {
        reject(new Error('Meta SDK loaded without FB object.'));
        return;
      }
      window.FB.init({
        appId: META_WHATSAPP_APP_ID,
        autoLogAppEvents: false,
        xfbml: false,
        version: 'v25.0',
      });
      resolve(window.FB);
    };

    if (!existing) {
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = FACEBOOK_SDK_URL;
      script.dataset.visharMetaSdk = 'true';
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not load Meta SDK.'));
      };
      document.head.appendChild(script);
    }
  });

  return sdkPromise;
}

export async function launchWhatsAppEmbeddedSignup(): Promise<WhatsAppEmbeddedSignupResult> {
  const fb = await loadFacebookSdk();

  return new Promise((resolve, reject) => {
    let authorizationCode: string | null = null;
    let finishedSession: EmbeddedSignupMessage | null = null;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const maybeResolve = () => {
      if (settled || !authorizationCode || finishedSession?.event !== 'FINISH') return;
      if (!finishedSession.wabaId || !finishedSession.phoneNumberId) {
        rejectOnce(new Error('Meta finished onboarding without a complete WhatsApp account session.'));
        return;
      }
      settled = true;
      cleanup();
      resolve({
        authorizationCode,
        wabaId: finishedSession.wabaId,
        phoneNumberId: finishedSession.phoneNumberId,
        event: 'FINISH',
      });
    };

    const onMessage = (messageEvent: MessageEvent) => {
      const parsed = parseEmbeddedSignupMessage(messageEvent.origin, messageEvent.data);
      if (!parsed) return;
      if (parsed.event === 'CANCEL') {
        rejectOnce(new Error('Meta Embedded Signup was cancelled.'));
        return;
      }
      if (parsed.event === 'ERROR') {
        rejectOnce(new Error('Meta reported an Embedded Signup error.'));
        return;
      }
      finishedSession = parsed;
      maybeResolve();
    };

    window.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => {
      rejectOnce(new Error('Meta Embedded Signup timed out.'));
    }, 10 * 60 * 1000);

    fb.login((response) => {
      const code = response.authResponse?.code?.trim() || '';
      if (!code) {
        rejectOnce(new Error(
          response.status === 'not_authorized'
            ? 'Meta authorization was not granted.'
            : 'Meta Embedded Signup was cancelled or returned no authorization code.',
        ));
        return;
      }
      // The one-time authorization code remains only in memory until the
      // authenticated production backend consumes it. It is never logged or displayed.
      authorizationCode = code;
      maybeResolve();
    }, {
      config_id: META_WHATSAPP_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
  });
}
