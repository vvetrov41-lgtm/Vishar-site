import { ApiError, friendlyMessage, type CrmClient, type ApiOperation } from './api';

export interface DepositTier {
  max_minutes: number | null;
  amount: number;
  currency: string;
}

export interface MonzoDepositSettings {
  configured: boolean;
  enabled: boolean;
  payment_url: string | null;
  deposit_amount: number;
  deposit_policy: 'duration_tiered_v1';
  deposit_tiers: DepositTier[];
  currency: string;
  default_delivery_channel: 'email';
  email_status: 'provider_not_connected';
  sms_status: 'not_configured';
  monzo_api_status: 'not_connected';
}

export interface DepositRequestResult {
  payment_request_id: string;
  payment_link_id: string;
  public_path: string;
  amount: number;
  currency: string;
  duration_minutes?: number;
  tier_max_minutes?: number | null;
  delivery_channel: 'email' | 'copy_link';
  delivery_status: 'queued_provider_not_connected' | 'link_created';
  replayed: boolean;
}

export interface GroupedDepositRequestResult extends DepositRequestResult {
  deposit_group_id: string;
  session_count: number;
  sessions?: Array<{
    session_id: string;
    amount: number;
    currency: string;
    duration_minutes: number;
    tier_max_minutes: number | null;
  }>;
}

/**
 * One reusable destination catalogue entry. The provider URL is deliberately
 * absent: the server returns only a non-reversible fingerprint so the CRM can
 * show that an entry exists and has or has not changed.
 */
export interface MonzoPaymentDestination {
  destination_id: string;
  amount: number;
  currency: string;
  configured: true;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  issued_request_count: number;
}

export interface MonzoPaymentDestinationCatalogue {
  artist_id: string;
  currency: string;
  destinations: MonzoPaymentDestination[];
}

export interface UpsertMonzoPaymentDestinationResult {
  destination_id: string;
  artist_id: string;
  amount: number;
  currency: string;
  fingerprint: string;
  replaced: boolean;
  unchanged: boolean;
  confirmed: false;
}

export interface ArchiveMonzoPaymentDestinationResult {
  destination_id: string;
  artist_id: string;
  amount: number;
  currency: string;
  archived: boolean;
  unchanged: boolean;
}

export type ProjectDepositMode = 'fixed' | 'percentage_of_estimate';

export interface ProjectDepositPolicy {
  artist_id: string;
  configured: boolean;
  policy_id?: string;
  version?: number;
  mode?: ProjectDepositMode;
  fixed_amount?: number | null;
  percentage?: number | null;
  minimum_amount?: number | null;
  rounding_step?: number;
  currency: string;
}

/**
 * Server-calculated preview. It is explicitly non-authoritative for display
 * only; the amount a request is actually created with is recalculated by the
 * server inside `request_project_deposit`.
 */
export interface ProjectDepositPreview {
  project_id: string;
  artist_id?: string;
  currency: string;
  estimate_total: number | null;
  estimated_hours: number | null;
  estimated_sessions: number | null;
  policy_configured: boolean;
  calculable: boolean;
  reason?: string;
  policy_id?: string;
  policy_version?: number;
  mode?: ProjectDepositMode;
  fixed_amount?: number | null;
  percentage?: number | null;
  minimum_amount?: number | null;
  rounding_step?: number;
  suggested_amount?: number;
  override_amount: number | null;
  amount?: number;
  reusable_destination_configured?: boolean;
  open_payment_request_id: string | null;
  open_payment_request_status: string | null;
}

export interface ProjectDepositRequestResult {
  payment_request_id: string;
  payment_link_id: string;
  public_path: string;
  amount: number;
  currency: string;
  suggested_amount: number;
  override_amount: number | null;
  destination_source: 'reusable' | 'one_off' | 'legacy_integration' | null;
  destination_ready: boolean;
  delivery_channel: 'email' | 'copy_link';
  delivery_status: 'queued_provider_not_connected' | 'link_created';
  replayed: boolean;
}

export interface ManualProjectDepositResult {
  payment_request_id: string;
  payment_transaction_id: string | null;
  amount: number;
  manually_recorded: number;
  currency: string;
  request_created: boolean;
  already_paid: boolean;
  replayed: boolean;
}

export interface OneOffPaymentDestinationResult {
  payment_request_id: string;
  public_path: string;
  amount: number;
  currency: string;
  replaced: boolean;
  confirmed: false;
}

export interface ProjectPaymentRequest {
  id: string;
  session_id: string | null;
  purpose: string;
  amount: number;
  currency: string;
  status: 'pending' | 'partially_paid' | 'paid' | 'cancelled' | 'expired';
  created_at: string;
  net_paid: number;
  outstanding_amount: number;
}

export interface ManualPaymentResult {
  payment_transaction_id: string;
  payment_request_id: string;
  replayed: boolean;
}

export interface MonzoReconciliationRequestSummary {
  payment_request_id: string;
  client_name: string;
  purpose: string;
  request_status: string;
  amount: number;
  outstanding_amount: number;
  currency: string;
  session_start_at: string | null;
  session_end_at: string | null;
  is_suggested?: boolean;
  is_matched?: boolean;
}

export interface MonzoReconciliationCandidate {
  id: string;
  amount: number;
  currency: string;
  occurred_at: string;
  status: 'unmatched' | 'candidate' | 'ambiguous' | 'matched' | 'ignored';
  confirmed: boolean;
  suggested_payment_request: MonzoReconciliationRequestSummary | null;
  matched_payment_request: MonzoReconciliationRequestSummary | null;
  match_options: MonzoReconciliationRequestSummary[];
}

export interface MonzoReconciliationActionResult {
  candidate_id: string;
  status?: 'matched' | 'ignored';
  payment_request_id?: string;
  payment_transaction_id?: string;
  payment_request_status?: string;
  confirmed: boolean;
  changed?: boolean;
  replayed?: boolean;
}

function unwrap<T>(result: { data: T | null; error: any }, what: ApiOperation): T {
  if (result.error) throw new ApiError(friendlyMessage(result.error, what), result.error);
  return result.data as T;
}

export function createPaymentApi(client: CrmClient) {
  return {
    async getMonzoDepositSettings(artistId: string): Promise<MonzoDepositSettings> {
      return unwrap<MonzoDepositSettings>(
        await client.rpc('get_monzo_easy_bank_transfer_settings', { p_artist_id: artistId }),
        'load Monzo deposit settings'
      );
    },

    async configureMonzoDeposit(input: { artistId: string; paymentUrl: string; enabled: boolean }) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('configure_monzo_easy_bank_transfer', {
          p_artist_id: input.artistId,
          p_payment_url: input.paymentUrl,
          p_is_enabled: input.enabled,
        }),
        'save Monzo deposit settings'
      );
    },

    async listMonzoPaymentDestinations(artistId: string): Promise<MonzoPaymentDestinationCatalogue> {
      return unwrap<MonzoPaymentDestinationCatalogue>(
        await client.rpc('list_monzo_payment_destinations', { p_artist_id: artistId }),
        'load reusable payment links'
      );
    },

    /**
     * Configures one reusable catalogue entry. The amount here is catalogue
     * configuration only: it never becomes the amount of a client payment
     * request, which the server derives from the deposit policy.
     */
    async upsertMonzoPaymentDestination(input: {
      artistId: string;
      amount: number;
      paymentUrl: string;
    }): Promise<UpsertMonzoPaymentDestinationResult> {
      return unwrap<UpsertMonzoPaymentDestinationResult>(
        await client.rpc('upsert_monzo_payment_destination', {
          p_artist_id: input.artistId,
          p_amount: input.amount,
          p_payment_url: input.paymentUrl,
        }),
        'save that reusable payment link'
      );
    },

    async archiveMonzoPaymentDestination(destinationId: string): Promise<ArchiveMonzoPaymentDestinationResult> {
      return unwrap<ArchiveMonzoPaymentDestinationResult>(
        await client.rpc('archive_monzo_payment_destination', {
          p_destination_id: destinationId,
        }),
        'remove that reusable payment link'
      );
    },

    async getProjectDepositPolicy(artistId: string): Promise<ProjectDepositPolicy> {
      return unwrap<ProjectDepositPolicy>(
        await client.rpc('get_project_deposit_policy', { p_artist_id: artistId }),
        'load the project deposit policy'
      );
    },

    async configureProjectDepositPolicy(input: {
      artistId: string;
      mode: ProjectDepositMode;
      fixedAmount?: number | null;
      percentage?: number | null;
      minimumAmount?: number | null;
      roundingStep?: number;
    }) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('configure_project_deposit_policy', {
          p_artist_id: input.artistId,
          p_mode: input.mode,
          p_fixed_amount: input.fixedAmount ?? null,
          p_percentage: input.percentage ?? null,
          p_minimum_amount: input.minimumAmount ?? null,
          p_rounding_step: input.roundingStep ?? 1,
        }),
        'save the project deposit policy'
      );
    },

    async previewProjectDeposit(projectId: string): Promise<ProjectDepositPreview> {
      return unwrap<ProjectDepositPreview>(
        await client.rpc('preview_project_deposit', { p_project_id: projectId }),
        'calculate the project deposit'
      );
    },

    async setProjectDepositOverride(input: { projectId: string; amount: number | null }) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('set_project_deposit_override', {
          p_project_id: input.projectId,
          p_amount: input.amount,
        }),
        'save the project deposit override'
      );
    },

    /**
     * The browser deliberately sends no amount. The server recalculates the
     * authoritative deposit from project facts, the artist policy and any
     * authorised override before creating the immutable request.
     */
    async requestProjectDeposit(input: {
      projectId: string;
      deliveryChannel: 'email' | 'copy_link';
      idempotencyKey?: string;
    }): Promise<ProjectDepositRequestResult> {
      const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
      return unwrap<ProjectDepositRequestResult>(
        await client.rpc('request_project_deposit', {
          p_project_id: input.projectId,
          p_idempotency_key: idempotencyKey,
          p_delivery_channel: input.deliveryChannel,
        }),
        'create that project deposit request'
      );
    },

    /**
     * Manual confirmation is deliberately project-scoped and amount-free in
     * the browser. The server either settles the outstanding project deposit
     * request or creates provider-neutral immutable request evidence first.
     */
    async confirmProjectDepositManually(input: {
      projectId: string;
      occurredAt?: string;
      idempotencyKey?: string;
    }): Promise<ManualProjectDepositResult> {
      return unwrap<ManualProjectDepositResult>(
        await client.rpc('confirm_project_deposit_manually', {
          p_project_id: input.projectId,
          p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
          p_occurred_at: input.occurredAt ?? new Date().toISOString(),
        }),
        'confirm that project deposit manually'
      );
    },

    async requestSessionDeposit(input: {
      sessionId: string;
      deliveryChannel: 'email' | 'copy_link';
      idempotencyKey?: string;
    }): Promise<DepositRequestResult> {
      const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
      return unwrap<DepositRequestResult>(
        await client.rpc('request_session_deposit', {
          p_session_id: input.sessionId,
          p_idempotency_key: idempotencyKey,
          p_delivery_channel: input.deliveryChannel,
        }),
        'request that deposit'
      );
    },

    async requestGroupedSessionDeposit(input: {
      sessionIds: string[];
      deliveryChannel: 'email' | 'copy_link';
      idempotencyKey?: string;
    }): Promise<GroupedDepositRequestResult> {
      const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
      return unwrap<GroupedDepositRequestResult>(
        await client.rpc('request_grouped_session_deposit', {
          p_session_ids: input.sessionIds,
          p_idempotency_key: idempotencyKey,
          p_delivery_channel: input.deliveryChannel,
        }),
        'request that multiple-session deposit'
      );
    },

    async attachMonzoOneOffPaymentDestination(input: {
      paymentRequestId: string;
      paymentUrl: string;
    }): Promise<OneOffPaymentDestinationResult> {
      return unwrap<OneOffPaymentDestinationResult>(
        await client.rpc('attach_monzo_one_off_payment_destination', {
          p_payment_request_id: input.paymentRequestId,
          p_payment_url: input.paymentUrl,
        }),
        'attach that one-off Monzo payment link'
      );
    },

    async listProjectPaymentRequests(projectId: string): Promise<ProjectPaymentRequest[]> {
      const requests = unwrap<any[]>(
        await client
          .from('payment_requests')
          .select('id, session_id, purpose, amount, currency, status, created_at')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false })
          .limit(100),
        'load project payment requests'
      );
      if (requests.length === 0) return [];

      const ids = requests.map((request) => request.id);
      const transactions = unwrap<any[]>(
        await client
          .from('payment_transactions')
          .select('payment_request_id, direction, amount, status')
          .in('payment_request_id', ids),
        'load project payment history'
      );

      return requests.map((request) => {
        const netPaid = transactions
          .filter((entry) => entry.payment_request_id === request.id && entry.status === 'succeeded')
          .reduce((sum, entry) => sum + (entry.direction === 'credit' ? Number(entry.amount) : -Number(entry.amount)), 0);
        const amount = Number(request.amount);
        return {
          id: request.id,
          session_id: request.session_id ?? null,
          purpose: request.purpose,
          amount,
          currency: request.currency,
          status: request.status,
          created_at: request.created_at,
          net_paid: Math.max(0, netPaid),
          outstanding_amount: Math.max(0, amount - netPaid),
        } as ProjectPaymentRequest;
      });
    },

    async recordManualPayment(input: {
      paymentRequestId: string;
      amount: number;
      occurredAt?: string;
      idempotencyKey?: string;
    }): Promise<ManualPaymentResult> {
      return unwrap<ManualPaymentResult>(
        await client.rpc('record_manual_payment', {
          p_payment_request_id: input.paymentRequestId,
          p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
          p_amount: input.amount,
          p_occurred_at: input.occurredAt ?? new Date().toISOString(),
          p_safe_note_code: 'crm_manual_payment',
        }),
        'record that manual payment'
      );
    },

    async cancelPaymentRequest(paymentRequestId: string) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('cancel_payment_request', { p_payment_request_id: paymentRequestId }),
        'cancel that payment request'
      );
    },

    async listMonzoReconciliationCandidates(artistId: string): Promise<MonzoReconciliationCandidate[]> {
      return unwrap<MonzoReconciliationCandidate[]>(
        await client.rpc('list_monzo_reconciliation_candidates', { p_artist_id: artistId }),
        'load Monzo reconciliation candidates'
      );
    },

    async matchMonzoReconciliationCandidate(input: {
      candidateId: string;
      paymentRequestId: string;
    }): Promise<MonzoReconciliationActionResult> {
      return unwrap<MonzoReconciliationActionResult>(
        await client.rpc('match_monzo_reconciliation_candidate', {
          p_candidate_id: input.candidateId,
          p_payment_request_id: input.paymentRequestId,
        }),
        'match that Monzo payment'
      );
    },

    async ignoreMonzoReconciliationCandidate(candidateId: string): Promise<MonzoReconciliationActionResult> {
      return unwrap<MonzoReconciliationActionResult>(
        await client.rpc('ignore_monzo_reconciliation_candidate', { p_candidate_id: candidateId }),
        'ignore that Monzo payment'
      );
    },

    async confirmMonzoReconciliationCandidate(candidateId: string): Promise<MonzoReconciliationActionResult> {
      return unwrap<MonzoReconciliationActionResult>(
        await client.rpc('confirm_monzo_reconciliation_candidate', { p_candidate_id: candidateId }),
        'confirm that Monzo payment'
      );
    },
  };
}

export type PaymentApi = ReturnType<typeof createPaymentApi>;
