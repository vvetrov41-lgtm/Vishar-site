// Data access for the CRM.
//
// Every function here is a narrow read or a named RPC. There is no query
// builder exposed to pages and no way to ask for an arbitrary table, so a page
// cannot widen its own access.
//
// Reads come back already filtered by row level security. Writes never touch a
// table directly: they go through the SECURITY DEFINER RPCs, which re-check the
// caller's role and write the audit trail in the same transaction.

import {
  describeApiFailure,
  translateApiMessage,
  type ApiMessage,
  type ApiOperation,
} from './api-errors';

export type { ApiMessage, ApiOperation };

/**
 * A failure a module states in its own words, in the operator's language.
 * `message` is typed as ApiMessage, so a new English-only sentence in any API
 * module fails to compile until it is translated.
 */
export function apiMessage(message: ApiMessage): string {
  return translateApiMessage(message, currentLanguage());
}
import { currentLanguage } from './i18n';
import { phoneSearchCandidates } from './phone';
import type {
  ActivityEntry,
  Artist,
  ArtistMembership,
  Client,
  CrmRole,
  CrmSession,
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
  TeammateInviteRequest,
  TeammateInviteResult,
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
    signOut: () => Promise<{ error: any }>;
    onAuthStateChange: (callback: (event: string, session: any) => void) => { data: { subscription: { unsubscribe: () => void } } };
    // Public signup. Optional so the many test doubles in this repository stay
    // valid CrmClients: a build without these simply cannot offer signup, which
    // is the correct fail-closed behaviour rather than a compile error.
    signUp?: (credentials: {
      email: string;
      password: string;
      options?: { emailRedirectTo?: string; captchaToken?: string };
    }) => Promise<{ data: any; error: any }>;
    resend?: (payload: {
      type: 'signup';
      email: string;
      options?: { emailRedirectTo?: string; captchaToken?: string };
    }) => Promise<{ data: any; error: any }>;
  };
}

export class ApiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

function unwrap<T>(result: { data: T | null; error: any }, what: ApiOperation): T {
  if (result.error) {
    // Supabase surfaces an RLS denial as an ordinary error. Showing its raw
    // text would leak schema detail to the screen, so it is replaced with
    // something a person can act on.
    throw new ApiError(friendlyMessage(result.error, what), result.error);
  }
  return (result.data ?? ([] as unknown)) as T;
}

/**
 * PostgREST parses `or=(...)` as a comma-separated list, so a term containing
 * the grammar's own punctuation would change the shape of the filter rather
 * than be searched for. Those characters are dropped: none of them appear in a
 * name, address, handle or phone number worth searching by.
 */
function postgrestPattern(term: string): string {
  return term.replace(/[,()"\\]/g, '').trim();
}

/**
 * The sentence shown when an operation fails, in the operator's own language.
 *
 * `what` is typed as `ApiOperation`, so a new call site cannot introduce an
 * English-only message: the phrase has to be added to `API_OPERATIONS` with
 * its Russian translation before this compiles.
 */
export function friendlyMessage(error: unknown, what: ApiOperation): string {
  return describeApiFailure(error, what, currentLanguage());
}

export interface ApiOptions {
  teamInviteUrl?: string;
  fetcher?: typeof fetch;
}

export function createApi(client: CrmClient, options: ApiOptions = {}) {
  const teamInviteUrl = options.teamInviteUrl ?? '';
  // The tenant-scoped sibling of the owner endpoint. Derived rather than
  // configured: `readTeamInviteUrl` already pinned the origin and the path, so
  // swapping the last segment cannot reach a host that was not permitted, and
  // there is no second environment variable to get wrong.
  const artistInviteUrl = teamInviteUrl
    ? teamInviteUrl.replace(/\/v1\/staff\/invite$/, '/v1/artist/invite')
    : '';
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

  /**
   * Clients matching a free-text term across every stored identifier.
   * Shared by client search and enquiry search rather than reached through
   * `this`, whose binding depends on how the caller obtained the method.
   */
  async function searchClients(term: string): Promise<Client[]> {
    const pattern = `*${postgrestPattern(term)}*`;
    const conditions = [
      `full_name.ilike.${pattern}`,
      `email.ilike.${pattern}`,
      `instagram.ilike.${pattern}`,
      `phone.ilike.${pattern}`,
      ...phoneSearchCandidates(term).map(
        (candidate) => `phone.ilike.*${postgrestPattern(candidate)}*`
      ),
    ];
    return unwrap<Client[]>(
      await client
        .from('clients')
        .select('id, full_name, email, phone, instagram, preferred_contact, travelling_from, notes_summary, created_at, updated_at, archived_at')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(200)
        .or(conditions.join(',')),
      'load clients'
    );
  }

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
      return unwrap<Profile[]>(await client.rpc('list_profiles'), 'list staff');
    },

    async listTeamMemberships(): Promise<ArtistMembership[]> {
      return unwrap<ArtistMembership[]>(
        await client.rpc('list_team_memberships'),
        'list team artist access'
      );
    },

    async listAssignableProfiles(): Promise<Pick<Profile, 'id' | 'display_name' | 'role'>[]> {
      return unwrap(await client.rpc('list_assignable_profiles'), 'list colleagues');
    },

    async setProfileRole(profileId: string, role: CrmRole) {
      return unwrap(await client.rpc('set_profile_role', { p_profile_id: profileId, p_role: role }), 'change that role');
    },

    async setProfileActive(profileId: string, isActive: boolean) {
      return unwrap(
        await client.rpc('set_profile_active', { p_profile_id: profileId, p_is_active: isActive }),
        isActive ? 'activate that account' : 'deactivate that account'
      );
    },

    async upsertArtistMembership(membership: ArtistMembership) {
      return unwrap(
        await client.rpc('upsert_artist_membership', {
          p_profile_id: membership.profile_id,
          p_artist_id: membership.artist_id,
          p_access_level: membership.access_level,
          p_can_view_finance: membership.can_view_finance,
          p_can_manage_finance: membership.can_manage_finance,
          p_can_manage_sessions: membership.can_manage_sessions,
          p_can_manage_integrations: membership.can_manage_integrations,
          p_is_active: membership.is_active,
        }),
        'change artist access'
      );
    },

    async inviteStaff(invite: StaffInviteRequest): Promise<StaffInviteResult> {
      if (!teamInviteUrl) throw new ApiError(apiMessage('Staff invitations are not configured.'));
      const session = await client.auth.getSession();
      const accessToken = session.data?.session?.access_token;
      if (session.error || typeof accessToken !== 'string' || !accessToken) {
        throw new ApiError(apiMessage('Your session has expired. Sign in again.'));
      }

      let response: Response;
      try {
        response = await fetcher(teamInviteUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(invite),
        });
      } catch (cause) {
        throw new ApiError(apiMessage('Could not reach the staff invitation service.'), cause);
      }

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        // A trusted boundary still has to return the documented safe shape.
      }

      if (!response.ok) {
        const safeMessages: Record<string, string> = {
          owner_access_required: 'You do not have permission to invite staff.',
          invalid_email: 'Enter a valid email address.',
          invalid_role: 'Choose a permitted staff role.',
          invalid_membership: 'Review the artist access settings.',
          invalid_memberships: 'Choose at least one artist.',
          provisioning_pending: 'The invitation was sent, but access is still pending. Retry with the same form.',
          invite_not_completed: 'The invitation could not be completed. Retry with the same form.',
          team_admin_not_configured: 'Staff invitations are not configured.',
        };
        const code = typeof payload?.error === 'string' ? payload.error : '';
        throw new ApiError(safeMessages[code] ?? 'Could not invite that person. Please try again.');
      }

      if (
        typeof payload?.profile_id !== 'string'
        || !['booking_manager', 'read_only'].includes(payload?.role)
        || payload?.is_active !== true
        || typeof payload?.idempotent_replay !== 'boolean'
        || !['sent', 'existing_account', 'not_repeated'].includes(payload?.delivery)
      ) {
        throw new ApiError(apiMessage('The staff invitation service returned an invalid response.'));
      }

      return {
        profile_id: payload.profile_id,
        role: payload.role,
        is_active: true,
        idempotent_replay: payload.idempotent_replay,
        delivery: payload.delivery,
      } as StaffInviteResult;
    },

    async tenantInvitePolicy(artistId: string): Promise<{ can_invite: boolean }> {
      const result = await client.rpc('tenant_invite_policy', { p_artist_id: artistId });
      if (result.error) return { can_invite: false };
      return { can_invite: (result.data as any)?.can_invite === true };
    },

    async inviteTeammate(invite: TeammateInviteRequest): Promise<TeammateInviteResult> {
      if (!artistInviteUrl) throw new ApiError(apiMessage('Staff invitations are not configured.'));
      const session = await client.auth.getSession();
      const accessToken = session.data?.session?.access_token;
      if (session.error || typeof accessToken !== 'string' || !accessToken) {
        throw new ApiError(apiMessage('Your session has expired. Sign in again.'));
      }

      let response: Response;
      try {
        response = await fetcher(artistInviteUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(invite),
        });
      } catch (cause) {
        throw new ApiError(apiMessage('Could not reach the staff invitation service.'), cause);
      }

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        // A trusted boundary still has to return the documented safe shape.
      }

      if (!response.ok) {
        const safeMessages: Record<string, string> = {
          owner_access_required: 'You do not have permission to invite people to this artist.',
          invalid_email: 'Enter a valid email address.',
          invalid_grant: 'Review the access settings for this invitation.',
          invalid_artist: 'Choose an artist you manage.',
          provisioning_pending: 'The invitation was sent, but access is still pending. Retry with the same form.',
          invite_not_completed: 'The invitation could not be completed. Retry with the same form.',
          team_admin_not_configured: 'Staff invitations are not configured.',
        };
        const code = typeof payload?.error === 'string' ? payload.error : '';
        throw new ApiError(safeMessages[code] ?? 'Could not send that invitation. Please try again.');
      }

      if (payload?.delivery !== 'sent' || typeof payload?.idempotent_replay !== 'boolean') {
        throw new ApiError(apiMessage('The staff invitation service returned an invalid response.'));
      }

      return { delivery: 'sent', idempotent_replay: payload.idempotent_replay };
    },

    // ---- enquiries --------------------------------------------------------
    async listEnquiries(filters: {
      status?: EnquiryStatus;
      assignedTo?: string;
      clientId?: string;
      search?: string;
      artistId?: string;
    } = {}): Promise<Enquiry[]> {
      let query = client
        .from('enquiries')
        .select('id, artist_id, client_id, reference_number, status, intake_state, intake_error_code, client_identifier_conflict, assigned_to, project_type, placement, approximate_size, cover_up, preferred_timing, idea, source, utm_source, created_at, last_action_at, archived_at')
        .is('archived_at', null)
        // Only completed intakes belong in the working queue. The database
        // keeps incomplete rows for reconciliation, but staff must not start
        // working them as if every promised file had arrived.
        .eq('intake_state', 'complete')
        .order('last_action_at', { ascending: false })
        .limit(200);

      if (filters.status) query = query.eq('status', filters.status);
      if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo);
      if (filters.clientId) query = query.eq('client_id', filters.clientId);
      // A reference number is the one identifier the operator does not have to
      // hand. Matching the client as well means "Anna's enquiry" is findable by
      // typing Anna. Client ids are resolved first because PostgREST cannot
      // express the join inside a single `or` filter.
      if (filters.search) {
        const pattern = postgrestPattern(filters.search);
        const conditions = [`reference_number.ilike.*${pattern}*`];
        const matchedClientIds = filters.clientId
          ? []
          : (await searchClients(filters.search)).map((entry) => entry.id);
        if (matchedClientIds.length > 0) {
          conditions.push(`client_id.in.(${matchedClientIds.join(',')})`);
        }
        query = query.or(conditions.join(','));
      }
      if (filters.artistId) query = query.eq('artist_id', filters.artistId);

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
        'load reference images'
      );
    },

    async listStatusTransitions(): Promise<StatusTransition[]> {
      return unwrap<StatusTransition[]>(
        await client.from('enquiry_status_transitions').select('from_status, to_status, owner_only, note'),
        'load the allowed status changes'
      );
    },

    async transitionEnquiry(enquiryId: string, to: EnquiryStatus) {
      return unwrap(
        await client.rpc('transition_enquiry_status', { p_enquiry_id: enquiryId, p_to_status: to }),
        'change that status'
      );
    },

    async assignEnquiry(enquiryId: string, profileId: string | null) {
      return unwrap(
        await client.rpc('assign_enquiry', { p_enquiry_id: enquiryId, p_profile_id: profileId }),
        'assign that enquiry'
      );
    },

    async convertEnquiry(enquiryId: string, title: string, description?: string) {
      return unwrap(
        await client.rpc('convert_enquiry_to_project', {
          p_enquiry_id: enquiryId,
          p_title: title,
          p_description: description ?? null,
        }),
        'convert that enquiry'
      );
    },

    // ---- clients ----------------------------------------------------------
    /**
     * Client search across every identifier a message can arrive with.
     *
     * Matching only `full_name` meant a WhatsApp message from a number, an
     * email address or an Instagram handle could not be traced back to the
     * person, even though all four values are already stored on the row and
     * already selected below. Phone numbers additionally reach the CRM in
     * several forms, so a term is expanded into the digit forms it could have
     * been saved as. Row level security still decides which rows come back.
     */
    async listClients(search?: string): Promise<Client[]> {
      let query = client
        .from('clients')
        .select('id, full_name, email, phone, instagram, preferred_contact, travelling_from, notes_summary, created_at, updated_at, archived_at')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(200);

      const term = (search ?? '').trim();
      if (term) return searchClients(term);

      return unwrap<Client[]>(await query, 'load clients');
    },

    /**
     * Names for a known set of client ids.
     *
     * Screens that list appointments, payments or reconciliation rows hold a
     * client_id but must show a person. Reusing listClients() would cap the
     * lookup at the 200 most recent clients and silently fail to name an older
     * one, so the ids are asked for directly. Row level security still decides
     * which of them come back.
     */
    async listClientsByIds(ids: string[]): Promise<Client[]> {
      const unique = [...new Set(ids.filter(Boolean))];
      if (unique.length === 0) return [];
      return unwrap<Client[]>(
        await client
          .from('clients')
          .select('id, full_name, email, phone, instagram, preferred_contact, travelling_from, notes_summary, created_at, updated_at, archived_at')
          .in('id', unique),
        'load client names'
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

    // ---- projects and sessions -------------------------------------------
    async listProjects(clientId?: string, artistId?: string): Promise<Project[]> {
      let query = client
        .from('projects')
        .select('id, artist_id, client_id, enquiry_id, status, title, description, estimated_sessions, estimated_hours, deposit_status, currency, created_at, updated_at, archived_at')
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        .limit(200);
      if (clientId) query = query.eq('client_id', clientId);
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

    /** Owner only. Any other role receives an empty list from the view itself. */
    async getProjectFinance(projectId: string): Promise<ProjectFinance | null> {
      const result = await client
        .from('projects_finance')
        .select('project_id, artist_id, client_id, currency, hourly_rate, estimate_total, deposit_amount, deposit_status')
        .eq('project_id', projectId)
        .maybeSingle();
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load project finance'), result.error);
      }
      return (result.data as ProjectFinance) ?? null;
    },

    async listSessions(projectId?: string, artistId?: string): Promise<CrmSession[]> {
      let query = client
        .from('sessions')
        .select('id, artist_id, client_id, project_id, status, start_at, end_at, duration_hours, currency, payment_status, calendar_provider, calendar_event_id, calendar_version, notes, cancelled_at')
        .order('start_at', { ascending: true })
        .limit(200);
      if (projectId) query = query.eq('project_id', projectId);
      if (artistId) query = query.eq('artist_id', artistId);
      return unwrap<CrmSession[]>(await query, 'load sessions');
    },

    async listSessionFinance(projectId: string): Promise<SessionFinance[]> {
      return unwrap<SessionFinance[]>(
        await client
          .from('sessions_finance')
          .select('session_id, artist_id, project_id, currency, price, payment_status')
          .eq('project_id', projectId),
        'load session finance'
      );
    },

    async scheduleSession(projectId: string, startAt: string, endAt: string, status: CrmSession['status']) {
      return unwrap(
        await client.rpc('schedule_session', {
          p_project_id: projectId,
          p_start_at: startAt,
          p_end_at: endAt,
          p_status: status,
        }),
        'schedule that session'
      );
    },

    async setSessionStatus(sessionId: string, status: CrmSession['status']) {
      return unwrap(
        await client.rpc('set_session_status', { p_session_id: sessionId, p_status: status }),
        'change that session'
      );
    },

    async updateDeposit(projectId: string, amount: number, status: Project['deposit_status']) {
      return unwrap(
        await client.rpc('update_project_deposit', {
          p_project_id: projectId,
          p_deposit_amount: amount,
          p_deposit_status: status,
        }),
        'update the deposit'
      );
    },

    // ---- notes, follow-ups, email ----------------------------------------
    async listNotes(filter: { enquiryId?: string; clientId?: string; projectId?: string }): Promise<InternalNote[]> {
      let query = client
        .from('internal_notes')
        .select('id, author_profile_id, body, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (filter.enquiryId) query = query.eq('enquiry_id', filter.enquiryId);
      if (filter.clientId) query = query.eq('client_id', filter.clientId);
      if (filter.projectId) query = query.eq('project_id', filter.projectId);
      return unwrap<InternalNote[]>(await query, 'load notes');
    },

    async createNote(body: string, entity: { enquiryId?: string; clientId?: string; projectId?: string }) {
      return unwrap(
        await client.rpc('create_internal_note', {
          p_body: body,
          p_client_id: entity.clientId ?? null,
          p_enquiry_id: entity.enquiryId ?? null,
          p_project_id: entity.projectId ?? null,
        }),
        'save that note'
      );
    },

    async listFollowUps(filter: { enquiryId?: string; clientId?: string; open?: boolean; artistId?: string } = {}): Promise<FollowUp[]> {
      let query = client
        .from('follow_ups')
        .select('id, artist_id, status, due_at, subject, details, client_id, enquiry_id, project_id, assigned_to')
        .order('due_at', { ascending: true })
        .limit(100);
      if (filter.enquiryId) query = query.eq('enquiry_id', filter.enquiryId);
      if (filter.clientId) query = query.eq('client_id', filter.clientId);
      if (filter.open) query = query.eq('status', 'open');
      if (filter.artistId) query = query.eq('artist_id', filter.artistId);
      return unwrap<FollowUp[]>(await query, 'load follow-ups');
    },

    async createFollowUp(subject: string, dueAt: string, entity: { enquiryId?: string; clientId?: string; projectId?: string }) {
      return unwrap(
        await client.rpc('create_follow_up', {
          p_subject: subject,
          p_due_at: dueAt,
          p_client_id: entity.clientId ?? null,
          p_enquiry_id: entity.enquiryId ?? null,
          p_project_id: entity.projectId ?? null,
        }),
        'create that follow-up'
      );
    },

    async completeFollowUp(id: string) {
      return unwrap(await client.rpc('complete_follow_up', { p_follow_up_id: id }), 'complete that follow-up');
    },

    // ---- WhatsApp conversations -------------------------------------------
    async getWhatsAppConversationForClient(clientId: string, artistId: string) {
      const result = await client
        .from('whatsapp_conversations')
        .select('id, artist_id, client_id, integration_key, contact_wa_id, last_message_at')
        .eq('client_id', clientId)
        .eq('artist_id', artistId)
        .maybeSingle();
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load the WhatsApp conversation'), result.error);
      }
      return result.data ?? null;
    },

    async listWhatsAppMessages(conversationId: string) {
      return unwrap<any[]>(
        await client
          .from('whatsapp_messages')
          .select('id, direction, origin, status, message_type, body, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })
          .limit(200),
        'load WhatsApp messages'
      );
    },

    async ensureWhatsAppConversationForEnquiry(enquiryId: string) {
      return unwrap(
        await client.rpc('ensure_whatsapp_conversation_for_enquiry', { p_enquiry_id: enquiryId }),
        'connect that WhatsApp conversation'
      );
    },

    async queueWhatsAppMessage(conversationId: string, body: string, requestId: string) {
      return unwrap(
        await client.rpc('queue_whatsapp_message', {
          p_conversation_id: conversationId,
          p_body: body,
          p_request_id: requestId,
        }),
        'queue that WhatsApp message'
      );
    },

    // ---- activity and integration jobs ------------------------------------
    async listActivity(filter: {
      enquiryId?: string;
      clientId?: string;
      projectId?: string;
      sessionId?: string;
      eventType?: string;
      artistId?: string;
    } = {}): Promise<ActivityEntry[]> {
      let query = client
        .from('activity_log')
        .select('id, artist_id, occurred_at, event_type, actor_kind, actor_profile_id, client_id, enquiry_id, project_id, session_id, metadata')
        .order('occurred_at', { ascending: false })
        .limit(200);
      if (filter.enquiryId) query = query.eq('enquiry_id', filter.enquiryId);
      if (filter.clientId) query = query.eq('client_id', filter.clientId);
      if (filter.projectId) query = query.eq('project_id', filter.projectId);
      if (filter.sessionId) query = query.eq('session_id', filter.sessionId);
      if (filter.eventType) query = query.eq('event_type', filter.eventType);
      if (filter.artistId) query = query.eq('artist_id', filter.artistId);
      return unwrap<ActivityEntry[]>(await query, 'load the activity log');
    },

    async listFailedJobs(artistId?: string): Promise<OutboxJob[]> {
      let query = client
        .from('integration_outbox')
        .select('id, artist_id, kind, status, attempt_count, max_attempts, next_attempt_at, last_error_code, updated_at')
        .in('status', ['failed', 'dead'])
        .order('updated_at', { ascending: false })
        .limit(50);
      if (artistId) query = query.eq('artist_id', artistId);
      return unwrap<OutboxJob[]>(await query, 'load failed integration jobs');
    },

    // ---- files -------------------------------------------------------------
    /**
     * Mints a signed URL for one object, valid for one minute. The URL is never
     * stored and never logged; the screen re-mints as it renders.
     */
    async signedFileUrl(storagePath: string): Promise<string | null> {
      const result = await client.storage.from('crm-files').createSignedUrl(storagePath, 60);
      if (result.error || !result.data) return null;
      return result.data.signedUrl;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
