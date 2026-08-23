// Organization and artist administration.
//
// Every call here is a named RPC from migrations 0087 and 0088. Nothing in this
// module writes a table directly, and nothing in it decides an authorization
// question — the database refuses what the caller may not do, and these methods
// let the refusal through as an error rather than pre-empting it.
//
// The one thing worth knowing before editing: `previewMembershipCapabilities`
// is how the capability editor learns what a grant would mean. It must stay a
// server call. Deriving it in the browser would recreate the permission model
// this platform spent 0074 and 0087 collapsing into one place.

import { ApiError, type CrmClient } from './api';
import type { ArtistAccessLevel, CrmRole } from './types';

export type WorkspaceType = 'solo' | 'studio';
export type WorkspaceRole = 'owner' | 'admin' | 'booking_manager' | 'read_only';

/** Ordered as the checklist renders. `external` is the honest one: it means the
 *  step cannot be finished inside the CRM because a provider approval or an
 *  OAuth consent happens somewhere else. */
export type OnboardingStatus =
  | 'ready'
  | 'required'
  | 'recommended'
  | 'optional'
  | 'external';

export type OnboardingStep =
  | 'identity'
  | 'workspace'
  | 'team'
  | 'booking'
  | 'notifications'
  | 'integrations'
  | 'automations';

export interface OnboardingRow {
  step: OnboardingStep;
  status: OnboardingStatus;
  detail: string;
  sort_order: number;
}

export interface WorkspaceArtist {
  id: string;
  slug: string;
  display_name: string;
  timezone: string;
  default_currency: string;
  is_active: boolean;
  member_count: number;
  active_booking_sources: number;
  enabled_integrations: number;
  viewer_has_membership: boolean;
  created_at: string;
}

export interface WorkspaceTeamMember {
  profile_id: string;
  display_name: string | null;
  email: string;
  profile_is_active: boolean;
  profile_role: CrmRole;
  workspace_role: WorkspaceRole;
  can_manage_workspace: boolean;
  can_manage_team: boolean;
  can_manage_integrations: boolean;
  membership_is_active: boolean;
  artist_access_count: number;
}

export interface ArtistMembershipRow {
  profile_id: string;
  display_name: string | null;
  email: string;
  profile_is_active: boolean;
  profile_role: CrmRole;
  access_level: ArtistAccessLevel;
  can_view_finance: boolean;
  can_manage_finance: boolean;
  can_manage_sessions: boolean;
  can_manage_integrations: boolean;
  is_active: boolean;
  grant_source: string;
}

export interface CapabilityPreviewRow {
  capability: string;
  domain: string;
  is_write: boolean;
  description: string;
  granted: boolean;
}

/** The membership shape the editor manipulates. These four booleans plus the
 *  access level are the entire grant vocabulary the database accepts; the
 *  capabilities they produce are derived server-side. */
export interface MembershipGrant {
  accessLevel: ArtistAccessLevel;
  canViewFinance: boolean;
  canManageFinance: boolean;
  canManageSessions: boolean;
  canManageIntegrations: boolean;
  isActive: boolean;
}

export interface WorkspaceAutomationDefault {
  id: string;
  workspace_id: string;
  name: string;
  trigger_event_type: string;
  action_title: string;
  is_enabled: boolean;
}

function unwrap<T>(result: { data: unknown; error: unknown }, action: string): T {
  if (result.error) throw new ApiError(`Could not ${action}.`, result.error);
  return (result.data ?? []) as T;
}

export function createControlPlaneApi(client: CrmClient) {
  return {
    async createWorkspace(input: {
      displayName: string;
      workspaceType: WorkspaceType;
      timezone?: string;
      defaultCurrency?: string;
    }): Promise<string> {
      const result = await client.rpc('create_workspace', {
        p_display_name: input.displayName,
        p_workspace_type: input.workspaceType,
        // The slug is derived from the name server-side. Deliberately not
        // offered here: it is an addressing detail, and asking for it would
        // make founding an organization a technical act.
        p_slug: null,
        p_timezone: input.timezone ?? 'Europe/London',
        p_default_currency: input.defaultCurrency ?? 'GBP',
      });
      if (result.error) throw new ApiError('Could not create that organization.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('The organization was not created.', null);
      return result.data;
    },

    async updateWorkspace(input: {
      workspaceId: string;
      displayName?: string | null;
      timezone?: string | null;
      defaultCurrency?: string | null;
      isActive?: boolean | null;
    }): Promise<boolean> {
      const result = await client.rpc('update_workspace', {
        p_workspace_id: input.workspaceId,
        p_display_name: input.displayName ?? null,
        p_timezone: input.timezone ?? null,
        p_default_currency: input.defaultCurrency ?? null,
        p_is_active: input.isActive ?? null,
      });
      if (result.error) throw new ApiError('Could not save that organization.', result.error);
      return result.data === true;
    },

    async createArtist(input: {
      workspaceId: string;
      displayName: string;
      timezone?: string | null;
      defaultCurrency?: string | null;
    }): Promise<string> {
      const result = await client.rpc('create_artist', {
        p_workspace_id: input.workspaceId,
        p_display_name: input.displayName,
        p_slug: null,
        p_timezone: input.timezone ?? null,
        p_default_currency: input.defaultCurrency ?? null,
        p_booking_reference_prefix: null,
      });
      if (result.error) throw new ApiError('Could not add that artist.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('The artist was not created.', null);
      return result.data;
    },

    async updateArtist(input: {
      artistId: string;
      displayName?: string | null;
      timezone?: string | null;
      defaultCurrency?: string | null;
      isActive?: boolean | null;
    }): Promise<boolean> {
      const result = await client.rpc('update_artist', {
        p_artist_id: input.artistId,
        p_display_name: input.displayName ?? null,
        p_timezone: input.timezone ?? null,
        p_default_currency: input.defaultCurrency ?? null,
        p_is_active: input.isActive ?? null,
      });
      if (result.error) throw new ApiError('Could not save that artist.', result.error);
      return result.data === true;
    },

    /** The one-shot bootstrap: gives an artist full access to their own book.
     *  The database refuses it the moment the artist has any membership, so the
     *  interface only offers it while the team list is empty. */
    async seatArtistOwner(profileId: string, artistId: string): Promise<string> {
      const result = await client.rpc('seat_artist_owner', {
        p_profile_id: profileId,
        p_artist_id: artistId,
      });
      if (result.error) throw new ApiError('Could not seat that artist.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('The seat was not created.', null);
      return result.data;
    },

    async listWorkspaceArtists(workspaceId: string): Promise<WorkspaceArtist[]> {
      return unwrap<WorkspaceArtist[]>(
        await client.rpc('list_workspace_artists', { p_workspace_id: workspaceId }),
        'load the artists in this organization',
      );
    },

    async listWorkspaceTeam(workspaceId: string): Promise<WorkspaceTeamMember[]> {
      return unwrap<WorkspaceTeamMember[]>(
        await client.rpc('list_workspace_team', { p_workspace_id: workspaceId }),
        'load the people in this organization',
      );
    },

    async listArtistMemberships(artistId: string): Promise<ArtistMembershipRow[]> {
      return unwrap<ArtistMembershipRow[]>(
        await client.rpc('list_artist_memberships', { p_artist_id: artistId }),
        'load who can reach this artist',
      );
    },

    async artistOnboardingState(artistId: string): Promise<OnboardingRow[]> {
      return unwrap<OnboardingRow[]>(
        await client.rpc('artist_onboarding_state', { p_artist_id: artistId }),
        'load what this artist still needs',
      );
    },

    async previewMembershipCapabilities(
      artistId: string,
      profileId: string,
      grant: Omit<MembershipGrant, 'isActive'>,
    ): Promise<CapabilityPreviewRow[]> {
      return unwrap<CapabilityPreviewRow[]>(
        await client.rpc('preview_membership_capabilities', {
          p_artist_id: artistId,
          p_profile_id: profileId,
          p_access_level: grant.accessLevel,
          p_can_view_finance: grant.canViewFinance,
          p_can_manage_finance: grant.canManageFinance,
          p_can_manage_sessions: grant.canManageSessions,
          p_can_manage_integrations: grant.canManageIntegrations,
        }),
        'work out what that access would allow',
      );
    },

    async upsertWorkspaceMembership(input: {
      profileId: string;
      workspaceId: string;
      workspaceRole: WorkspaceRole;
      canManageWorkspace: boolean;
      canManageTeam: boolean;
      canManageIntegrations: boolean;
      isActive: boolean;
    }): Promise<string> {
      const result = await client.rpc('upsert_workspace_membership', {
        p_profile_id: input.profileId,
        p_workspace_id: input.workspaceId,
        p_workspace_role: input.workspaceRole,
        p_can_manage_workspace: input.canManageWorkspace,
        p_can_manage_team: input.canManageTeam,
        p_can_manage_integrations: input.canManageIntegrations,
        p_is_active: input.isActive,
      });
      if (result.error) throw new ApiError('Could not save that organization access.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('That access was not saved.', null);
      return result.data;
    },

    async grantArtistMembership(input: {
      profileId: string;
      artistId: string;
      grant: MembershipGrant;
    }): Promise<string> {
      const result = await client.rpc('grant_workspace_artist_membership', {
        p_profile_id: input.profileId,
        p_artist_id: input.artistId,
        p_access_level: input.grant.accessLevel,
        p_can_view_finance: input.grant.canViewFinance,
        p_can_manage_finance: input.grant.canManageFinance,
        p_can_manage_sessions: input.grant.canManageSessions,
        p_can_manage_integrations: input.grant.canManageIntegrations,
        p_is_active: input.grant.isActive,
      });
      if (result.error) throw new ApiError('Could not save that artist access.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('That access was not saved.', null);
      return result.data;
    },

    async listWorkspaceAutomationDefaults(
      workspaceId: string,
    ): Promise<WorkspaceAutomationDefault[]> {
      return unwrap<WorkspaceAutomationDefault[]>(
        await client.rpc('list_workspace_automation_defaults', { p_workspace_id: workspaceId }),
        'load this organization’s automation defaults',
      );
    },

    async applyWorkspaceAutomationDefaults(artistId: string): Promise<number> {
      const result = await client.rpc('apply_workspace_automation_defaults_to_artist', {
        p_artist_id: artistId,
      });
      if (result.error) throw new ApiError('Could not apply those defaults.', result.error);
      return typeof result.data === 'number' ? result.data : 0;
    },
  };
}

export type ControlPlaneApi = ReturnType<typeof createControlPlaneApi>;
