// WhatsApp Embedded Signup as a CRM-owned OAuth redirect.
//
// Why not FB.login: the JS SDK sends the OAuth dialog its own redirect_uri
// (https://staticxx.facebook.com/x/connect/xd_arbiter/?version=46#cb=...) and a
// fallback_redirect_uri of document.location.href, and Facebook decides which
// one the code is bound to. The server cannot know which, so the exchange
// failed with Meta 100/36008 ("redirect_uri must match"), on iPhone Safari and,
// per the August history of this endpoint, on desktop too.
//
// Here the CRM builds the same dialog the SDK builds (same endpoint, client,
// configuration, response type and extras, extras JSON-encoded as the SDK
// does), with one explicit redirect_uri: the production CRM root. The page
// navigates there in the same tab on every device, Meta returns
// /?code=...&state=... to the root, and the server exchanges the code with
// exactly that redirect_uri. There is no popup, no window.opener and no
// postMessage, so desktop and mobile Safari take the same path.
//
// state is 32 random bytes kept in this tab's sessionStorage with the artist
// id. It is single use: it is removed before the callback is acted on, so a
// replayed or forged callback finds nothing to match and is refused.

import { META_WHATSAPP_APP_ID, META_WHATSAPP_CONFIG_ID } from './meta-whatsapp-embedded-signup';

export const META_OAUTH_DIALOG_URL = 'https://www.facebook.com/v25.0/dialog/oauth';
// Must be listed exactly in Facebook Login for Business > Valid OAuth
// Redirect URIs, and must equal the value the server exchanges with.
export const META_OAUTH_REDIRECT_URI = 'https://crm.vishartattoo.com/';
export const PENDING_SIGNUP_KEY = 'vishar.whatsapp.embedded-signup.pending';
export const PENDING_SIGNUP_MAX_AGE_MS = 15 * 60 * 1000;

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Printable ASCII without spaces; the server re-validates its length.
const CODE_PATTERN = /^[\x21-\x7e]{10,2048}$/;

export type EmbeddedSignupCallback =
  | { status: 'code'; artistId: string; code: string }
  | { status: 'cancelled'; artistId: string }
  | { status: 'rejected'; reason: 'state_missing' | 'state_mismatch' | 'state_expired' | 'code_invalid' };

interface PendingSignup {
  state: string;
  artistId: string;
  createdAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createSignupState(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  return base64Url(random(new Uint8Array(32)));
}

export function embeddedSignupDialogUrl(state: string): string {
  if (!STATE_PATTERN.test(state)) throw new Error('Embedded Signup state is invalid.');
  const url = new URL(META_OAUTH_DIALOG_URL);
  url.searchParams.set('client_id', META_WHATSAPP_APP_ID);
  url.searchParams.set('config_id', META_WHATSAPP_CONFIG_ID);
  url.searchParams.set('redirect_uri', META_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', state);
  // Coexistence stays the explicit launch selector, exactly as FB.login sent it.
  url.searchParams.set('extras', JSON.stringify({
    featureType: 'whatsapp_business_app_onboarding',
    sessionInfoVersion: '3',
  }));
  return url.toString();
}

export function beginEmbeddedSignupRedirect(
  artistId: string,
  {
    storage = window.sessionStorage,
    navigate = (url: string) => window.location.assign(url),
    now = Date.now,
    random,
  }: {
    storage?: StorageLike;
    navigate?: (url: string) => void;
    now?: () => number;
    random?: (bytes: Uint8Array) => Uint8Array;
  } = {},
): void {
  if (!UUID_PATTERN.test(artistId)) throw new Error('Embedded Signup artist is invalid.');
  const state = createSignupState(random);
  const pending: PendingSignup = { state, artistId, createdAt: now() };
  storage.setItem(PENDING_SIGNUP_KEY, JSON.stringify(pending));
  navigate(embeddedSignupDialogUrl(state));
}

function readPending(storage: StorageLike): PendingSignup | null {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_SIGNUP_KEY) || 'null') as Partial<PendingSignup> | null;
    if (
      !parsed
      || typeof parsed.state !== 'string'
      || !STATE_PATTERN.test(parsed.state)
      || typeof parsed.artistId !== 'string'
      || !UUID_PATTERN.test(parsed.artistId)
      || typeof parsed.createdAt !== 'number'
    ) return null;
    return parsed as PendingSignup;
  } catch {
    return null;
  }
}

function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * Reads Meta's redirect back to the CRM root once, at startup. Returns null for
 * any URL that is not that redirect, and leaves such URLs untouched. For the
 * redirect it consumes the pending state (single use), strips code and state
 * from the address bar and history, and opens the WhatsApp page.
 */
export function captureEmbeddedSignupCallback(
  href: string,
  {
    storage = window.sessionStorage,
    replaceUrl = (url: string) => window.history.replaceState(null, '', url),
    now = Date.now,
  }: {
    storage?: StorageLike;
    replaceUrl?: (url: string) => void;
    now?: () => number;
  } = {},
): EmbeddedSignupCallback | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (`${url.origin}${url.pathname}` !== META_OAUTH_REDIRECT_URI) return null;
  const params = url.searchParams;
  if (!params.has('state') || (!params.has('code') && !params.has('error'))) return null;

  const pending = readPending(storage);
  storage.removeItem(PENDING_SIGNUP_KEY);
  replaceUrl('/#/integrations/whatsapp');

  const state = params.get('state') || '';
  if (!pending) return { status: 'rejected', reason: 'state_missing' };
  if (!sameState(state, pending.state)) return { status: 'rejected', reason: 'state_mismatch' };
  if (now() - pending.createdAt > PENDING_SIGNUP_MAX_AGE_MS || now() < pending.createdAt) {
    return { status: 'rejected', reason: 'state_expired' };
  }
  if (params.has('error')) return { status: 'cancelled', artistId: pending.artistId };
  const code = params.get('code') || '';
  if (!CODE_PATTERN.test(code)) return { status: 'rejected', reason: 'code_invalid' };
  return { status: 'code', artistId: pending.artistId, code };
}

let capturedCallback: EmbeddedSignupCallback | null = null;

/** Called once from main.tsx before the router and Supabase client start. */
export function captureEmbeddedSignupCallbackAtStartup(): void {
  if (typeof window === 'undefined') return;
  try {
    capturedCallback = captureEmbeddedSignupCallback(window.location.href);
  } catch {
    capturedCallback = null;
  }
}

/** Hands the captured callback to the WhatsApp page exactly once. */
export function takeEmbeddedSignupCallback(): EmbeddedSignupCallback | null {
  const callback = capturedCallback;
  capturedCallback = null;
  return callback;
}

export function setCapturedEmbeddedSignupCallbackForTest(callback: EmbeddedSignupCallback | null): void {
  capturedCallback = callback;
}
