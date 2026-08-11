// Data access for the CRM.
//
// Every function here is a narrow read or a named RPC. There is no query
// builder exposed to pages and no way to ask for an arbitrary table, so a page
// cannot widen its own access.
//
// Reads come back already filtered by row level security. Writes never touch a
// table directly: they go through the SECURITY DEFINER RPCs, which re-check the
// caller's role and write the audit trail in the same transaction.

import type {
  ActivityEntry,
  Artist,
  ArtistMembership,
  Client,
  CrmRole,
  CrmSession,
  EmailMessage,
  Enquiry,
  EnquiryFile,
  EnquiryStatus,
  FollowUp,
  InternalNote,
  OutboxJob,
  Profile,
  Project,
  ProjectFinance,
  SessionFinance,
  StatusTransition,
  StaffInviteRequest,
  StaffInviteResult,
} from './types';

/**
 * The slice of the Supabase client this application uses. Typing it this
 * narrowly is what lets the tests supply a plain object instead of a real
 * client, and stops a page reaching for something wider.
 */
export interface CrmClient {
  from: (table: string) => any;
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (path: string, expiresIn: number) => Promise<{ data: { signedUrl: string } | null; error: any }>;
    };
  };
  auth: {
    getSession: () => Promise<{ data: { session: any }; error: any }>;
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<{ data: any; error: any }>;
    updateUser: (attributes: { password: string }) => Promise<{ data: any; error: any }>;
    signOut: () => Promise<{ error: any }>;
    onAuthStateChange: (callback: (event: string, session: any) => void) => { data: { subscription: { unsubscribe: () => void } } };
  };
}

export class ApiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

function unwrap<T>(result: { data: T | null; error: any }, what: string): T {
  if (result.error) {
    // Supabase surfaces an RLS denial as an ordinary error. Showing its raw
    // text would leak schema detail to the screen, so it is replaced with
    // something a person can act on.
    throw new ApiError(friendlyMessage(result.error, what), result.error);
  }
  return (result.data ?? ([] as unknown)) as T;
}

export function friendlyMessage(error: any, what: string): string {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === '42501' || code === 'PGRST301') {
    return `You do not have permission to ${what}.`;
  }
  if (typeof error?.message === 'string' && error.message.includes('is not allowed')) {
    return error.message;
  }
  return `Could not ${what}. Please try again.`;
}

export interface ApiOptions {
  teamInviteUrl?: string;
  fetcher?: typeof fetch;
}

export function createApi(client: CrmClient, options: ApiOptions = {}) {
  const teamInviteUrl = options.teamInviteUrl ?? '';
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

  return {
    teamInviteConfigured: Boolean(teamInviteUrl),

    // ---- profile ----------------------------------------------------------
    async currentProfile(userId: string): Promise<Profile | null> {
      const result = await client
        .from('profiles')
        .select('id, email, display_name, role, is_active, created_at')
        .eq('id', userId)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load your profile'), result.error);
      return (result.data as Profile) ?? null;
    },

    async listAccessibleArtists(): Promise<Artist[]> {
      return unwrap<Artist[]>(
        await client.rpc('list_accessible_artists'),
        'list accessible artists'
      );
    },

    async listProfiles(): Promise<Profile[]> {
      return unwrap<Profile[]>(await client.rpc('list_profiles'), 'list staff profiles');
    },

    async listTeamMemberships(): Promise<ArtistMembership[]> {
      return unwrap<ArtistMembership[]>(
        await client.rpc('list_team_memberships'),
        'list team memberships'
      );
    },

    async inviteStaff(request: StaffInviteRequest): Promise<StaffInviteResult> {
      if (!teamInviteUrl) throw new ApiError('Staff invitations are not configured in this environment.');
      const session = await client.auth.getSession();
      const accessToken = session.data?.session?.access_token;
      if (!accessToken) throw new ApiError('Your session is no longer available. Sign in again.');

      let response: Response;
      try {
        response = await fetcher(teamInviteUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            idempotency_key: request.idempotency_key,
            email: request.email,
            display_name: request.display_name,
            role: request.role,
            memberships: request.memberships,
          }),
        });
      } catch {
        throw new ApiError('Could not reach the staff invitation service.');
      }

      let body: any = null;
      try {
        body = await response.json();
      } catch {
        // The invitation service never returns raw provider content. Treat any
        // non-JSON body as a generic failure rather than exposing it.
      }
      if (!response.ok) {
        const code = typeof body?.error === 'string' ? body.error : '';
        if (code === 'owner_access_required') throw new ApiError('Only an active owner can invite staff.');
        if (code === 'provisioning_pending') {
          throw new ApiError('The invitation was sent, but CRM access is still pending. Retry the same invitation.');
        }
        if (code === 'invite_not_completed') {
          throw new ApiError('The invitation could not be completed. Retry the same invitation.');
        }
        throw new ApiError('Could not invite that staff member.');
      }

      if (
        typeof body?.profile_id !== 'string'
        || !['booking_manager', 'read_only'].includes(body?.role)
        || body?.is_active !== true
        || typeof body?.idempotent_replay !== 'boolean'
        || !['sent', 'existing_account', 'not_repeated'].includes(body?.delivery)
      ) {
        throw new ApiError('The staff invitation service returned an invalid response.');
      }
      return body as StaffInviteResult;
    },

    async setProfileRole(profileId: string, role: CrmRole) {
      return unwrap<any>(await client.rpc('set_profile_role', { p_profile_id: profileId, p_role: role }), 'change that role');
    },

    async setProfileActive(profileId: string, active: boolean) {
      return unwrap<any>(await client.rpc('set_profile_active', { p_profile_id: profileId, p_is_active: active }), 'change that staff access');
    },

    async upsertArtistMembership(args: {
      profileId: string;
      artistId: string;
      accessLevel: ArtistMembership['access_level'];
      canViewFinance: boolean;
      canManageFinance: boolean;
      canManageSessions: boolean;
      canManageIntegrations: boolean;
      isActive: boolean;
    }) {
      return unwrap<any>(await client.rpc('upsert_artist_membership', {
        p_profile_id: args.profileId,
        p_artist_id: args.artistId,
        p_access_level: args.accessLevel,
        p_can_view_finance: args.canViewFinance,
        p_can_manage_finance: args.canManageFinance,
        p_can_manage_sessions: args.canManageSessions,
        p_can_manage_integrations: args.canManageIntegrations,
        p_is_active: args.isActive,
      }), 'change that artist access');
    },

    // ---- client/enquiry reads --------------------------------------------
    async listClients(): Promise<Client[]> {
      return unwrap<Client[]>(
        await client
          .from('clients')
          .select('id, full_name, email, phone, instagram, preferred_contact, travelling_from, notes_summary, created_at, updated_at, archived_at')
          .is('archived_at', null)
          .order('created_at', { ascending: false }),
        'load clients'
      );
    },

    async getClient(id: string): Promise<Client | null> {
      const result = await client
        .from('clients')
        .select('id, full_name, email, phone, instagram, preferred_contact, travelling_from, notes_summary, created_at, updated_at, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load that client'), result.error);
      return (result.data as Client) ?? null;
    },

    async listEnquiries(filters?: { status?: EnquiryStatus; search?: string; artistId?: string }): Promise<Enquiry[]> {
      let query = client
        .from('enquiries')
        .select('id, artist_id, client_id, reference_number, status, intake_state, intake_error_code, client_identifier_conflict, assigned_to, submitted_full_name, submitted_email, submitted_phone, submitted_instagram, submitted_preferred_contact, submitted_travelling_from, project_type, placement, approximate_size, cover_up, preferred_timing, idea, source, utm_source, created_at, last_action_at, archived_at')
        .is('archived_at', null)
        .order('last_action_at', { ascending: false });

      if (filters?.artistId) query = query.eq('artist_id', filters.artistId);
      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.search) query = query.ilike('reference_number', `%${filters.search}%`);
      return unwrap<Enquiry[]>(await query, 'load enquiries');
    },

    async getEnquiry(id: string): Promise<Enquiry | null> {
      const result = await client
        .from('enquiries')
        .select('id, artist_id, client_id, reference_number, status, intake_state, intake_error_code, client_identifier_conflict, assigned_to, submitted_full_name, submitted_email, submitted_phone, submitted_instagram, submitted_preferred_contact, submitted_travelling_from, project_type, placement, approximate_size, cover_up, preferred_timing, idea, source, utm_source, created_at, last_action_at, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load that enquiry'), result.error);
      return (result.data as Enquiry) ?? null;
    },

    async listEnquiryFiles(enquiryId: string): Promise<EnquiryFile[]> {
      return unwrap<EnquiryFile[]>(
        await client
          .from('enquiry_files')
          .select('id, enquiry_id, ordinal, storage_path, original_filename, mime_type, byte_size, upload_state, created_at')
          .eq('enquiry_id', enquiryId)
          .order('ordinal', { ascending: true }),
        'load enquiry files'
      );
    },

    async signedFileUrl(path: string): Promise<string> {
      const result = await client.storage.from('crm-files').createSignedUrl(path, 60);
      if (result.error || !result.data?.signedUrl) {
        throw new ApiError('Could not open that private file.');
      }
      return result.data.signedUrl;
    },

    // ---- workflow writes --------------------------------------------------
    async transitionEnquiry(enquiryId: string, toStatus: EnquiryStatus) {
      return unwrap<any>(
        await client.rpc('transition_enquiry_status', { p_enquiry_id: enquiryId, p_to_status: toStatus }),
        'change that enquiry'
      );
    },

    async assignEnquiry(enquiryId: string, profileId: string | null) {
      return unwrap<any>(
        await client.rpc('assign_enquiry', { p_enquiry_id: enquiryId, p_profile_id: profileId }),
        'assign that enquiry'
      );
    },

    async convertEnquiry(enquiryId: string, title: string, description?: string) {
      return unwrap<any>(
        await client.rpc('convert_enquiry_to_project', {
          p_enquiry_id: enquiryId,
          p_title: title,
          p_description: description ?? null,
        }),
        'convert that enquiry'
      );
    },

    async createNote(args: { body: string; clientId?: string; enquiryId?: string; projectId?: string; sessionId?: string }) {
      return unwrap<any>(await client.rpc('create_internal_note', {
        p_body: args.body,
        p_client_id: args.clientId ?? null,
        p_enquiry_id: args.enquiryId ?? null,
        p_project_id: args.projectId ?? null,
        p_session_id: args.sessionId ?? null,
      }), 'save that note');
    },

    async createFollowUp(args: { subject: string; dueAt: string; clientId?: string; enquiryId?: string; projectId?: string; assignedTo?: string; details?: string }) {
      return unwrap<any>(await client.rpc('create_follow_up', {
        p_subject: args.subject,
        p_due_at: args.dueAt,
        p_client_id: args.clientId ?? null,
        p_enquiry_id: args.enquiryId ?? null,
        p_project_id: args.projectId ?? null,
        p_assigned_to: args.assignedTo ?? null,
        p_details: args.details ?? null,
      }), 'create that follow-up');
    },

    async completeFollowUp(id: string) {
      return unwrap<any>(await client.rpc('complete_follow_up', { p_follow_up_id: id }), 'complete that follow-up');
    },

    async createEmailDraft(args: { to: string; subject: string; body: string; clientId?: string; enquiryId?: string; projectId?: string; provider?: string }) {
      return unwrap<any>(await client.rpc('create_email_draft', {
        p_to: args.to,
        p_subject: args.subject,
        p_body: args.body,
        p_client_id: args.clientId ?? null,
        p_enquiry_id: args.enquiryId ?? null,
        p_project_id: args.projectId ?? null,
        p_provider: args.provider ?? 'none',
      }), 'create that email draft');
    },

    async approveEmailDraft(messageId: string) {
      return unwrap<any>(await client.rpc('approve_email_draft', { p_message_id: messageId }), 'approve that email');
    },

    // ---- project/session reads -------------------------------------------
    async listProjects(status?: string, artistId?: string): Promise<Project[]> {
      let query = client
        .from('projects')
        .select('id, artist_id, client_id, enquiry_id, status, title, description, estimated_sessions, estimated_hours, deposit_status, currency, created_at, updated_at, archived_at')
        .is('archived_at', null)
        .order('updated_at', { ascending: false });
      if (status) query = query.eq('status', status);
      if (artistId) query = query.eq('artist_id', artistId);
      return unwrap<Project[]>(await query, 'load projects');
    },

    async getProject(id: string): Promise<Project | null> {
      const result = await client
        .from('projects')
        .select('id, artist_id, client_id, enquiry_id, status, title, description, estimated_sessions, estimated_hours, deposit_status, currency, created_at, updated_at, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load that project'), result.error);
      return (result.data as Project) ?? null;
    },

    async projectFinance(id: string): Promise<ProjectFinance | null> {
      const result = await client
        .from('projects_finance')
        .select('project_id, artist_id, client_id, currency, hourly_rate, estimate_total, deposit_amount, deposit_status')
        .eq('project_id', id)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load project finance'), result.error);
      return (result.data as ProjectFinance) ?? null;
    },

    async sessionFinance(id: string): Promise<SessionFinance | null> {
      const result = await client
        .from('sessions_finance')
        .select('session_id, artist_id, project_id, currency, price, payment_status')
        .eq('session_id', id)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load session finance'), result.error);
      return (result.data as SessionFinance) ?? null;
    },

    async listSessions(projectId?: string, artistId?: string): Promise<CrmSession[]> {
      let query = client
        .from('sessions')
        .select('id, artist_id, project_id, status, start_at, end_at, duration_hours, currency, payment_status, calendar_provider, calendar_event_id, calendar_version, notes, cancelled_at')
        .order('start_at', { ascending: true });
      if (projectId) query = query.eq('project_id', projectId);
      if (artistId) query = query.eq('artist_id', artistId);
      return unwrap<CrmSession[]>(await query, 'load sessions');
    },

    // ---- operational/admin reads -----------------------------------------
    async listActivity(limit = 100, artistId?: string): Promise<ActivityEntry[]> {
      let query = client
        .from('activity_log')
        .select('id, artist_id, occurred_at, event_type, actor_kind, actor_profile_id, client_id, enquiry_id, project_id, session_id, metadata')
        .order('occurred_at', { ascending: false })
        .limit(limit);
      if (artistId) query = query.eq('artist_id', artistId);
      return unwrap<ActivityEntry[]>(await query, 'load activity');
    },

    async listOutbox(): Promise<OutboxJob[]> {
      return unwrap<OutboxJob[]>(
        await client
          .from('integration_outbox')
          .select('id, artist_id, kind, status, attempt_count, max_attempts, next_attempt_at, last_error_code, updated_at')
          .order('updated_at', { ascending: false }),
        'load integration jobs'
      );
    },
  };
}

export type Api = ReturnType<typeof createApi>;
