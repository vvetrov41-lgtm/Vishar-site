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
import { apiMessage, createApi, type Api, type CrmClient } from './api';
import { createAccountApi, type AccountApi, type AccountOverview } from './account-api';
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
import { createEmailApi, type EmailApi } from './email-api';
import { createSchedulingApi, type SchedulingApi } from './scheduling-api';
import { createInstagramConnectionsApi, type InstagramConnectionsApi } from './instagram-connections-api';
import { createControlPlaneApi, type ControlPlaneApi } from './control-plane-api';
import { createLifecycleApi, type LifecycleApi } from './lifecycle-api';
import { createPlatformApi, type PlatformApi } from './platform-api';
import { createSignupApi, type BootstrapResult, type SignupApi } from './signup-api';
import { createStatisticsApi, type StatisticsApi } from './statistics-api';
import { createTelegramConnectionsApi, type TelegramConnectionsApi } from './telegram-connections-api';
import { passwordProblem } from './password';
import { clearStaffInviteUrl, signupRedirectUrl } from './supabase';
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
  // Signed in through public signup, email address not confirmed yet. Held
  // here rather than shown the CRM: the bootstrap refuses an unconfirmed
  // address anyway, so offering the setup form would be a dead end.
  | 'verify_email'
  // Signed in, confirmed, no CRM identity yet, and signup is open. The one
  // state that leads somewhere new: the first-run setup form.
  | 'setup'
  | 'active'
  | 'unconfigured'; // the build has no Supabase URL or anon key

export type CrmApi = Api & AccountApi & AppointmentApi & AvailabilityApi & CalendarConnectionsApi & OAuthConsentApi & ManualIntakeApi & PaymentApi & ProjectOperationsApi & RecordEditApi & WhatsAppConnectionsApi & CommunicationsApi & EmailApi & SchedulingApi & InstagramConnectionsApi & PlatformApi & TelegramConnectionsApi & ControlPlaneApi & LifecycleApi & SignupApi & StatisticsApi;

type PasswordUpdateAuth = CrmClient['auth'] & {
  updateUser: (attributes: { password: string }) => Promise<{ data: unknown; error: unknown }>;
};

export interface SessionValue {
  state: AccessState;
  profile: Profile | null;
  memberships: ArtistMembership[];
  /** The server's answer about this account: the user-facing role, whether it
   *  founded its own tenant, and whether it may delete itself. Null while it
   *  is loading, and after a read that failed - callers fall back to the
   *  authorization role rather than guessing a nicer answer. */
  account: AccountOverview | null;
  api: CrmApi | null;
  error: string | null;
  /** The address the current session belongs to, so the "check your email"
   *  screen can name it. Null when signed out. */
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  completePasswordSetup: (password: string) => Promise<void>;
  /** Creates the Auth account and sends the confirmation email. Returns true
   *  when a session already exists (a project with confirmation switched off),
   *  false when the person must go and confirm first. */
  signUp: (email: string, password: string) => Promise<boolean>;
  resendVerification: () => Promise<void>;
  completeArtistSetup: (input: {
    displayName: string;
    businessName?: string | null;
    timezone?: string | null;
  }) => Promise<BootstrapResult>;
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
  const [account, setAccount] = useState<AccountOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [inviteMode, setInviteMode] = useState(staffInviteMode);

  const api = useMemo<CrmApi | null>(() => {
    if (!client) return null;
    return Object.assign(
      createApi(client, { teamInviteUrl }),
      createAccountApi(client),
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
      createEmailApi(client),
      createSchedulingApi(client),
      createInstagramConnectionsApi(client),
      createPlatformApi(client),
      createControlPlaneApi(client),
      createTelegramConnectionsApi(client),
      createLifecycleApi(client),
      createSignupApi(client),
      createStatisticsApi(client),
    );
  }, [client, teamInviteUrl]);

  const load = useCallback(async () => {
    if (!client || !api) {
      setMemberships([]);
      setAccount(null);
      setState('unconfigured');
      return;
    }

    const { data } = await client.auth.getSession();
    const user = data?.session?.user;
    const userId = user?.id;
    if (!userId) {
      setProfile(null);
      setMemberships([]);
      setAccount(null);
      setEmail(null);
      setState('signed_out');
      return;
    }
    setEmail(typeof user?.email === 'string' ? user.email : null);

    try {
      const found = await api.currentProfile(userId);
      if (!found) {
        setProfile(null);
        setMemberships([]);
        setAccount(null);

        // No CRM identity. Three different situations look identical from
        // here, and telling them apart is the whole of the signup gate.
        //
        // An unconfirmed address is held first, because the bootstrap refuses
        // it server-side; offering the setup form would be a form that cannot
        // succeed. Then, and only when the database says signup is open, this
        // is somebody who has just arrived and needs to set themselves up.
        // Otherwise it is what it has always been: an account with no access.
        if (!user?.email_confirmed_at) {
          setState('verify_email');
          return;
        }

        const policy = await api.selfServiceSignupPolicy();
        setState(policy.is_open ? 'setup' : 'no_profile');
        return;
      }
      setProfile(found);
      if (!found.is_active) {
        setMemberships([]);
        setAccount(null);
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

      try {
        setAccount(await api.accountOverview());
      } catch {
        // Only a label and a Danger zone depend on this. A failure leaves the
        // interface saying what it said before the server was asked - the
        // authorization role - rather than guessing at a friendlier answer.
        setAccount(null);
      }

      setState(inviteMode ? 'password_setup' : 'active');
    } catch {
      // A profile that cannot be read is treated as no access rather than as a
      // transient error: the safe reading of "the database would not tell me
      // who you are" is that you are not staff.
      setProfile(null);
      setMemberships([]);
      setAccount(null);
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
    if (!client) throw new Error(apiMessage('The CRM is not configured.'));
    setError(null);
    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) {
      // Deliberately generic: distinguishing "no such account" from "wrong
      // password" tells an attacker which addresses are staff addresses.
      setError(apiMessage('That email address and password did not match.'));
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
    setAccount(null);
    setEmail(null);
    setState('signed_out');
  }, [client, inviteMode]);

  const completePasswordSetup = useCallback(async (password: string) => {
    if (!client || !inviteMode || state !== 'password_setup' || !profile?.is_active) {
      throw new Error('Password setup is not available for this session.');
    }
    if (passwordProblem(password) === 'length') {
      throw new Error('Choose a password between 12 and 128 characters.');
    }

    // Password mutation is intentionally kept in the Auth-only session layer.
    // It is not added to the general CRM data client used by pages/workflows.
    const auth = client.auth as PasswordUpdateAuth;
    const updated = await auth.updateUser({ password });
    if (updated.error) {
      throw new Error(apiMessage('Could not set that password. Choose a stronger password and try again.'));
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
    setAccount(null);
    setState('signed_out');
  }, [client, inviteMode, profile, state]);

  // Public signup. Auth only: this creates an identity and nothing in the CRM.
  // The tenant is created later, by public.bootstrap_artist_account, and only
  // once the address has been confirmed.
  const signUp = useCallback(async (address: string, password: string) => {
    if (!client) throw new Error(apiMessage('The CRM is not configured.'));
    if (typeof client.auth.signUp !== 'function') {
      throw new Error(apiMessage('The CRM is not configured.'));
    }
    setError(null);

    const problem = passwordProblem(password);
    if (problem === 'length') {
      throw new Error('Choose a password between 12 and 128 characters.');
    }

    const result = await client.auth.signUp({
      email: address,
      password,
      options: {
        emailRedirectTo: typeof window === 'undefined'
          ? undefined
          : signupRedirectUrl(window.location.origin),
      },
    });
    if (result.error) {
      // Deliberately generic, for the same reason sign-in is: a specific "that
      // address already exists" turns this form into an account oracle.
      throw new Error('That did not work. Check the address and try again, or sign in if you already have an account.');
    }

    setEmail(address);
    // Supabase returns a session immediately only when the project does not
    // require confirmation. Both outcomes are correct; the caller decides
    // which screen follows.
    const confirmed = Boolean(result.data?.session);
    if (confirmed) await load();
    return confirmed;
  }, [client, load]);

  const resendVerification = useCallback(async () => {
    if (!client || !email) throw new Error('There is no address to send to.');
    if (typeof client.auth.resend !== 'function') {
      throw new Error('There is no address to send to.');
    }
    const result = await client.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: typeof window === 'undefined'
          ? undefined
          : signupRedirectUrl(window.location.origin),
      },
    });
    if (result.error) {
      throw new Error('Could not send another email just now. Wait a minute and try again.');
    }
  }, [client, email]);

  // First run. One call creates the whole tenant, and calling it twice returns
  // the first answer - so a double submit, a refreshed tab or a retried
  // request all land on the same CRM rather than a second one.
  const completeArtistSetup = useCallback(async (input: {
    displayName: string;
    businessName?: string | null;
    timezone?: string | null;
  }) => {
    if (!api) throw new Error(apiMessage('The CRM is not configured.'));
    const result = await api.bootstrapArtistAccount(input);
    await load();
    return result;
  }, [api, load]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      profile,
      memberships,
      account,
      api,
      error,
      email,
      signIn,
      signOut,
      completePasswordSetup,
      signUp,
      resendVerification,
      completeArtistSetup,
      refresh: load,
    }),
    [
      state, profile, memberships, account, api, error, email,
      signIn, signOut, completePasswordSetup,
      signUp, resendVerification, completeArtistSetup, load,
    ]
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
  if (!api) throw new Error(apiMessage('The CRM is not configured.'));
  return api;
}
