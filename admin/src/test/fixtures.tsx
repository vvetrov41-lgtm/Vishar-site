// Test fixtures and a fake Supabase client.
//
// Everything here is fabricated: reserved `.test` addresses, fixed UUIDs, no
// real client and no real credential. The fake client also models the parts of
// row level security the interface depends on — a manager reading
// `projects_finance` gets zero rows, exactly as the database returns — so a
// component test that "passes" cannot be passing for the wrong reason.

import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { CrmClient } from '../lib/api';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import type { ArtistMembership, CrmRole, EnquiryStatus } from '../lib/types';

export const VLADIMIR_ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
export const KRISTINA_ARTIST_ID = 'a2222222-2222-4222-8222-222222222222';
export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
export const READER_ID = '33333333-3333-4333-8333-333333333333';
export const DISABLED_ID = '44444444-4444-4444-8444-444444444444';
export const CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const ENQUIRY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SESSION_ID = '55555555-5555-4555-8555-555555555555';
export const FILE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const ARTISTS = [
  { id: VLADIMIR_ARTIST_ID, slug: 'vladimir', display_name: 'Vladimir Vishar', timezone: 'Europe/London', default_currency: 'GBP', is_active: true },
  { id: KRISTINA_ARTIST_ID, slug: 'kristina', display_name: 'Kristina Vishar', timezone: 'Europe/London', default_currency: 'GBP', is_active: true },
];

// Integration status as public.list_integration_status() returns it: safe
// metadata only. There is deliberately no token, chat id, provider account id
// or configuration blob here, because the function does not return one.
export const INTEGRATION_STATUS = [
  {
    integration_id: 'i1111111-1111-4111-8111-111111111111',
    owner_kind: 'artist' as const,
    owner_id: VLADIMIR_ARTIST_ID,
    owner_label: 'Vladimir Vishar',
    integration_type: 'telegram' as const,
    provider: 'telegram',
    display_label: 'Vladimir (private chat)',
    is_enabled: true,
    connected_at: '2026-08-01T09:00:00Z',
    last_success_at: '2026-08-20T18:00:00Z',
    last_error_at: null,
    last_error_category: 'none' as const,
    assigned_artist_ids: [] as string[],
    is_selected_route: true,
  },
  {
    integration_id: 'i2222222-2222-4222-8222-222222222222',
    owner_kind: 'artist' as const,
    owner_id: KRISTINA_ARTIST_ID,
    owner_label: 'Kristina Vishar',
    integration_type: 'calendar' as const,
    provider: 'google',
    display_label: 'kristina@example.test',
    is_enabled: true,
    connected_at: '2026-08-02T09:00:00Z',
    last_success_at: null,
    last_error_at: '2026-08-21T07:00:00Z',
    last_error_category: 'credential_expired' as const,
    assigned_artist_ids: [] as string[],
    is_selected_route: false,
  },
  {
    integration_id: 'i3333333-3333-4333-8333-333333333333',
    owner_kind: 'workspace' as const,
    owner_id: 'w1111111-1111-4111-8111-111111111111',
    owner_label: 'Example Studio',
    integration_type: 'whatsapp' as const,
    provider: 'meta_cloud_api',
    display_label: 'Studio reception',
    is_enabled: false,
    connected_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error_category: 'not_connected' as const,
    assigned_artist_ids: [VLADIMIR_ARTIST_ID],
    is_selected_route: false,
  },
];

export const NOTIFICATIONS = [
  {
    id: 'n1111111-1111-4111-8111-111111111111',
    artist_id: VLADIMIR_ARTIST_ID,
    artist_label: 'Vladimir Vishar',
    notification_type: 'follow_up.due',
    title: 'Reply to Charlie',
    body: 'He asked about the sleeve.',
    entity_type: 'follow_up',
    entity_id: 'fu111111-1111-4111-8111-111111111111',
    priority: 'high' as const,
    status: 'delivered' as const,
    scheduled_at: '2026-08-20T09:00:00Z',
    read_at: null,
  },
  {
    id: 'n2222222-2222-4222-8222-222222222222',
    artist_id: KRISTINA_ARTIST_ID,
    artist_label: 'Kristina Vishar',
    notification_type: 'follow_up.due',
    title: 'Check references',
    body: null,
    entity_type: 'enquiry',
    entity_id: ENQUIRY_ID,
    priority: 'normal' as const,
    status: 'read' as const,
    scheduled_at: '2026-08-19T09:00:00Z',
    read_at: '2026-08-19T10:00:00Z',
  },
];

export const PROFILES = {
  owner: { id: OWNER_ID, email: 'owner@example.test', display_name: 'Owner', role: 'owner' as CrmRole, is_active: true, created_at: '2026-01-01T00:00:00Z' },
  booking_manager: { id: MANAGER_ID, email: 'manager@example.test', display_name: 'Manager', role: 'booking_manager' as CrmRole, is_active: true, created_at: '2026-01-02T00:00:00Z' },
  read_only: { id: READER_ID, email: 'reader@example.test', display_name: 'Reader', role: 'read_only' as CrmRole, is_active: true, created_at: '2026-01-03T00:00:00Z' },
  deactivated: { id: DISABLED_ID, email: 'former@example.test', display_name: 'Former', role: 'booking_manager' as CrmRole, is_active: false, created_at: '2026-01-04T00:00:00Z' },
};

export const MEMBERSHIPS = [
  ...ARTISTS.map((artist) => ({
    profile_id: OWNER_ID,
    artist_id: artist.id,
    access_level: 'owner' as const,
    can_view_finance: true,
    can_manage_finance: true,
    can_manage_sessions: true,
    can_manage_integrations: true,
    is_active: true,
  })),
  {
    profile_id: MANAGER_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    access_level: 'manager' as const,
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
    is_active: true,
  },
  {
    profile_id: READER_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    access_level: 'read_only' as const,
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: false,
    can_manage_integrations: false,
    is_active: true,
  },
];

export const CLIENT = {
  id: CLIENT_ID,
  full_name: 'Fixture Client',
  email: 'fixture@example.test',
  phone: '+447700900000',
  instagram: '@fixture',
  preferred_contact: 'Email',
  travelling_from: 'Manchester',
  notes_summary: null,
  created_at: '2026-07-01T09:00:00Z',
  updated_at: '2026-07-01T09:00:00Z',
  archived_at: null,
};

export const ENQUIRY = {
  id: ENQUIRY_ID,
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: CLIENT_ID,
  reference_number: 'ENQ-2026-0001',
  status: 'new' as const,
  intake_state: 'complete' as const,
  intake_error_code: null,
  client_identifier_conflict: true,
  assigned_to: null,
  submitted_full_name: 'Fixture Client',
  submitted_email: 'fixture@example.test',
  submitted_phone: '+447700900099',
  submitted_instagram: '@fixture',
  submitted_preferred_contact: 'Email',
  submitted_travelling_from: 'Manchester',
  project_type: 'Colour realism',
  placement: 'Outer forearm',
  approximate_size: '20 cm',
  cover_up: 'No',
  preferred_timing: 'Flexible',
  idea: 'A realistic raven with natural lighting.',
  source: '/booking/',
  utm_source: 'google',
  created_at: '2026-07-01T09:00:00Z',
  last_action_at: '2026-07-01T09:00:00Z',
  archived_at: null,
};

export const PROJECT = {
  id: PROJECT_ID,
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: CLIENT_ID,
  enquiry_id: ENQUIRY_ID,
  status: 'active' as const,
  title: 'Raven sleeve',
  description: 'Full outer sleeve.',
  estimated_sessions: 3,
  estimated_hours: 18,
  deposit_status: 'requested' as const,
  currency: 'GBP',
  created_at: '2026-07-02T09:00:00Z',
  updated_at: '2026-07-02T09:00:00Z',
  archived_at: null,
};

export const PROJECT_FINANCE = {
  project_id: PROJECT_ID,
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: CLIENT_ID,
  currency: 'GBP',
  hourly_rate: 140,
  estimate_total: 2520,
  deposit_amount: 150,
  deposit_status: 'requested' as const,
};

export const SESSION = {
  id: SESSION_ID,
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: CLIENT_ID,
  project_id: PROJECT_ID,
  appointment_type: 'tattoo_session' as const,
  status: 'proposed' as const,
  start_at: '2026-09-01T10:00:00Z',
  end_at: '2026-09-01T16:00:00Z',
  duration_hours: 6,
  currency: 'GBP',
  payment_status: 'unpaid' as const,
  calendar_provider: 'none' as const,
  calendar_event_id: null,
  calendar_version: 0,
  notes: null,
  cancelled_at: null,
};

export const ENQUIRY_FILE = {
  id: FILE_ID,
  enquiry_id: ENQUIRY_ID,
  ordinal: 0,
  storage_path: `clients/${CLIENT_ID}/enquiries/${ENQUIRY_ID}/references/${FILE_ID}.jpg`,
  original_filename: 'reference-1.jpg',
  mime_type: 'image/jpeg',
  byte_size: 2048,
  upload_state: 'ready' as const,
  created_at: '2026-07-01T09:00:01Z',
};

export const TRANSITIONS = [
  { from_status: 'new' as const, to_status: 'reviewing' as const, owner_only: false, note: null },
  { from_status: 'new' as const, to_status: 'declined' as const, owner_only: false, note: null },
  { from_status: 'declined' as const, to_status: 'reviewing' as const, owner_only: true, note: null },
];

export const ACTIVITY = [
  {
    id: 'act-1', artist_id: VLADIMIR_ARTIST_ID, occurred_at: '2026-07-01T09:00:02Z', event_type: 'enquiry.created',
    actor_kind: 'worker', actor_profile_id: null, client_id: CLIENT_ID,
    enquiry_id: ENQUIRY_ID, project_id: null, session_id: null, metadata: {},
  },
];

export const CONVERSATION_ID = '99999999-9999-4999-8999-999999999999';
export const LINKED_CONVERSATION_ID = '88888888-8888-4888-8888-888888888888';

/**
 * One unmatched Instagram conversation and one linked WhatsApp conversation.
 * Between them they exercise both inbox states without needing a second
 * fixture set.
 */
export const CONVERSATIONS = [
  {
    id: CONVERSATION_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    channel: 'instagram' as const,
    link_state: 'unmatched' as const,
    state: 'open' as const,
    client_id: null,
    client_name: null,
    enquiry_id: null,
    external_username: 'synthetic.sender',
    external_display_label: null,
    last_message_at: '2026-08-18T09:05:00Z',
    last_inbound_at: '2026-08-18T09:05:00Z',
    operator_read_at: null,
    has_unread: true,
    latest_preview: 'Do you do cover ups?',
    latest_direction: 'inbound' as const,
    latest_message_type: 'text',
  },
  {
    id: LINKED_CONVERSATION_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    channel: 'whatsapp' as const,
    link_state: 'linked' as const,
    state: 'open' as const,
    client_id: CLIENT_ID,
    client_name: 'Fixture Client',
    enquiry_id: ENQUIRY_ID,
    external_username: null,
    external_display_label: null,
    last_message_at: '2026-08-18T08:00:00Z',
    last_inbound_at: '2026-08-18T08:00:00Z',
    operator_read_at: '2026-08-18T08:01:00Z',
    has_unread: false,
    latest_preview: 'Thanks, see you then',
    latest_direction: 'outbound' as const,
    latest_message_type: 'text',
  },
];

export const CONVERSATION_MESSAGES = [
  {
    id: 'm1111111-1111-4111-8111-111111111111'.replace('m', 'a'),
    direction: 'inbound' as const,
    origin: 'contact' as const,
    status: 'received' as const,
    message_type: 'text',
    body: 'Do you do cover ups?',
    attachments: [],
    created_at: '2026-08-18T09:05:00Z',
    error_code: null,
  },
];

export interface FakeClientOptions {
  role: CrmRole | 'deactivated' | 'signed_out' | 'no_profile';
  /** Records every RPC the interface attempts, so tests can assert on writes. */
  rpcCalls?: { name: string; args: Record<string, unknown> | undefined }[];
  /** Records PostgREST filters so detail pages can prove server-side scoping. */
  queryCalls?: { table: string; method: string; args: unknown[] }[];
  /** Force an error from one table, to exercise the error state. */
  failTable?: string;
  /** Override the enquiry lifecycle state for workflow-specific screens. */
  enquiryStatus?: EnquiryStatus;
  /** Artist identities returned by list_accessible_artists(). */
  accessibleArtistIds?: string[];
  /**
   * Extra `sessions` rows appended to the shared SESSION fixture. Grouped
   * deposit selection only renders with two or more eligible appointments.
   */
  extraSessions?: Record<string, unknown>[];
  /**
   * Replaces the pool `artist_memberships` is filtered from, for tests that
   * need a specific capability combination (e.g. can_manage_finance without
   * can_manage_integrations). Defaults to the shared `MEMBERSHIPS` fixture.
   */
  membershipOverrides?: ArtistMembership[];
  teamInviteUrl?: string;
  /**
   * Control-plane fixtures. Absent by default so every existing test keeps
   * seeing an installation with no organizations, which is what
   * `list_workspaces` returned before migration 0087 gave it anything to
   * return.
   */
  workspaces?: ControlPlaneWorkspace[];
  workspaceArtists?: Record<string, ControlPlaneArtist[]>;
  workspaceTeam?: Record<string, ControlPlaneTeamMember[]>;
  artistMemberships?: Record<string, ControlPlaneArtistMembership[]>;
  /** Capability rows preview_membership_capabilities should answer with. */
  capabilityPreview?: ControlPlaneCapability[];
  /** Booking sources `list_booking_sources` should answer with. */
  bookingSources?: unknown[];
  /** People `list_directory_profiles` should answer with. */
  directory?: ControlPlaneDirectoryProfile[];
  /**
   * What `control_plane_access` answers. Absent means no row, which is how the
   * function signals a profile with no active CRM identity — and is what the
   * older tests expect, since none of them belongs to an organization.
   */
  controlPlaneAccess?: ControlPlaneAccessRow | null;
  /** What `artist_control_plane_context` answers, keyed by artist id. */
  artistContexts?: Record<string, ControlPlaneArtistContext>;
  /**
   * Capability preview keyed by target profile id. Lets a test prove the
   * preview is re-fetched for a new subject rather than reused, which the
   * single `capabilityPreview` list cannot express.
   */
  capabilityPreviewByProfile?: Record<string, ControlPlaneCapability[]>;
  /** RPC names that must refuse, so a test can prove a section collapses. */
  denyRpc?: string[];
}

export interface ControlPlaneWorkspace {
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

export interface ControlPlaneArtist {
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

export interface ControlPlaneTeamMember {
  profile_id: string;
  display_name: string | null;
  email: string;
  profile_is_active: boolean;
  profile_role: CrmRole;
  workspace_role: 'owner' | 'admin' | 'booking_manager' | 'read_only';
  can_manage_workspace: boolean;
  can_manage_team: boolean;
  can_manage_integrations: boolean;
  membership_is_active: boolean;
  artist_access_count: number;
}

export interface ControlPlaneArtistMembership {
  profile_id: string;
  display_name: string | null;
  email: string;
  profile_is_active: boolean;
  profile_role: CrmRole;
  access_level: 'owner' | 'artist' | 'manager' | 'read_only';
  can_view_finance: boolean;
  can_manage_finance: boolean;
  can_manage_sessions: boolean;
  can_manage_integrations: boolean;
  is_active: boolean;
  grant_source: string;
}

export interface ControlPlaneDirectoryProfile {
  id: string;
  display_name: string | null;
  email: string;
  profile_role: CrmRole;
  can_hold_artist_writes: boolean;
}

export interface ControlPlaneAccessRow {
  workspace_count: number;
  administers_any: boolean;
  can_manage_any_team: boolean;
  can_found_workspace: boolean;
  can_browse_directory: boolean;
}

export interface ControlPlaneArtistContext {
  artist_id: string;
  artist_slug: string;
  artist_display_name: string;
  artist_timezone: string;
  artist_default_currency: string;
  artist_is_active: boolean;
  member_count: number;
  active_booking_sources: number;
  enabled_integrations: number;
  workspace_id: string;
  workspace_display_name: string;
  workspace_type: 'solo' | 'studio';
  viewer_can_administer: boolean;
  viewer_has_artist_membership: boolean;
  viewer_can_manage_team: boolean;
}

export interface ControlPlaneCapability {
  capability: string;
  domain: string;
  is_write: boolean;
  description: string;
  granted: boolean;
}

export const STUDIO_WORKSPACE_ID = 'w1111111-1111-4111-8111-111111111111';
export const NEW_ARTIST_ID = 'a9999999-9999-4999-8999-999999999999';

const DENIED = { code: '42501', message: 'permission denied' };

/**
 * A query builder that behaves like PostgREST's chainable API and resolves to
 * the rows the corresponding role would actually be able to read.
 */
function tableResult(
  table: string,
  role: CrmRole | null,
  failTable?: string,
  enquiryStatus?: EnquiryStatus,
  extraSessions: Record<string, unknown>[] = []
) {
  if (failTable === table) return { data: null, error: { code: 'PGRST000', message: 'boom' } };

  const canManage = role === 'owner' || role === 'booking_manager';

  switch (table) {
    case 'profiles':
      // Mirrors `profiles_select_self`, which is gated on `is_active`. A
      // deactivated account therefore cannot read even its own row — the same
      // reason it can read nothing else.
      return { data: role ? PROFILES[role] : null, error: null };
    case 'clients':
      return { data: [CLIENT], error: null };
    case 'enquiries':
      return { data: [{ ...ENQUIRY, status: enquiryStatus ?? ENQUIRY.status }], error: null };
    case 'enquiry_files':
      // read_only has no file policy, so the database returns nothing.
      return { data: canManage ? [ENQUIRY_FILE] : [], error: null };
    case 'enquiry_status_transitions':
      return { data: TRANSITIONS, error: null };
    case 'projects':
      return { data: [PROJECT], error: null };
    case 'projects_finance':
      // Owner-only view: a non-owner selects zero rows, not an error.
      return { data: role === 'owner' ? [PROJECT_FINANCE] : [], error: null };
    case 'sessions':
      return { data: [SESSION, ...extraSessions], error: null };
    case 'sessions_finance':
      return { data: role === 'owner' ? [{ session_id: SESSION_ID, artist_id: VLADIMIR_ARTIST_ID, project_id: PROJECT_ID, currency: 'GBP', price: 840, payment_status: 'unpaid' }] : [], error: null };
    case 'internal_notes':
      return { data: canManage ? [{ id: 'note-1', author_profile_id: OWNER_ID, body: 'Internal note', created_at: '2026-07-02T09:00:00Z' }] : [], error: null };
    case 'communication_conversations':
      return { data: CONVERSATIONS, error: null };
    case 'communication_messages':
      return { data: CONVERSATION_MESSAGES, error: null };
    case 'email_messages':
      return { data: canManage ? [] : [], error: null };
    case 'follow_ups':
      return { data: [{ id: 'fu-1', artist_id: VLADIMIR_ARTIST_ID, status: 'open', due_at: '2026-07-05T09:00:00Z', subject: 'Chase references', details: null, client_id: CLIENT_ID, enquiry_id: ENQUIRY_ID, project_id: null, assigned_to: null }], error: null };
    case 'activity_log':
      return { data: canManage ? ACTIVITY : [], error: null };
    case 'integration_outbox':
      return { data: role === 'owner' ? [{ id: 'job-1', artist_id: VLADIMIR_ARTIST_ID, kind: 'telegram_notification', status: 'failed', attempt_count: 3, max_attempts: 8, next_attempt_at: '2026-07-01T10:00:00Z', last_error_code: 'telegram_rejected', updated_at: '2026-07-01T09:30:00Z' }] : [], error: null };
    default:
      return { data: [], error: null };
  }
}

export function createFakeClient(options: FakeClientOptions): CrmClient {
  const roleKey = options.role;
  const profile =
    roleKey === 'signed_out' || roleKey === 'no_profile'
      ? null
      : roleKey === 'deactivated'
        ? PROFILES.deactivated
        : PROFILES[roleKey];

  const effectiveRole: CrmRole | null = profile?.is_active ? profile.role : null;
  const rpcCalls = options.rpcCalls ?? [];
  const queryCalls = options.queryCalls ?? [];
  const accessibleArtistIds = options.accessibleArtistIds ?? (effectiveRole === 'owner'
    ? ARTISTS.map((artist) => artist.id)
    : [VLADIMIR_ARTIST_ID]);

  const workspaces = options.workspaces ?? [];
  const workspaceArtists = options.workspaceArtists ?? {};
  const workspaceTeam = options.workspaceTeam ?? {};
  const artistMemberships = options.artistMemberships ?? {};
  const capabilityPreview = options.capabilityPreview ?? [];
  const bookingSources = options.bookingSources ?? [];
  const directory = options.directory ?? [];
  const controlPlaneAccess = options.controlPlaneAccess ?? null;
  const artistContexts = options.artistContexts ?? {};
  const capabilityPreviewByProfile = options.capabilityPreviewByProfile ?? null;
  const denyRpc = options.denyRpc ?? [];

  /**
   * Mirrors the real `artist_memberships` RLS policy
   * (`profile_id = auth.uid() AND is_active_user()`), not the RPC used
   * elsewhere: `session.tsx` reads its own scoped capabilities through this
   * table directly, without any RPC, so the fake must model it directly too.
   */
  function artistMembershipsResult() {
    if (options.failTable === 'artist_memberships') {
      return { data: null, error: { code: 'PGRST000', message: 'boom' } };
    }
    const pool = options.membershipOverrides ?? MEMBERSHIPS;
    return {
      data: pool.filter((membership) => membership.profile_id === profile?.id && membership.is_active),
      error: null,
    };
  }

  function builder(table: string): any {
    const result = table === 'artist_memberships'
      ? artistMembershipsResult()
      : tableResult(
        table,
        effectiveRole,
        options.failTable,
        options.enquiryStatus,
        options.extraSessions
      );
    // PostgREST applies `eq` server-side, so the fake does too. Without this a
    // screen that scopes a read by client, project or status would "pass" while
    // rendering rows the database would never have returned.
    const filters: { column: string; value: unknown }[] = [];
    const chain: any = {
      select: () => chain,
      eq: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'eq', args });
        if (typeof args[0] === 'string') filters.push({ column: args[0], value: args[1] });
        return chain;
      },
      is: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'is', args });
        return chain;
      },
      in: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'in', args });
        return chain;
      },
      ilike: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'ilike', args });
        return chain;
      },
      or: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'or', args });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        const filtered = applyFilters(result.data);
        return Promise.resolve({
          data: Array.isArray(filtered) ? (filtered[0] ?? null) : filtered,
          error: result.error,
        });
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: applyFilters(result.data), error: result.error }).then(resolve),
    };

    /**
     * Only columns the fixture row actually carries are filtered on. A filter
     * naming a column the fixture does not model is left alone rather than
     * silently emptying the result, so adding a column to the interface does not
     * quietly blank an unrelated screen.
     */
    function applyFilters(data: unknown): unknown {
      if (!Array.isArray(data) || filters.length === 0) return data;
      return data.filter((row: any) => filters.every(({ column, value }) => (
        row === null
        || typeof row !== 'object'
        || !(column in row)
        || row[column] === value
      )));
    }

    return chain;
  }

  return {
    from: builder,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });

      // Role checks live in the database. The fake enforces the same ones, so a
      // component test cannot "pass" by calling something the real RPC refuses.
      const ownerOnly = ['list_profiles', 'list_team_memberships', 'set_profile_role', 'set_profile_active', 'upsert_artist_membership', 'approve_email_draft', 'update_project_deposit', 'update_project_estimate', 'update_retention_policy'];
      const managerOrOwner = ['queue_communication_message', 'link_communication_conversation_client', 'create_client_from_communication', 'create_enquiry_from_communication', 'set_communication_conversation_state', 'transition_enquiry_status', 'assign_enquiry', 'convert_enquiry_to_project', 'schedule_session', 'set_session_status', 'create_internal_note', 'create_follow_up', 'complete_follow_up', 'create_email_draft', 'list_assignable_profiles'];

      if (ownerOnly.includes(name) && effectiveRole !== 'owner') return { data: null, error: DENIED };
      if (managerOrOwner.includes(name) && effectiveRole !== 'owner' && effectiveRole !== 'booking_manager') {
        return { data: null, error: DENIED };
      }

      if (name === 'list_communication_conversations') {
        const channel = (args as any)?.p_channel ?? null;
        const linkState = (args as any)?.p_link_state ?? null;
        return {
          data: CONVERSATIONS.filter(
            (conversation) => (!channel || conversation.channel === channel)
              && (!linkState || conversation.link_state === linkState),
          ),
          error: null,
        };
      }
      if (name === 'list_accessible_artists') {
        return { data: ARTISTS.filter((artist) => accessibleArtistIds.includes(artist.id)), error: null };
      }
      if (name === 'list_integration_status') return { data: INTEGRATION_STATUS, error: null };
      if (name === 'list_notifications') {
        const status = (args as any)?.p_status ?? null;
        return {
          data: NOTIFICATIONS.filter((row) => !status || row.status === status),
          error: null,
        };
      }
      if (name === 'mark_notification_read') return { data: true, error: null };
      if (name === 'snooze_follow_up') {
        return { data: { follow_up_id: (args as any)?.p_follow_up_id, schedule_version: 2 }, error: null };
      }
      if (name === 'list_capabilities') return { data: [], error: null };

      // --- Control plane ---------------------------------------------------
      // Every one of these refuses rather than answering empty when the option
      // says so. The distinction matters: the screens must collapse a section
      // they are not allowed to read, and must not mistake "no rows" for
      // "not permitted".
      if (denyRpc.includes(name)) return { data: null, error: DENIED };

      if (name === 'list_workspaces') return { data: workspaces, error: null };
      if (name === 'list_workspace_artists') {
        const id = String((args as any)?.p_workspace_id ?? '');
        if (!workspaces.some((workspace) => workspace.id === id)) {
          return { data: null, error: DENIED };
        }
        return { data: workspaceArtists[id] ?? [], error: null };
      }
      if (name === 'list_workspace_team') {
        const id = String((args as any)?.p_workspace_id ?? '');
        const workspace = workspaces.find((candidate) => candidate.id === id);
        if (!workspace || !workspace.can_manage_team) return { data: null, error: DENIED };
        return { data: workspaceTeam[id] ?? [], error: null };
      }
      if (name === 'list_artist_memberships') {
        const id = String((args as any)?.p_artist_id ?? '');
        return { data: artistMemberships[id] ?? [], error: null };
      }
      if (name === 'artist_onboarding_state') {
        const id = String((args as any)?.p_artist_id ?? '');
        const members = artistMemberships[id] ?? [];
        const artist = Object.values(workspaceArtists).flat().find((row) => row.id === id);
        if (!artist) return { data: null, error: DENIED };
        return {
          data: [
            { step: 'identity', status: artist.is_active ? 'ready' : 'required',
              detail: `${artist.display_name} · ${artist.timezone}`, sort_order: 1 },
            { step: 'workspace', status: 'ready', detail: 'Studio', sort_order: 2 },
            { step: 'team',
              status: members.some((m) => m.is_active && (m.access_level === 'artist' || m.access_level === 'owner'))
                ? 'ready' : members.length > 0 ? 'recommended' : 'required',
              detail: members.length === 0 ? 'Nobody can open this artist yet' : `${members.length} with access`,
              sort_order: 3 },
            { step: 'booking',
              status: artist.active_booking_sources > 0 ? 'ready' : 'recommended',
              detail: 'No booking form or website yet', sort_order: 4 },
            { step: 'notifications', status: 'recommended', detail: 'Nobody has a destination', sort_order: 5 },
            { step: 'integrations',
              status: artist.enabled_integrations > 0 ? 'ready' : 'external',
              detail: 'Some need approval outside the CRM', sort_order: 6 },
            { step: 'automations', status: 'optional', detail: 'No studio defaults to apply', sort_order: 7 },
          ],
          error: null,
        };
      }
      if (name === 'preview_membership_capabilities') {
        // Keyed by subject when the test supplies a map, so a stale preview
        // after switching person is observable rather than invisible.
        if (capabilityPreviewByProfile) {
          const target = String((args as any)?.p_profile_id ?? '');
          return { data: capabilityPreviewByProfile[target] ?? [], error: null };
        }
        return { data: capabilityPreview, error: null };
      }
      if (name === 'control_plane_access') {
        return { data: controlPlaneAccess ? [controlPlaneAccess] : [], error: null };
      }
      if (name === 'list_directory_profiles') {
        return { data: directory, error: null };
      }
      if (name === 'artist_control_plane_context') {
        const id = String((args as any)?.p_artist_id ?? '');
        const ctx = artistContexts[id];
        return ctx ? { data: [ctx], error: null } : { data: null, error: DENIED };
      }
      if (name === 'transfer_workspace_ownership') return { data: true, error: null };
      if (name === 'list_workspace_automation_defaults') return { data: [], error: null };
      // The booking-source list is artist-scoped and manage-level. Answering
      // with the generic `{ ok: true }` fallback would hand the page a
      // non-array and hide a real contract mismatch behind a crash.
      if (name === 'list_booking_sources') return { data: bookingSources, error: null };
      if (name === 'create_workspace') return { data: STUDIO_WORKSPACE_ID, error: null };
      if (name === 'create_artist') return { data: NEW_ARTIST_ID, error: null };
      if (name === 'seat_artist_owner') return { data: 'm0000000-0000-4000-8000-000000000000', error: null };
      if (name === 'grant_workspace_artist_membership') {
        return { data: 'm0000000-0000-4000-8000-000000000001', error: null };
      }
      if (name === 'upsert_workspace_membership') {
        return { data: 'm0000000-0000-4000-8000-000000000002', error: null };
      }
      if (name === 'update_workspace' || name === 'update_artist') return { data: true, error: null };
      if (name === 'apply_workspace_automation_defaults_to_artist') return { data: 0, error: null };
      if (name === 'list_profiles') return { data: Object.values(PROFILES), error: null };
      if (name === 'list_team_memberships') return { data: MEMBERSHIPS, error: null };
      if (name === 'list_assignable_profiles') {
        return { data: [PROFILES.owner, PROFILES.booking_manager].map((p) => ({ id: p.id, display_name: p.display_name, role: p.role })), error: null };
      }
      if (name === 'convert_enquiry_to_project') return { data: { project_id: PROJECT_ID }, error: null };
      // The project deposit amount is calculated by the server. The fake mirrors
      // that contract: the browser reads a preview and never sends an amount.
      if (name === 'preview_project_deposit') {
        return {
          data: {
            project_id: PROJECT_ID,
            artist_id: VLADIMIR_ARTIST_ID,
            currency: 'GBP',
            estimate_total: 2800,
            estimated_hours: 7,
            estimated_sessions: 3,
            policy_configured: true,
            calculable: true,
            mode: 'percentage_of_estimate',
            percentage: 25,
            rounding_step: 1,
            suggested_amount: 700,
            override_amount: null,
            amount: 700,
            reusable_destination_configured: true,
            open_payment_request_id: null,
            open_payment_request_status: null,
          },
          error: null,
        };
      }
      if (name === 'get_monzo_easy_bank_transfer_settings') {
        return {
          data: {
            configured: true,
            enabled: true,
            payment_url: 'https://monzo.com/pay/r/fixture',
            deposit_amount: 250,
            deposit_policy: 'duration_tiered_v1',
            deposit_tiers: [
              { max_minutes: 60, amount: 50, currency: 'GBP' },
              { max_minutes: 180, amount: 100, currency: 'GBP' },
              { max_minutes: 300, amount: 150, currency: 'GBP' },
              { max_minutes: null, amount: 250, currency: 'GBP' },
            ],
            currency: 'GBP',
            default_delivery_channel: 'email',
            email_status: 'ready',
            sms_status: 'not_configured',
            monzo_api_status: 'connected',
          },
          error: null,
        };
      }
      if (name === 'list_monzo_payment_destinations') {
        return { data: { destinations: [] }, error: null };
      }
      if (name === 'list_monzo_reconciliation_candidates') {
        return { data: [], error: null };
      }
      if (name === 'get_project_deposit_policy') {
        return {
          data: {
            configured: true,
            mode: 'fixed',
            fixed_amount: 150,
            percentage: null,
            minimum_amount: null,
            rounding_step: 1,
            currency: 'GBP',
          },
          error: null,
        };
      }
      if (name === 'request_project_deposit') {
        return {
          data: {
            payment_request_id: 'ppr-1',
            payment_link_id: 'ppl-1',
            public_path: '/pay-by-bank-transfer/11111111-1111-4111-8111-111111111111',
            amount: 700,
            currency: 'GBP',
            suggested_amount: 700,
            override_amount: null,
            destination_source: 'reusable',
            destination_ready: true,
            delivery_channel: 'copy_link',
            delivery_status: 'link_created',
            replayed: false,
          },
          error: null,
        };
      }
      return { data: { ok: true }, error: null };
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) =>
          effectiveRole === 'owner' || effectiveRole === 'booking_manager'
            ? { data: { signedUrl: `https://storage.example.test/signed/${path}?token=short-lived` }, error: null }
            : { data: null, error: DENIED },
      }),
    },
    auth: {
      getSession: async () => ({
        data: { session: roleKey === 'signed_out' ? null : {
          user: { id: profile?.id ?? '99999999-9999-4999-8999-999999999999' },
          access_token: 'synthetic.browser.access.token',
        } },
        error: null,
      }),
      signInWithPassword: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  };
}

export function renderWithSession(
  ui: ReactElement,
  options: FakeClientOptions & { path?: string }
): RenderResult & { rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] } {
  const rpcCalls = options.rpcCalls ?? [];
  const client = createFakeClient({ ...options, rpcCalls });

  const result = render(
    <SessionProvider client={client} teamInviteUrl={options.teamInviteUrl}>
      <RouterProvider initialPath={options.path ?? '/'}>{ui}</RouterProvider>
    </SessionProvider>
  );

  return Object.assign(result, { rpcCalls });
}
