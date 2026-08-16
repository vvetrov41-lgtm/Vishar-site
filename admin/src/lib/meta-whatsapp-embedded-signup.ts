export const META_WHATSAPP_APP_ID = '1481226093843982';
export const META_WHATSAPP_CONFIG_ID = '4468652066715473';

const FACEBOOK_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
const FACEBOOK_ALLOWED_MESSAGE_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
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
  authorizationCode: string | null;
  wabaId: string | null;
  event: string | null;
}

let sdkPromise: Promise<FacebookSdk> | null = null;

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
    let wabaId: string | null = null;
    let finishEvent: string | null = null;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
    };

    const maybeResolve = (authorizationCode: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ authorizationCode, wabaId, event: finishEvent });
    };

    const onMessage = (event: MessageEvent) => {
      if (!FACEBOOK_ALLOWED_MESSAGE_ORIGINS.has(event.origin)) return;
      let payload: unknown = event.data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      if (record.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (typeof record.event === 'string') finishEvent = record.event;
      const data = record.data;
      if (data && typeof data === 'object') {
        const candidate = (data as Record<string, unknown>).waba_id;
        if (typeof candidate === 'string' && /^\d+$/.test(candidate)) wabaId = candidate;
      }
    };

    window.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error('Meta Embedded Signup timed out.'));
      }
    }, 10 * 60 * 1000);

    fb.login((response) => {
      const code = response.authResponse?.code?.trim() || null;
      if (!code) {
        cleanup();
        reject(new Error(response.status === 'not_authorized' ? 'Meta authorization was not granted.' : 'Meta Embedded Signup was cancelled or returned no authorization code.'));
        return;
      }
      // The authorization code is intentionally kept only in memory here.
      // A later backend exchange must use the app secret outside the browser.
      window.setTimeout(() => maybeResolve(code), 300);
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
