// Isolated business_management Meta App Review login. This module never calls
// WhatsApp Embedded Signup, requests phone selection, or persists Meta tokens.
export const BUSINESS_REVIEW_REDIRECT_URI = 'https://app.vishartattoo.com/?meta_business_review=1';
export const BUSINESS_REVIEW_PENDING_KEY = 'vishar.meta-review.business-login.pending';
export const BUSINESS_REVIEW_MAX_AGE_MS = 10 * 60 * 1000;
const APP_ID = '1481226093843982';
const DESKTOP_LOGIN_URL = 'https://www.facebook.com/v25.0/dialog/oauth';
// On iOS a www.facebook.com OAuth navigation can be claimed by the native
// Facebook app, leaving the CRM tab stranded without an OAuth callback.
// Use the mobile web host in that browser rather than opening the app.
const IOS_WEB_LOGIN_URL = 'https://m.facebook.com/v25.0/dialog/oauth';
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[\x21-\x7e]{10,2048}$/;
const CONFIG_PATTERN = /^[1-9][0-9]{8,24}$/;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface Pending { state: string; createdAt: number }

export type BusinessReviewCallback =
  | { status: 'code'; code: string }
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: 'state_missing' | 'state_mismatch' | 'state_expired' | 'code_invalid' };

function newState(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(32));
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function businessReviewDialogUrl(
  configId: string,
  state: string,
  { ios = false }: { ios?: boolean } = {},
): string {
  if (!CONFIG_PATTERN.test(configId) || !STATE_PATTERN.test(state)) throw new Error('Meta review configuration invalid.');
  const url = new URL(ios ? IOS_WEB_LOGIN_URL : DESKTOP_LOGIN_URL);
  if (ios) url.searchParams.set('display', 'touch');
  url.searchParams.set('client_id', APP_ID);
  url.searchParams.set('config_id', configId);
  url.searchParams.set('redirect_uri', BUSINESS_REVIEW_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', state);
  // No WhatsApp extras, coexistence selector, number, or WABA.
  return url.toString();
}

export function beginBusinessReviewLogin(
  configId: string,
  {
    origin = window.location.origin,
    storage = window.sessionStorage,
    navigate = (url: string) => window.location.assign(url),
    now = Date.now,
    random = (bytes: Uint8Array) => crypto.getRandomValues(bytes),
    ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent),
  }: {
    origin?: string;
    storage?: StorageLike;
    navigate?: (url: string) => void;
    now?: () => number;
    random?: (bytes: Uint8Array) => Uint8Array;
    ios?: boolean;
  } = {},
): void {
  if (origin !== 'https://app.vishartattoo.com') throw new Error('Meta review login requires the operator CRM.');
  if (!CONFIG_PATTERN.test(configId)) throw new Error('Meta review configuration invalid.');
  const state = newState(random);
  storage.setItem(BUSINESS_REVIEW_PENDING_KEY, JSON.stringify({ state, createdAt: now() }));
  navigate(businessReviewDialogUrl(configId, state, { ios }));
}

/**
 * The native Facebook app may capture a mobile OAuth navigation. The Safari
 * tab then stays on the CRM with the pending CSRF state and no callback.
 * Detect that interrupted attempt only on the unchanged operator page; never
 * confuse a genuine callback with a failed navigation.
 */
export function businessReviewWasInterrupted(
  href: string,
  storage: StorageLike = window.sessionStorage,
): boolean {
  try {
    const url = new URL(href);
    if (url.origin !== 'https://app.vishartattoo.com' || url.pathname !== '/'
      || url.searchParams.has('meta_business_review') || url.searchParams.has('code')
      || url.searchParams.has('error')) return false;
    return storage.getItem(BUSINESS_REVIEW_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

function isSameState(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export function captureBusinessReviewCallback(
  href: string,
  {
    storage = window.sessionStorage,
    replaceUrl = (next: string) => window.history.replaceState(null, '', next),
    now = Date.now,
  }: {
    storage?: StorageLike;
    replaceUrl?: (next: string) => void;
    now?: () => number;
  } = {},
): BusinessReviewCallback | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.origin !== 'https://app.vishartattoo.com' || url.pathname !== '/'
    || url.searchParams.get('meta_business_review') !== '1') return null;
  const hasCode = url.searchParams.has('code');
  if (!hasCode && !url.searchParams.has('error')) return null;

  const raw = storage.getItem(BUSINESS_REVIEW_PENDING_KEY);
  storage.removeItem(BUSINESS_REVIEW_PENDING_KEY);
  // Burn the state before exchanging the code; never expose it in history.
  replaceUrl('/#/integrations/whatsapp');
  let pending: Pending | null = null;
  try {
    const value = JSON.parse(raw || 'null') as Partial<Pending> | null;
    if (value && typeof value.state === 'string' && STATE_PATTERN.test(value.state)
      && typeof value.createdAt === 'number') pending = value as Pending;
  } catch { /* reject */ }
  if (!pending) return { status: 'rejected', reason: 'state_missing' };
  const state = url.searchParams.get('state') || '';
  if (!STATE_PATTERN.test(state) || !isSameState(state, pending.state)) {
    return { status: 'rejected', reason: 'state_mismatch' };
  }
  if (now() < pending.createdAt || now() - pending.createdAt > BUSINESS_REVIEW_MAX_AGE_MS) {
    return { status: 'rejected', reason: 'state_expired' };
  }
  if (url.searchParams.has('error')) return { status: 'cancelled' };
  const code = url.searchParams.get('code') || '';
  if (!CODE_PATTERN.test(code)) return { status: 'rejected', reason: 'code_invalid' };
  return { status: 'code', code };
}

let callback: BusinessReviewCallback | null = null;
export function captureBusinessReviewCallbackAtStartup(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.origin !== 'https://app.vishartattoo.com' || url.pathname !== '/'
    || url.searchParams.get('meta_business_review') !== '1') return false;
  callback = captureBusinessReviewCallback(window.location.href);
  return true; // Never pass a review callback to the WhatsApp provisioning flow.
}
export function takeBusinessReviewCallback(): BusinessReviewCallback | null {
  const result = callback;
  callback = null;
  return result;
}
export function setBusinessReviewCallbackForTest(result: BusinessReviewCallback | null): void {
  callback = result;
}
