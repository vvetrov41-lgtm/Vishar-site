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
import { createProjectOperationsApi, type ProjectOperationsApi } from './project-operations-api';
import { createRecordEditApi, type RecordEditApi } from './record-edit-api';
import { createWhatsAppConnectionsApi, type WhatsAppConnectionsApi } from './whatsapp-connections-api';
import { createCommunicationsApi, type CommunicationsApi } from './communications-api';
import { createInstagramConnectionsApi, type InstagramConnectionsApi } from './instagram-connections-api';
import { createPlatformApi, type PlatformApi } from './platform-api';
import { createTelegramConnectionsApi, type TelegramConnectionsApi } from './telegram-connections-api';
import { clearStaffInviteUrl } from './supabase';
import type { ArtistMembership, Profile } from './types';

export type AccessState =
  | 'loading'
  | 'signed_out'
  | 'no_profile'   // signed in, but no readable CRM profile
  // Signed in with a readable but inactive profile. Under the current
  // `profiles_select_self` policy - which is gated on `is_active` - a
  // deactivated account cannot read its own row either, so it presents as
  // `no_profile`. This state is kept because it is the honest model of "profile
  // exists, access withdrawn" and would become reachable if that policy ever
  // widened; both outcomes deny identically.
  | 'deactivated'
  | 'password_setup'
  | 'active'
  | 'unconfigured'; // the build has no Supabase URL or anon key

export type CrmApi = Api & AppointmentApi & AvailabilityApi & CalendarConnectionsApi & OAuthConsentApi & ManualIntakeApi & PaymentApi & ProjectOperationsApi & RecordEditApi & WhatsAppConnectionsApi & CommunicationsApi & InstagramConnectionsApi & PlatformApi & TelegramConnectionsApi;

type PasswordUpdateAuth = CrmClient['auth'] & {
  updateUser: (attributes: { password: string }) => Promise<{ data: unknown; error: unknown }>;
};

export interface SessionValue {
  state: AccessState;
  profile: Profile | null;
  memberships: ArtistMembership[];
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
  const [memberships, setMemberships] = useState<ArtistMembership[]>([]);
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
      createProjectOperationsApi(client),
      createRecordEditApi(client),
      createWhatsAppConnectionsApi(client),
      createCommunicationsApi(client),
      createInstagramConnectionsApi(client),
      createPlatformApi(client),
      createTelegramConnectionsApi(client),
    );
  }, [client, teamInviteUrl]);

  const load = useCallback(async () => {
    if (!client || !api) {
      setMemberships([]);
      setState('unconfigured');
      return;
    }

    const { data } = await client.auth.getSession();
    const userId = data?.session?.user?.id;
    if (!userId) {
      setProfile(null);
      setMemberships([]);
      setState('signed_out');
      return;
    }

    try {
      const found = await api.currentProfile(userId);
      if (!found) {
        setProfile(null);
        setMemberships([]);
        setState('no_profile');
        return;
      }
      setProfile(found);
      if (!found.is_active) {
        setMemberships([]);
        setState('deactivated');
        return;
      }

      try {
        // Not api.listTeamMemberships(): that calls list_team_memberships(),
        // an owner-only RPC that raises for every other role. A booking
        // manager's own scoped capabilities are readable directly, without
        // any RPC, under the existing `artist_memberships` RLS policy
        // (`profile_id = auth.uid() AND is_active_user()`) - the `.eq`
        // filters here mirror that policy rather than substitute for it, so
        // this reads exactly the caller's own active memberships either way.
        const { data, error } = await client
          .from('artist_memberships')
          .select('profile_id, artist_id, access_level, can_view_finance, can_manage_finance, can_manage_sessions, can_manage_integrations, is_active')
          .eq('profile_id', found.id)
          .eq('is_active', true);
        if (error) throw error;
        setMemberships((data ?? []) as ArtistMembership[]);
      } catch {
        // Membership flags only shape the visible navigation. If this read ever
        // fails, hide scoped affordances rather than widening access.
        setMemberships([]);
      }

      setState(inviteMode ? 'password_setup' : 'active');
    } catch {
      // A profile that cannot be read is treated as no access rather than as a
      // transient error: the safe reading of "the database would not tell me
      // who you are" is that you are not staff.
      setProfile(null);
      setMemberships([]);
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
      // Deliberately generic: distinguishing "no such account" from "wrong
      // password" tells an attacker which addresses are staff addresses.
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
    setMemberships([]);
    setState('signed_out');
  }, [client, inviteMode]);

  const completePasswordSetup = useCallback(async (password: string) => {
    if (!client || !inviteMode || state !== 'password_setup' || !profile?.is_active) {
      throw new Error('Password setup is not available for this session.');
    }
    if (password.length < 12 || password.length > 128) {
      throw new Error('Choose a password between 12 and 128 characters.');
    }

    // Password mutation is intentionally kept in the Auth-only session layer.
    // It is not added to the general CRM data client used by pages/workflows.
    const auth = client.auth as PasswordUpdateAuth;
    const updated = await auth.updateUser({ password });
    if (updated.error) {
      throw new Error('Could not set that password. Choose a stronger password and try again.');
    }

    // End the invitation-derived session. The next access must prove the new
    // password through the ordinary signInWithPassword path.
    const signedOut = await client.auth.signOut();
    if (signedOut.error) {
      throw new Error('The password was saved, but the invitation session could not be closed. Try again before continuing.');
    }

    clearStaffInviteUrl();
    setInviteMode(false);
    setError(null);
    setProfile(null);
    setMemberships([]);
    setState('signed_out');
  }, [client, inviteMode, profile, state]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      profile,
      memberships,
      api,
      error,
      signIn,
      signOut,
      completePasswordSetup,
      refresh: load,
    }),
    [state, profile, memberships, api, error, signIn, signOut, completePasswordSetup, load]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function useApi(): CrmApi {
  const { api } = useSession();
  if (!api) throw new Error('The CRM is not configured.');
  return api;
}
