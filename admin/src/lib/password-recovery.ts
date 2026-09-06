// Self-service password recovery for signed-out CRM users.
//
// Recovery uses a short-lived, non-persistent Supabase client only to request
// the email. It deliberately reuses the already allow-listed `staff_invite`
// callback: both flows return with a verified Auth session whose only permitted
// action in the CRM is setting a password, after which SessionProvider signs
// the browser out. Reusing that exact callback avoids widening the production
// Auth redirect allow-list.

import { createClient } from '@supabase/supabase-js';
import { readConfig } from './supabase';

const PASSWORD_RECOVERY_STORAGE_KEY = 'vishar-crm-password-recovery';
const PASSWORD_SETUP_PARAMETER = 'staff_invite';
const PASSWORD_SETUP_VALUE = '1';

export interface PasswordRecoveryAuth {
  resetPasswordForEmail: (
    email: string,
    options: { redirectTo: string }
  ) => Promise<{ data: unknown; error: unknown }>;
}

export function passwordRecoveryRedirectUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/?${PASSWORD_SETUP_PARAMETER}=${PASSWORD_SETUP_VALUE}`;
}

/**
 * Narrow, independently testable boundary around Supabase Auth. The UI always
 * gives the same success message whether or not the address exists, so this
 * function never turns password recovery into an account-enumeration oracle.
 */
export async function sendPasswordRecoveryEmail(
  auth: PasswordRecoveryAuth,
  email: string,
  redirectTo: string
): Promise<void> {
  const result = await auth.resetPasswordForEmail(email, { redirectTo });
  if (result.error) {
    throw new Error('Could not send the reset email. Wait a minute and try again.');
  }
}

export async function requestPasswordRecovery(email: string): Promise<void> {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const { url, publishableKey, configured } = readConfig(env, import.meta.env.DEV);
  if (!configured) throw new Error('The CRM is not configured.');

  // This client never persists or refreshes a session. Its sole purpose is the
  // public Auth recovery request; the normal CRM client remains the owner of
  // browser session state.
  const client = createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: PASSWORD_RECOVERY_STORAGE_KEY,
    },
  });

  await sendPasswordRecoveryEmail(
    client.auth,
    email,
    passwordRecoveryRedirectUrl(window.location.origin)
  );
}
