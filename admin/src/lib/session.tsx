// Authentication and the active CRM profile.
//
// Being signed in is not the same as having access. A Supabase Auth session
// only establishes identity; the CRM profile establishes whether that identity
// is a member of staff and what role they hold. An account with no profile, or
// with `is_active = false`, is signed in and has nothing - which is exactly
// what the database enforces too.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createApi, type Api, type CrmClient } from './api';
import { createAppointmentApi, type AppointmentApi } from './appointment-api';
import { createAvailabilityApi, type AvailabilityApi } from './availability-api';
import {
  createCalendarConnectionsApi,
  type CalendarConnectionsApi,
} from './calendar-connections-api';
import { createManualIntakeApi, type ManualIntakeApi } from './manual-intake-api';
import {
  createOAuthConsentApi,
  type OAuthConsentApi,
} from './oauth-consent-api';
import { createPaymentApi, type PaymentApi } from './payment-api';
import { clearStaffInviteUrl } from './supabase';
import type { Profile } from './types';

export type AccessState =
  | 'loading'
  | 'signed_out'
  | 'no_profile'
  | 'deactivated'
  | 'password_setup'
  | 'active'
  | 'unconfigured';

export type CrmApi = Api & AppointmentApi & AvailabilityApi & CalendarConnectionsApi & OAuthConsentApi & ManualIntakeApi & PaymentApi;

type PasswordUpdateAuth = CrmClient['auth'] & {
  updateUser: (attributes: { password: string }) => Promise<{ data: unknown; error: unknown }>;
};

export interface SessionValue {
  state: AccessState;
  profile: Profile | null;
  api: CrmApi | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  completePasswordSetup: (password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  client,
  teamInviteUrl = '',
  staffInviteMode = false,
  children,
}: {
  client: CrmClient | null;
  teamInviteUrl?: string;
  staffInviteMode?: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<AccessState>(client ? 'loading' : 'unconfigured');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteMode, setInviteMode] = useState(staffInviteMode);

  const api = useMemo<CrmApi | null>(() => {
    if (!client) return null;
    return Object.assign(
      createApi(client, { teamInviteUrl }),
      createAppointmentApi(client),
      createAvailabilityApi(client),
      createCalendarConnectionsApi(client),
      createOAuthConsentApi(client),
      createManualIntakeApi(client),
      createPaymentApi(client),
    );
  }, [client, teamInviteUrl]);

  const load = useCallback(async () => {
    if (!client || !api) {
      setState('unconfigured');
      return;
    }

    const { data } = await client.auth.getSession();
    const userId = data?.session?.user?.id;
    if (!userId) {
      setProfile(null);
      setState('signed_out');
      return;
    }

    try {
      const found = await api.currentProfile(userId);
      if (!found) {
        setProfile(null);
        setState('no_profile');
        return;
      }
      setProfile(found);
      if (!found.is_active) {
        setState('deactivated');
        return;
      }
      setState(inviteMode ? 'password_setup' : 'active');
    } catch {
      setProfile(null);
      setState('no_profile');
    }
  }, [client, api, inviteMode]);

  useEffect(() => {
    void load();
    if (!client) return undefined;
    const { data } = client.auth.onAuthStateChange(() => { void load(); });
    return () => data.subscription.unsubscribe();
  }, [client, load]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!client) throw new Error('The CRM is not configured.');
    setError(null);
    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) {
      setError('That email address and password did not match.');
      throw new Error('sign in failed');
    }
    await load();
  }, [client, load]);

  const signOut = useCallback(async () => {
    if (!client) return;
    await client.auth.signOut();
    if (inviteMode) {
      clearStaffInviteUrl();
      setInviteMode(false);
    }
    setProfile(null);
    setState('signed_out');
  }, [client, inviteMode]);

  const completePasswordSetup = useCallback(async (password: string) => {
    if (!client || !inviteMode || state !== 'password_setup' || !profile?.is_active) {
      throw new Error('Password setup is not available for this session.');
    }
    if (password.length < 12 || password.length > 128) {
      throw new Error('Choose a password between 12 and 128 characters.');
    }

    const auth = client.auth as PasswordUpdateAuth;
    const updated = await auth.updateUser({ password });
    if (updated.error) {
      throw new Error('Could not set that password. Choose a stronger password and try again.');
    }

    const signedOut = await client.auth.signOut();
    if (signedOut.error) {
      throw new Error('The password was saved, but the invitation session could not be closed. Try again before continuing.');
    }

    clearStaffInviteUrl();
    setInviteMode(false);
    setError(null);
    setProfile(null);
    setState('signed_out');
  }, [client, inviteMode, profile, state]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      profile,
      api,
      error,
      signIn,
      signOut,
      completePasswordSetup,
      refresh: load,
    }),
    [state, profile, api, error, signIn, signOut, completePasswordSetup, load]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}

export function useApi(): CrmApi {
  const { api } = useSession();
  if (!api) throw new Error('The CRM is not configured.');
  return api;
}
