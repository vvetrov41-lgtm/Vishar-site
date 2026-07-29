// Supabase client for the CRM browser.
//
// The only credentials this application ever holds are the project URL and the
// anon (publishable) key. The anon key is a public identifier, not authority:
// what a session can do is decided entirely by row level security and by the
// role checks inside the workflow RPCs.
//
// SUPABASE_SERVICE_ROLE_KEY must never appear here, in .env.local, or in any
// build output. It belongs only in a Cloudflare Worker secret.

import { createClient } from '@supabase/supabase-js';
import type { CrmClient } from './api';

export function readConfig(env: Record<string, string | undefined>) {
  const url = env.VITE_SUPABASE_URL ?? '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? '';

  // A build that accidentally carried a service-role key would be a serious
  // leak, so it is refused loudly rather than quietly working.
  if (env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'A service-role key is present in the CRM environment. Remove it: the browser must only ever hold the anon key.'
    );
  }

  return { url, anonKey, configured: Boolean(url && anonKey) };
}

export function createCrmClient(env: Record<string, string | undefined>): CrmClient | null {
  const { url, anonKey, configured } = readConfig(env);
  if (!configured) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }) as unknown as CrmClient;
}
