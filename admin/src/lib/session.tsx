// Authentication and the active CRM profile.
//
// Being signed in is not the same as having access. A Supabase Auth session
// only establishes identity; the CRM profile establishes whether that identity
// is a member of staff and what role they hold. An account with no profile, or
// with `is_active = false`, is signed in and has nothing — which is exactly
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
import type { Profile } from './types';

export type AccessState =
  | 'loading'
  | 'signed_out'
  | 'no_profile'
  | 'deactivated'
  | 'active'
  | 'unconfigured';

export type CrmApi = Api & AppointmentApi;

export interface SessionValue {
  state: AccessState;
  profile: Profile | null;
  api: CrmApi | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ client, children }: { client: CrmClient | null; children: ReactNode }) {
  const [state, setState] = useState<AccessState>(client ? 'loading' : 'unconfigured');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useMemo<CrmApi | null>(() => {
    if (!client) return null;
    return Object.assign(createApi(client), createAppointmentApi(client));
  }, [client]);

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
      setState(found.is_active ? 'active' : 'deactivated');
    } catch {
      setProfile(null);
      setState('no_profile');
    }
  }, [client, api]);

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
    setProfile(null);
    setState('signed_out');
  }, [client]);

  const value = useMemo<SessionValue>(
    () => ({ state, profile, api, error, signIn, signOut, refresh: load }),
    [state, profile, api, error, signIn, signOut, load]
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
