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
import type { CrmRole, EnquiryStatus } from '../lib/types';

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
  project_id: PROJECT_ID,
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
  teamInviteUrl?: string;
}

const DENIED = { code: '42501', message: 'permission denied' };

/**
 * A query builder that behaves like PostgREST's chainable API and resolves to
 * the rows the corresponding role would actually be able to read.
 */
function tableResult(
  table: string,
  role: CrmRole | null,
  failTable?: string,
  enquiryStatus?: EnquiryStatus
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
      return { data: [SESSION], error: null };
    case 'sessions_finance':
      return { data: role === 'owner' ? [{ session_id: SESSION_ID, artist_id: VLADIMIR_ARTIST_ID, project_id: PROJECT_ID, currency: 'GBP', price: 840, payment_status: 'unpaid' }] : [], error: null };
    case 'internal_notes':
      return { data: canManage ? [{ id: 'note-1', author_profile_id: OWNER_ID, body: 'Internal note', created_at: '2026-07-02T09:00:00Z' }] : [], error: null };
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

  function builder(table: string): any {
    const result = tableResult(table, effectiveRole, options.failTable, options.enquiryStatus);
    const chain: any = {
      select: () => chain,
      eq: (...args: unknown[]) => {
        queryCalls.push({ table, method: 'eq', args });
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
      order: () => chain,
      limit: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
          error: result.error,
        }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  }

  return {
    from: builder,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });

      // Role checks live in the database. The fake enforces the same ones, so a
      // component test cannot "pass" by calling something the real RPC refuses.
      const ownerOnly = ['list_profiles', 'list_team_memberships', 'set_profile_role', 'set_profile_active', 'upsert_artist_membership', 'approve_email_draft', 'update_project_deposit', 'update_project_estimate', 'update_retention_policy'];
      const managerOrOwner = ['transition_enquiry_status', 'assign_enquiry', 'convert_enquiry_to_project', 'schedule_session', 'set_session_status', 'create_internal_note', 'create_follow_up', 'complete_follow_up', 'create_email_draft', 'list_assignable_profiles'];

      if (ownerOnly.includes(name) && effectiveRole !== 'owner') return { data: null, error: DENIED };
      if (managerOrOwner.includes(name) && effectiveRole !== 'owner' && effectiveRole !== 'booking_manager') {
        return { data: null, error: DENIED };
      }

      if (name === 'list_accessible_artists') {
        return { data: ARTISTS.filter((artist) => accessibleArtistIds.includes(artist.id)), error: null };
      }
      if (name === 'list_profiles') return { data: Object.values(PROFILES), error: null };
      if (name === 'list_team_memberships') return { data: MEMBERSHIPS, error: null };
      if (name === 'list_assignable_profiles') {
        return { data: [PROFILES.owner, PROFILES.booking_manager].map((p) => ({ id: p.id, display_name: p.display_name, role: p.role })), error: null };
      }
      if (name === 'convert_enquiry_to_project') return { data: { project_id: PROJECT_ID }, error: null };
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
