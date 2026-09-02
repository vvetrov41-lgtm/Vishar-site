// Platform reads and narrow platform-management RPCs.
//
// No method in this module exposes provider credentials, chat ids or internal
// routing keys. Booking-source mutations are named RPCs introduced by 0079;
// database capability checks remain authoritative.

import { apiMessage, ApiError, type CrmClient } from './api';
import { DEFAULT_BOOKING_FORMS_ORIGIN } from './supabase';

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

export type BookingSourceKind = 'external' | 'hosted';

export interface BookingSource {
  id: string;
  artist_id: string;
  public_source_id: string;
  source_kind: BookingSourceKind;
  display_label: string;
  allowed_origin: string | null;
  form_template: 'tattoo-enquiry';
  form_version: 'booking-v1';
  is_active: boolean;
  public_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBookingSourceInput {
  artistId: string;
  sourceKind: BookingSourceKind;
  displayLabel: string;
  allowedOrigin?: string | null;
}

export interface UpdateBookingSourceInput {
  bookingSourceId: string;
  displayLabel: string;
  allowedOrigin?: string | null;
  isActive: boolean;
}

// Public, non-secret booking origin. The default is the branded production
// booking host; a build may narrow it through VITE_BOOKING_FORMS_ORIGIN so a
// staging CRM never mints a production link. Construction stays here so the
// CRM has exactly one place that knows how a public booking URL is shaped.
export { DEFAULT_BOOKING_FORMS_ORIGIN };

export function bookingSourcePublicUrl(
  source: Pick<BookingSource, 'source_kind' | 'public_source_id' | 'public_path'>,
  origin: string = DEFAULT_BOOKING_FORMS_ORIGIN,
): string {
  if (source.source_kind === 'hosted') {
    if (!source.public_path) return '';
    return new URL(source.public_path, `${origin.replace(/\/$/, '')}/`).toString();
  }
  const url = new URL(`${origin.replace(/\/$/, '')}/`);
  url.searchParams.set('source', source.public_source_id);
  return url.toString();
}

export function snoozeUntil(choice: '15m' | '1h' | 'tomorrow', from = new Date()): Date {
  if (choice === '15m') return new Date(from.getTime() + 15 * 60_000);
  if (choice === '1h') return new Date(from.getTime() + 60 * 60_000);

  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
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
      if (result.error) throw new ApiError(apiMessage('Could not update that notification.'), result.error);
      return result.data === true;
    },

    async snoozeFollowUp(followUpId: string, until: Date): Promise<void> {
      const result = await client.rpc('snooze_follow_up', {
        p_follow_up_id: followUpId,
        p_until: until.toISOString(),
      });
      if (result.error) throw new ApiError(apiMessage('Could not snooze that reminder.'), result.error);
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

    async listBookingSources(artistId?: string): Promise<BookingSource[]> {
      return unwrap<BookingSource[]>(
        await client.rpc('list_booking_sources', { p_artist_id: artistId ?? null }),
        'load forms and websites',
      );
    },

    async createBookingSource(input: CreateBookingSourceInput): Promise<string> {
      const result = await client.rpc('create_booking_source', {
        p_artist_id: input.artistId,
        p_source_kind: input.sourceKind,
        p_display_label: input.displayLabel,
        p_allowed_origin: input.sourceKind === 'external' ? (input.allowedOrigin ?? null) : null,
        p_form_template: 'tattoo-enquiry',
        p_activate: false,
      });
      if (result.error) throw new ApiError(apiMessage('Could not create that form or website source.'), result.error);
      if (typeof result.data !== 'string') throw new ApiError(apiMessage('The booking source was not created.'), null);
      return result.data;
    },

    async updateBookingSource(input: UpdateBookingSourceInput): Promise<boolean> {
      const result = await client.rpc('update_booking_source', {
        p_booking_source_id: input.bookingSourceId,
        p_display_label: input.displayLabel,
        p_allowed_origin: input.allowedOrigin ?? null,
        p_is_active: input.isActive,
      });
      if (result.error) throw new ApiError(apiMessage('Could not update that form or website source.'), result.error);
      return result.data === true;
    },
  };
}

export type PlatformApi = ReturnType<typeof createPlatformApi>;
