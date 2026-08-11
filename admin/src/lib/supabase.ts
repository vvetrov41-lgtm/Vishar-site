// Supabase client for the CRM browser.
//
// The only credentials this application ever holds are the project URL and the
// publishable key (or the legacy anon key). It is a public identifier, not authority:
// what a session can do is decided entirely by row level security and by the
// role checks inside the workflow RPCs.
//
// Supabase secret and service-role keys must never appear here, in .env.local,
// or in any build output. They belong only in a trusted backend secret store.

import { createClient } from '@supabase/supabase-js';
import type { CrmClient } from './api';

function jwtRole(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(globalThis.atob(padded)) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function assertBrowserSafeKey(value: string) {
  if (value.startsWith('sb_secret_') || jwtRole(value) === 'service_role') {
    throw new Error(
      'A privileged Supabase key was supplied to the CRM browser. Remove it and rotate it before building again.'
    );
  }
}

function projectOrigin(value: string, allowLocal: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_SUPABASE_URL must be a permitted Supabase project root URL.');
  }

  const hosted =
    parsed.protocol === 'https:'
    && /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
    && !parsed.port
  ;
  const loopback =
    allowLocal
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    && parsed.port === '54321';

  if (
    (!hosted && !loopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    // Staff passwords and access tokens are sent to this origin. Fail the
    // build/configuration closed rather than trusting a typo or arbitrary host.
    throw new Error('VITE_SUPABASE_URL must be a permitted Supabase project root URL.');
  }

  return parsed.origin;
}

export function readConfig(env: Record<string, string | undefined>, allowLocal = false) {
  const rawUrl = (env.VITE_SUPABASE_URL ?? '').trim();
  const publishableKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  const legacyAnonKey = (env.VITE_SUPABASE_ANON_KEY ?? '').trim();

  // Check both variable names and actual values. A privileged JWT copied into
  // VITE_SUPABASE_ANON_KEY is still privileged, whatever its label says.
  if (
    env.VITE_SUPABASE_SERVICE_ROLE_KEY
    || env.SUPABASE_SERVICE_ROLE_KEY
    || env.VITE_SUPABASE_SECRET_KEY
    || env.SUPABASE_SECRET_KEY
  ) {
    throw new Error(
      'A privileged Supabase key is present in the CRM environment. Remove it: the browser may only hold a publishable key.'
    );
  }

  if (publishableKey && legacyAnonKey) {
    throw new Error('Configure either VITE_SUPABASE_PUBLISHABLE_KEY or the legacy anon key, not both.');
  }

  const key = publishableKey || legacyAnonKey;
  if (key) assertBrowserSafeKey(key);

  const url = rawUrl ? projectOrigin(rawUrl, allowLocal) : '';
  return { url, publishableKey: key, configured: Boolean(url && key) };
}

export function readTeamInviteUrl(
  env: Record<string, string | undefined>,
  allowLocal = false
): string {
  const value = (env.VITE_TEAM_INVITE_URL ?? '').trim();
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_TEAM_INVITE_URL must be the permitted Team API endpoint.');
  }

  const loopback = allowLocal
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  const hosted = parsed.protocol === 'https:'
    && parsed.hostname.endsWith('.vishartattoo.com');

  if (
    (!hosted && !loopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/v1/staff/invite'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('VITE_TEAM_INVITE_URL must be the permitted Team API endpoint.');
  }

  return parsed.toString();
}

export function createCrmClient(
  env: Record<string, string | undefined>,
  allowLocal = false
): CrmClient | null {
  const { url, publishableKey, configured } = readConfig(env, allowLocal);
  if (!configured) return null;
  return createClient(url, publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }) as unknown as CrmClient;
}
