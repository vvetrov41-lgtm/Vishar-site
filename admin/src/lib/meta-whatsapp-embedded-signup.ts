export const META_WHATSAPP_APP_ID = '1481226093843982';
export const META_WHATSAPP_CONFIG_ID = '4468652066715473';

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
  phoneNumberId: string | null;
  event: 'FINISH';
}

export interface EmbeddedSignupMessage {
  event: 'FINISH' | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' | 'CANCEL' | 'ERROR';
  wabaId: string | null;
  phoneNumberId: string | null;
}

let sdkPromise: Promise<FacebookSdk> | null = null;
let initializedSdk: FacebookSdk | null = null;

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
  if (
    record.event !== 'FINISH'
    && record.event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
    && record.event !== 'CANCEL'
    && record.event !== 'ERROR'
  ) return null;

  const session = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : {};

  return {
    event: record.event,
    wabaId: numericProviderId(session.waba_id),
    phoneNumberId: numericProviderId(session.phone_number_id),
  };
}

function initializeFacebookSdk(fb: FacebookSdk): FacebookSdk {
  if (initializedSdk === fb) return fb;
  fb.init({
    appId: META_WHATSAPP_APP_ID,
    autoLogAppEvents: false,
    xfbml: false,
    version: 'v25.0',
  });
  initializedSdk = fb;
  return fb;
}

function loadFacebookSdk(): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(initializeFacebookSdk(window.FB));
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    let settled = false;
    const existing = document.querySelector<HTMLScriptElement>('script[data-vishar-meta-sdk="true"]');
    const script = existing ?? document.createElement('script');

    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      script.removeEventListener('error', fail);
    };

    const finish = () => {
      if (settled || !window.FB) return;
      settled = true;
      cleanup();
      resolve(initializeFacebookSdk(window.FB));
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Could not load Meta SDK.'));
    };

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Meta SDK did not load in time.'));
    }, 15000);
    const poll = window.setInterval(finish, 100);

    window.fbAsyncInit = finish;
    script.addEventListener('error', fail, { once: true });

    if (!existing) {
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = FACEBOOK_SDK_URL;
      script.dataset.visharMetaSdk = 'true';
      document.head.appendChild(script);
    } else {
      finish();
    }
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });

  return sdkPromise;
}

export async function prepareWhatsAppEmbeddedSignup(): Promise<void> {
  await loadFacebookSdk();
}

export function launchWhatsAppEmbeddedSignup(): Promise<WhatsAppEmbeddedSignupResult> {
  // iOS/WebKit can replace the global FB object after the page was prepared
  // (for example after app switching). Re-initialize that current object
  // synchronously so FB.login still remains inside the user's click gesture.
  const fb = window.FB ? initializeFacebookSdk(window.FB) : null;
  if (!fb) {
    return Promise.reject(new Error('Meta SDK is still loading. Please try again in a moment.'));
  }

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
      const isFinished = finishedSession?.event === 'FINISH'
        || finishedSession?.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
      if (settled || !authorizationCode || !isFinished) return;
      if (!finishedSession?.wabaId) {
        rejectOnce(new Error('Meta finished onboarding without a WhatsApp Business Account id.'));
        return;
      }
      if (finishedSession.event === 'FINISH' && !finishedSession.phoneNumberId) {
        rejectOnce(new Error('Meta finished standard onboarding without a phone-number id.'));
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

    // FB.login must run synchronously inside the click gesture. Awaiting SDK
    // loading here makes iOS/WebKit treat the Meta window as an unsolicited popup.
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
