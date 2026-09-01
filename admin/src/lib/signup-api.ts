// Public artist signup, from the browser's side.
//
// Three calls, and the interesting thing about them is how little they decide.
// The policy read is a courtesy that tells the login screen whether to offer a
// link; `bootstrapArtistAccount` re-reads the same switch server-side and is
// the authority. Nothing here passes an identifier of any kind, because
// `public.bootstrap_artist_account` accepts none: it acts for `auth.uid()` and
// for nothing else, which is what makes "attach me to somebody else's
// organization" an impossible request rather than a refused one.
//
// The Auth calls (`signUp`, `resend`) stay in the session layer next door,
// alongside sign-in and the invitation password flow. This module is the CRM
// side of the boundary only.

import { ApiError, apiMessage, type CrmClient } from './api';

/** Whether the CRM is currently accepting new artists without an invitation.
 *  Readable before sign-in; it discloses one boolean and nothing else. */
export interface SignupPolicy {
  is_open: boolean;
}

/** What the bootstrap created, or found already created. `created` is false on
 *  every call after the first, which is how a double-submit is answered. */
export interface BootstrapResult {
  profile_id: string;
  workspace_id: string;
  artist_id: string;
  created: boolean;
}

export interface SignupSettings {
  is_open: boolean;
  max_signups_per_hour: number;
  max_workspaces_per_founder: number;
}

export function createSignupApi(client: CrmClient) {
  return {
    /** Fails closed: any error hides the signup link rather than offering a
     *  door the database would refuse anyway. */
    async selfServiceSignupPolicy(): Promise<SignupPolicy> {
      try {
        const result = await client.rpc('self_service_signup_policy');
        if (result.error) return { is_open: false };
        const value = result.data as { is_open?: unknown } | null;
        return { is_open: value?.is_open === true };
      } catch {
        return { is_open: false };
      }
    },

    async bootstrapArtistAccount(input: {
      displayName: string;
      businessName?: string | null;
      timezone?: string | null;
      defaultCurrency?: string | null;
    }): Promise<BootstrapResult> {
      const result = await client.rpc('bootstrap_artist_account', {
        p_display_name: input.displayName,
        p_business_name: input.businessName ?? null,
        p_timezone: input.timezone ?? null,
        p_default_currency: input.defaultCurrency ?? null,
      });
      if (result.error) {
        throw new ApiError(apiMessage('Could not finish setting up your CRM.'), result.error);
      }
      const value = result.data as Partial<BootstrapResult> | null;
      if (!value || typeof value.artist_id !== 'string') {
        throw new ApiError(apiMessage('Could not finish setting up your CRM.'), null);
      }
      return {
        profile_id: String(value.profile_id),
        workspace_id: String(value.workspace_id),
        artist_id: value.artist_id,
        created: value.created === true,
      };
    },

    /** Installation owner only; the database refuses everybody else. */
    async setSelfServiceSignup(input: {
      isOpen: boolean;
      maxSignupsPerHour?: number | null;
      maxWorkspacesPerFounder?: number | null;
    }): Promise<SignupSettings> {
      const result = await client.rpc('set_self_service_signup', {
        p_is_open: input.isOpen,
        p_max_signups_per_hour: input.maxSignupsPerHour ?? null,
        p_max_workspaces_per_founder: input.maxWorkspacesPerFounder ?? null,
      });
      if (result.error) {
        throw new ApiError(apiMessage('Could not change signup availability.'), result.error);
      }
      return result.data as SignupSettings;
    },
  };
}

export type SignupApi = ReturnType<typeof createSignupApi>;
