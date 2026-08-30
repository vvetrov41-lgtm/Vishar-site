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
  currentStep: string | null;
  providerError: string | null;
}

export type WhatsAppEmbeddedSignupErrorCode =
  | 'WA_META_SDK_LOAD_FAILED'
  | 'WA_META_SDK_LOAD_TIMEOUT'
  | 'WA_META_SDK_NOT_READY'
  | 'WA_META_LOGIN_NOT_AUTHORIZED'
  | 'WA_META_LOGIN_UNKNOWN'
  | 'WA_META_LOGIN_CONNECTED_NO_CODE'
  | 'WA_META_LOGIN_EMPTY_RESPONSE'
  | 'WA_META_LOGIN_NO_CODE'
  | 'WA_META_PROVIDER_CANCELLED'
  | 'WA_META_PROVIDER_ERROR'
  | 'WA_META_FINISH_MISSING_WABA'
  | 'WA_META_FINISH_MISSING_PHONE'
  | 'WA_META_FINISH_WAITING_FOR_CODE'
  | 'WA_META_TIMEOUT_WAITING_FOR_LOGIN'
  | 'WA_META_TIMEOUT_WAITING_FOR_SESSION';

interface WhatsAppEmbeddedSignupErrorDetails {
  currentStep?: string | null;
  providerError?: string | null;
}

export class WhatsAppEmbeddedSignupError extends Error {
  readonly code: WhatsAppEmbeddedSignupErrorCode;
  readonly currentStep: string | null;
  readonly providerError: string | null;

  constructor(
    code: WhatsAppEmbeddedSignupErrorCode,
    details: WhatsAppEmbeddedSignupErrorDetails = {},
  ) {
    super(code);
    this.name = 'WhatsAppEmbeddedSignupError';
    this.code = code;
    this.currentStep = details.currentStep ?? null;
    this.providerError = details.providerError ?? null;
  }
}

let sdkPromise: Promise<FacebookSdk> | null = null;
let initializedSdk: FacebookSdk | null = null;

function numericProviderId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]{5,32}$/.test(value.trim()) ? value.trim() : null;
}

function safeProviderStep(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(normalized) ? normalized : null;
}

function safeProviderError(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized
    .slice(0, 160)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{5,}\b/g, '[id]');
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
    currentStep: safeProviderStep(session.current_step),
    providerError: safeProviderError(session.error_message),
  };
}

const ENGLISH_ERROR_COPY: Record<WhatsAppEmbeddedSignupErrorCode, string> = {
  WA_META_SDK_LOAD_FAILED: 'The Meta SDK could not be loaded. Check the network and browser content blockers.',
  WA_META_SDK_LOAD_TIMEOUT: 'The Meta SDK did not load in time. Check the network and browser content blockers.',
  WA_META_SDK_NOT_READY: 'The Meta SDK is not ready yet. Retry after the page finishes loading.',
  WA_META_LOGIN_NOT_AUTHORIZED: 'Meta did not grant authorization for this app.',
  WA_META_LOGIN_UNKNOWN: 'Meta returned an unknown login state. Check popup and cross-site tracking restrictions, then retry.',
  WA_META_LOGIN_CONNECTED_NO_CODE: 'Meta authenticated the account but returned no authorization code. Check the Embedded Signup configuration.',
  WA_META_LOGIN_EMPTY_RESPONSE: 'The Meta login window closed without a login status or authorization code.',
  WA_META_LOGIN_NO_CODE: 'Meta returned no authorization code for the reported login state.',
  WA_META_PROVIDER_CANCELLED: 'Meta reported that Embedded Signup was cancelled.',
  WA_META_PROVIDER_ERROR: 'Meta reported an Embedded Signup error.',
  WA_META_FINISH_MISSING_WABA: 'Meta finished onboarding without a WhatsApp Business Account id.',
  WA_META_FINISH_MISSING_PHONE: 'Meta finished standard onboarding without a phone-number id.',
  WA_META_FINISH_WAITING_FOR_CODE: 'Meta finished the WhatsApp selection but the Facebook login callback returned no authorization code.',
  WA_META_TIMEOUT_WAITING_FOR_LOGIN: 'Meta Embedded Signup timed out while waiting for the login callback.',
  WA_META_TIMEOUT_WAITING_FOR_SESSION: 'Meta Embedded Signup returned an authorization code but did not return the WhatsApp onboarding session.',
};

const RUSSIAN_ERROR_COPY: Record<WhatsAppEmbeddedSignupErrorCode, string> = {
  WA_META_SDK_LOAD_FAILED: 'Не удалось загрузить Meta SDK. Проверьте сеть и блокировщики содержимого браузера.',
  WA_META_SDK_LOAD_TIMEOUT: 'Meta SDK не загрузился вовремя. Проверьте сеть и блокировщики содержимого браузера.',
  WA_META_SDK_NOT_READY: 'Meta SDK ещё не готов. Повторите после завершения загрузки страницы.',
  WA_META_LOGIN_NOT_AUTHORIZED: 'Meta не выдала разрешение этому приложению.',
  WA_META_LOGIN_UNKNOWN: 'Meta вернула неопределённый статус входа. Проверьте ограничения всплывающих окон и межсайтового отслеживания, затем повторите.',
  WA_META_LOGIN_CONNECTED_NO_CODE: 'Meta выполнила вход, но не вернула authorization code. Проверьте конфигурацию Embedded Signup.',
  WA_META_LOGIN_EMPTY_RESPONSE: 'Окно входа Meta закрылось без статуса и authorization code.',
  WA_META_LOGIN_NO_CODE: 'Meta не вернула authorization code для полученного статуса входа.',
  WA_META_PROVIDER_CANCELLED: 'Meta сообщила, что Embedded Signup отменён.',
  WA_META_PROVIDER_ERROR: 'Meta сообщила об ошибке Embedded Signup.',
  WA_META_FINISH_MISSING_WABA: 'Meta завершила подключение без идентификатора WhatsApp Business Account.',
  WA_META_FINISH_MISSING_PHONE: 'Meta завершила обычное подключение без идентификатора номера.',
  WA_META_FINISH_WAITING_FOR_CODE: 'Meta завершила выбор WhatsApp, но callback входа Facebook не вернул authorization code.',
  WA_META_TIMEOUT_WAITING_FOR_LOGIN: 'Meta не вернула callback входа в CRM за отведённое время.',
  WA_META_TIMEOUT_WAITING_FOR_SESSION: 'Meta вернула authorization code, но не вернула данные сессии WhatsApp.',
};

export function describeWhatsAppEmbeddedSignupError(
  cause: unknown,
  language: 'en' | 'ru',
): string {
  if (!(cause instanceof WhatsAppEmbeddedSignupError)) {
    return cause instanceof Error
      ? cause.message
      : language === 'ru'
        ? 'Не удалось подключить WhatsApp через Meta.'
        : 'Could not connect WhatsApp through Meta.';
  }

  const copy = language === 'ru' ? RUSSIAN_ERROR_COPY : ENGLISH_ERROR_COPY;
  const context = [
    cause.currentStep ? `step=${cause.currentStep}` : null,
    cause.providerError ? `provider=${cause.providerError}` : null,
  ].filter(Boolean).join(', ');
  return `[${cause.code}] ${copy[cause.code]}${context ? ` (${context})` : ''}`;
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
      reject(new WhatsAppEmbeddedSignupError('WA_META_SDK_LOAD_FAILED'));
    };

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new WhatsAppEmbeddedSignupError('WA_META_SDK_LOAD_TIMEOUT'));
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
    return Promise.reject(new WhatsAppEmbeddedSignupError('WA_META_SDK_NOT_READY'));
  }

  return new Promise((resolve, reject) => {
    let authorizationCode: string | null = null;
    let finishedSession: EmbeddedSignupMessage | null = null;
    let settled = false;
    let phaseTimeout: number | null = null;

    const clearPhaseTimeout = () => {
      if (phaseTimeout === null) return;
      window.clearTimeout(phaseTimeout);
      phaseTimeout = null;
    };

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
      clearPhaseTimeout();
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const armPhaseTimeout = (code: WhatsAppEmbeddedSignupErrorCode) => {
      clearPhaseTimeout();
      phaseTimeout = window.setTimeout(() => {
        rejectOnce(new WhatsAppEmbeddedSignupError(code));
      }, 20000);
    };

    const maybeResolve = () => {
      const isFinished = finishedSession?.event === 'FINISH'
        || finishedSession?.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
      if (settled || !authorizationCode || !isFinished) return;
      if (!finishedSession?.wabaId) {
        rejectOnce(new WhatsAppEmbeddedSignupError('WA_META_FINISH_MISSING_WABA'));
        return;
      }
      if (finishedSession.event === 'FINISH' && !finishedSession.phoneNumberId) {
        rejectOnce(new WhatsAppEmbeddedSignupError('WA_META_FINISH_MISSING_PHONE'));
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
        rejectOnce(new WhatsAppEmbeddedSignupError('WA_META_PROVIDER_CANCELLED', parsed));
        return;
      }
      if (parsed.event === 'ERROR') {
        rejectOnce(new WhatsAppEmbeddedSignupError('WA_META_PROVIDER_ERROR', parsed));
        return;
      }
      finishedSession = parsed;
      if (!authorizationCode) armPhaseTimeout('WA_META_FINISH_WAITING_FOR_CODE');
      maybeResolve();
    };

    window.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => {
      rejectOnce(new WhatsAppEmbeddedSignupError(
        finishedSession
          ? 'WA_META_FINISH_WAITING_FOR_CODE'
          : authorizationCode
            ? 'WA_META_TIMEOUT_WAITING_FOR_SESSION'
            : 'WA_META_TIMEOUT_WAITING_FOR_LOGIN',
      ));
    }, 60000);

    // FB.login must run synchronously inside the click gesture. Awaiting SDK
    // loading here makes iOS/WebKit treat the Meta window as an unsolicited popup.
    fb.login((response) => {
      const code = response.authResponse?.code?.trim() || '';
      if (!code) {
        if (finishedSession) {
          rejectOnce(new WhatsAppEmbeddedSignupError('WA_META_FINISH_WAITING_FOR_CODE'));
          return;
        }
        const reason: WhatsAppEmbeddedSignupErrorCode = response.status === 'not_authorized'
          ? 'WA_META_LOGIN_NOT_AUTHORIZED'
          : response.status === 'unknown'
            ? 'WA_META_LOGIN_UNKNOWN'
            : response.status === 'connected'
              ? 'WA_META_LOGIN_CONNECTED_NO_CODE'
              : response.status
                ? 'WA_META_LOGIN_NO_CODE'
                : 'WA_META_LOGIN_EMPTY_RESPONSE';
        rejectOnce(new WhatsAppEmbeddedSignupError(reason));
        return;
      }
      authorizationCode = code;
      clearPhaseTimeout();
      if (!finishedSession) armPhaseTimeout('WA_META_TIMEOUT_WAITING_FOR_SESSION');
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
