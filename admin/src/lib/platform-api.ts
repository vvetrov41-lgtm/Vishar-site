// Platform reads: integration status, notifications, capabilities, workspaces.
//
// Every function here is a named RPC introduced by migrations 0074-0077. None
// of them takes a profile argument, and none returns a token, a chat id, a
// provider account identifier or an integration configuration blob. That is a
// property of the database functions, not of this module - a page cannot widen
// it by asking differently.

import { ApiError, type CrmClient } from './api';

export type IntegrationOwnerKind = 'artist' | 'workspace';

export type IntegrationErrorCategory =
  | 'none'
  | 'not_connected'
  | 'credential_expired'
  | 'credential_rejected'
  | 'permission_revoked'
  | 'destination_unavailable'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'configuration_invalid'
  | 'unknown';

export type IntegrationChannel =
  | 'telegram'
  | 'calendar'
  | 'email'
  | 'payments'
  | 'gpt'
  | 'whatsapp'
  | 'instagram';

export interface IntegrationStatus {
  integration_id: string;
  owner_kind: IntegrationOwnerKind;
  owner_id: string;
  owner_label: string | null;
  integration_type: IntegrationChannel;
  provider: string;
  display_label: string | null;
  is_enabled: boolean;
  connected_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_category: IntegrationErrorCategory;
  assigned_artist_ids: string[];
  is_selected_route: boolean;
}

/**
 * What a card shows at a glance.
 *
 * `needs_attention` is deliberately distinct from `error`: an expired
 * credential is a thing the artist can fix themselves in a minute, and calling
 * it an error sends people to a developer instead of to the reconnect button.
 */
export type IntegrationHealth =
  | 'connected'
  | 'not_connected'
  | 'needs_attention'
  | 'error';

export function integrationHealth(status: IntegrationStatus): IntegrationHealth {
  if (!status.is_enabled) return 'not_connected';

  switch (status.last_error_category) {
    case 'none':
      return 'connected';
    case 'not_connected':
      return 'not_connected';
    case 'credential_expired':
    case 'credential_rejected':
    case 'permission_revoked':
    case 'destination_unavailable':
    case 'configuration_invalid':
      return 'needs_attention';
    // A rate limit or a provider outage is the provider having a bad minute.
    // It resolves without anybody touching the connection, so it is reported
    // rather than escalated - unless it is the most recent thing that happened
    // and nothing has succeeded since.
    case 'rate_limited':
    case 'provider_unavailable':
      return hasRecoveredSinceError(status) ? 'connected' : 'error';
    default:
      return 'error';
  }
}

function hasRecoveredSinceError(status: IntegrationStatus): boolean {
  if (!status.last_error_at) return true;
  if (!status.last_success_at) return false;
  return Date.parse(status.last_success_at) >= Date.parse(status.last_error_at);
}

export type NotificationStatus = 'pending' | 'delivered' | 'read' | 'dismissed';
export type NotificationPriority = 'low' | 'normal' | 'high';

export interface CrmNotification {
  id: string;
  artist_id: string | null;
  artist_label: string | null;
  notification_type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  priority: NotificationPriority;
  status: NotificationStatus;
  scheduled_at: string;
  read_at: string | null;
}

export interface CapabilityGrant {
  artist_id: string;
  capability: string;
  domain: string;
  is_write: boolean;
}

export interface Workspace {
  id: string;
  slug: string;
  display_name: string;
  workspace_type: 'solo' | 'studio';
  timezone: string;
  default_currency: string;
  is_active: boolean;
  workspace_role: 'owner' | 'admin' | 'booking_manager' | 'read_only';
  can_manage_workspace: boolean;
  can_manage_team: boolean;
  can_manage_integrations: boolean;
  artist_count: number;
}

/**
 * Snooze offsets, as durations rather than absolute times.
 *
 * "Tomorrow" resolves against the viewer's own clock to 09:00 local, which is
 * what somebody choosing it means. Everything crosses the wire as an instant,
 * so a snooze set in London and read in Lisbon still fires at the same moment.
 */
export function snoozeUntil(choice: '15m' | '1h' | 'tomorrow', from = new Date()): Date {
  if (choice === '15m') return new Date(from.getTime() + 15 * 60_000);
  if (choice === '1h') return new Date(from.getTime() + 60 * 60_000);

  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  // A snooze must move forward. Choosing "tomorrow" at 23:30 on a device whose
  // clock is ahead must not resolve into the past.
  if (tomorrow.getTime() <= from.getTime()) {
    return new Date(from.getTime() + 60 * 60_000);
  }
  return tomorrow;
}

function unwrap<T>(result: { data: unknown; error: unknown }, action: string): T {
  if (result.error) throw new ApiError(`Could not ${action}.`, result.error);
  return (result.data ?? []) as T;
}

export function createPlatformApi(client: CrmClient) {
  return {
    async listIntegrationStatus(): Promise<IntegrationStatus[]> {
      return unwrap<IntegrationStatus[]>(
        await client.rpc('list_integration_status'),
        'load integrations',
      );
    },

    async listNotifications(
      status?: NotificationStatus,
      limit = 50,
    ): Promise<CrmNotification[]> {
      return unwrap<CrmNotification[]>(
        await client.rpc('list_notifications', {
          p_status: status ?? null,
          p_limit: limit,
        }),
        'load notifications',
      );
    },

    async markNotificationRead(id: string): Promise<boolean> {
      const result = await client.rpc('mark_notification_read', { p_notification_id: id });
      if (result.error) throw new ApiError('Could not update that notification.', result.error);
      return result.data === true;
    },

    async snoozeFollowUp(followUpId: string, until: Date): Promise<void> {
      const result = await client.rpc('snooze_follow_up', {
        p_follow_up_id: followUpId,
        p_until: until.toISOString(),
      });
      if (result.error) throw new ApiError('Could not snooze that reminder.', result.error);
    },

    async listCapabilities(artistId?: string): Promise<CapabilityGrant[]> {
      return unwrap<CapabilityGrant[]>(
        await client.rpc('list_capabilities', { p_artist_id: artistId ?? null }),
        'load your permissions',
      );
    },

    async listWorkspaces(): Promise<Workspace[]> {
      return unwrap<Workspace[]>(await client.rpc('list_workspaces'), 'load workspaces');
    },
  };
}

export type PlatformApi = ReturnType<typeof createPlatformApi>;
