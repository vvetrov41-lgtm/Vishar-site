// The signed-in account, from the browser's side.
//
// Three calls, and none of them takes an identifier. `public.account_overview`,
// `public.set_my_display_name` and `public.delete_my_account` all act for
// `auth.uid()` and for nothing else, so "do this to somebody else's account" is
// not a request this module can make rather than one the server refuses.
//
// The user-facing role is read from here rather than derived from
// `profiles.role`. That column is the authorization role - 0130 gives every
// self-service founder `booking_manager` deliberately - and printing it next to
// somebody's name told a tattoo artist who owns their own book that they were a
// booking manager. The server answers instead, from the membership rows
// authorization itself reads.

import { ApiError, apiMessage, type CrmClient } from './api';

/** One name for the account route, so the popover link and the router cannot
 *  drift apart. */
export const ACCOUNT_PATH = '/account';

export type UserFacingRole =
  | 'operator'
  | 'artist'
  | 'booking_manager'
  | 'read_only'
  | 'none';

/** Why this account may not delete itself. Null when it may. */
export type DeleteBlockedReason = 'installation_owner' | 'shared_tenant' | null;

export interface AccountOverview {
  profile_id: string;
  email: string;
  display_name: string | null;
  /** The internal authorization role. Shown as context, never as the label. */
  global_role: string;
  user_role: UserFacingRole;
  is_self_service_founder: boolean;
  owned_artist_id: string | null;
  owned_workspace_id: string | null;
  can_delete_account: boolean;
  delete_blocked_reason: DeleteBlockedReason;
}

export interface AccountDeletion {
  deleted: boolean;
  scope: 'tenant' | 'membership';
}

const USER_FACING_ROLES: UserFacingRole[] = [
  'operator', 'artist', 'booking_manager', 'read_only', 'none',
];

function readRole(value: unknown): UserFacingRole {
  return USER_FACING_ROLES.includes(value as UserFacingRole)
    ? (value as UserFacingRole)
    : 'none';
}

function readBlockedReason(value: unknown): DeleteBlockedReason {
  return value === 'installation_owner' || value === 'shared_tenant' ? value : null;
}

export function createAccountApi(client: CrmClient) {
  return {
    async accountOverview(): Promise<AccountOverview> {
      const result = await client.rpc('account_overview');
      if (result.error) {
        throw new ApiError(apiMessage('Could not load your account.'), result.error);
      }
      const value = (result.data ?? {}) as Record<string, unknown>;
      if (typeof value.profile_id !== 'string') {
        throw new ApiError(apiMessage('Could not load your account.'), null);
      }
      return {
        profile_id: value.profile_id,
        email: String(value.email ?? ''),
        display_name: typeof value.display_name === 'string' ? value.display_name : null,
        global_role: String(value.global_role ?? ''),
        user_role: readRole(value.user_role),
        is_self_service_founder: value.is_self_service_founder === true,
        owned_artist_id: typeof value.owned_artist_id === 'string' ? value.owned_artist_id : null,
        owned_workspace_id: typeof value.owned_workspace_id === 'string' ? value.owned_workspace_id : null,
        can_delete_account: value.can_delete_account === true,
        delete_blocked_reason: readBlockedReason(value.delete_blocked_reason),
      };
    },

    async setMyDisplayName(displayName: string): Promise<string> {
      const result = await client.rpc('set_my_display_name', {
        p_display_name: displayName,
      });
      if (result.error) {
        throw new ApiError(apiMessage('Could not save your name.'), result.error);
      }
      const value = (result.data ?? {}) as { display_name?: unknown };
      return String(value.display_name ?? displayName);
    },

    /** `confirmation` is the account's own email address, checked server-side.
     *  A fixed word would be readable from this file; an address is proof the
     *  person is looking at the account they are deleting. */
    async deleteMyAccount(confirmation: string): Promise<AccountDeletion> {
      const result = await client.rpc('delete_my_account', {
        p_confirmation: confirmation,
      });
      if (result.error) {
        throw new ApiError(apiMessage('Could not delete your account.'), result.error);
      }
      const value = (result.data ?? {}) as { deleted?: unknown; scope?: unknown };
      return {
        deleted: value.deleted === true,
        scope: value.scope === 'tenant' ? 'tenant' : 'membership',
      };
    },
  };
}

export type AccountApi = ReturnType<typeof createAccountApi>;
