// Domain types mirroring the CRM schema.
//
// These describe what the database returns to an authenticated CRM session.
// Note what is missing: `projects.hourly_rate`, `projects.estimate_total`,
// `projects.deposit_amount` and `sessions.price` are not on the base row types,
// because those columns are not granted to the `authenticated` role at all.
// Finance figures arrive only through ProjectFinance / SessionFinance, which
// return rows exclusively to the owner.

export type CrmRole = 'owner' | 'booking_manager' | 'read_only';
export type ArtistAccessLevel = 'owner' | 'artist' | 'manager' | 'read_only';

export interface Artist {
  id: string;
  slug: string;
  display_name: string;
  timezone: string;
  default_currency: string;
  is_active: boolean;
}

export type EnquiryStatus =
  | 'new'
  | 'reviewing'
  | 'waiting_for_client'
  | 'accepted'
  | 'declined'
  | 'quote_sent'
  | 'deposit_requested'
  | 'deposit_paid'
  | 'converted'
  | 'closed';

export type EnquiryIntakeState = 'pending' | 'files_pending' | 'complete' | 'failed';
export type UploadState = 'pending' | 'uploading' | 'ready' | 'failed';
export type ProjectStatus = 'draft' | 'active' | 'on_hold' | 'completed' | 'cancelled';
export type DepositStatus = 'not_required' | 'requested' | 'paid' | 'refunded' | 'forfeited';
export type SessionStatus = 'draft' | 'proposed' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type PaymentStatus = 'unpaid' | 'deposit_paid' | 'part_paid' | 'paid' | 'refunded';
export type CalendarProvider = 'none' | 'google';
export type FollowUpStatus = 'open' | 'done' | 'cancelled';
export type EmailStatus = 'draft' | 'approved' | 'queued' | 'sent' | 'failed' | 'cancelled';
export type OutboxStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'dead';

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: CrmRole;
  is_active: boolean;
  created_at: string;
}

export interface ArtistMembership {
  profile_id: string;
  artist_id: string;
  access_level: ArtistAccessLevel;
  can_view_finance: boolean;
  can_manage_finance: boolean;
  can_manage_sessions: boolean;
  can_manage_integrations: boolean;
  is_active: boolean;
}

export interface StaffInviteMembership {
  artist_id: string;
  access_level: Exclude<ArtistAccessLevel, 'owner'>;
  can_view_finance: boolean;
  can_manage_finance: boolean;
  can_manage_sessions: boolean;
  can_manage_integrations: boolean;
}

export interface StaffInviteRequest {
  idempotency_key: string;
  email: string;
  display_name: string | null;
  role: Exclude<CrmRole, 'owner'>;
  memberships: StaffInviteMembership[];
}

export interface StaffInviteResult {
  profile_id: string;
  role: Exclude<CrmRole, 'owner'>;
  is_active: true;
  idempotent_replay: boolean;
  delivery: 'sent' | 'existing_account' | 'not_repeated';
}

export interface Client {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  preferred_contact: string | null;
  travelling_from: string | null;
  notes_summary: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Enquiry {
  id: string;
  artist_id: string;
  client_id: string;
  reference_number: string;
  status: EnquiryStatus;
  intake_state: EnquiryIntakeState;
  intake_error_code: string | null;
  client_identifier_conflict: boolean;
  assigned_to: string | null;
  /** Present on detail reads; list reads deliberately omit contact PII. */
  submitted_full_name?: string;
  submitted_email?: string;
  submitted_phone?: string | null;
  submitted_instagram?: string | null;
  submitted_preferred_contact?: string | null;
  submitted_travelling_from?: string | null;
  project_type: string | null;
  placement: string | null;
  approximate_size: string | null;
  cover_up: string | null;
  preferred_timing: string | null;
  idea: string | null;
  source: string | null;
  utm_source: string | null;
  created_at: string;
  last_action_at: string;
  archived_at: string | null;
}

export interface EnquiryFile {
  id: string;
  enquiry_id: string;
  ordinal: number;
  storage_path: string;
  original_filename: string | null;
  mime_type: string;
  byte_size: number;
  upload_state: UploadState;
  created_at: string;
}

/** Operational columns only. Finance lives in ProjectFinance. */
export interface Project {
  id: string;
  artist_id: string;
  client_id: string;
  enquiry_id: string | null;
  status: ProjectStatus;
  title: string;
  description: string | null;
  estimated_sessions: number | null;
  estimated_hours: number | null;
  deposit_status: DepositStatus;
  currency: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectFinance {
  project_id: string;
  artist_id: string;
  client_id: string;
  currency: string;
  hourly_rate: number | null;
  estimate_total: number | null;
  deposit_amount: number | null;
  deposit_status: DepositStatus;
}

/** Operational columns only. `price` lives in SessionFinance. */
export interface CrmSession {
  id: string;
  artist_id: string;
  client_id: string;
  project_id: string;
  status: SessionStatus;
  start_at: string;
  end_at: string;
  duration_hours: number | null;
  currency: string;
  payment_status: PaymentStatus;
  calendar_provider: CalendarProvider;
  calendar_event_id: string | null;
  calendar_version: number;
  notes: string | null;
  cancelled_at: string | null;
}

export interface SessionFinance {
  session_id: string;
  artist_id: string;
  project_id: string;
  currency: string;
  price: number | null;
  payment_status: PaymentStatus;
}

export interface InternalNote {
  id: string;
  author_profile_id: string;
  body: string;
  created_at: string;
}

export interface FollowUp {
  id: string;
  artist_id: string;
  status: FollowUpStatus;
  due_at: string;
  subject: string;
  details: string | null;
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  assigned_to: string | null;
}

export interface ActivityEntry {
  id: string;
  artist_id: string | null;
  occurred_at: string;
  event_type: string;
  actor_kind: string;
  actor_profile_id: string | null;
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
}

export interface OutboxJob {
  id: string;
  artist_id: string;
  kind: string;
  status: OutboxStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  updated_at: string;
}

export interface EmailMessage {
  id: string;
  artist_id: string;
  status: EmailStatus;
  to_email: string;
  subject: string;
  created_by_kind: string;
  created_at: string;
  // Links, so an email row in the Inbox can carry the same client, enquiry and
  // project context every other row carries.
  client_id: string | null;
  enquiry_id: string | null;
  project_id: string | null;
  approved_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  error_code: string | null;
}

/** One stored email with its body. Read only when a thread is opened. */
export interface EmailMessageDetail extends EmailMessage {
  body: string;
}

export interface StatusTransition {
  from_status: EnquiryStatus;
  to_status: EnquiryStatus;
  owner_only: boolean;
  note: string | null;
}
