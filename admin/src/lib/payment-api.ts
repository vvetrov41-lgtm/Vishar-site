import { ApiError, friendlyMessage, type CrmClient } from './api';

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

function unwrap<T>(result: { data: T | null; error: any }, what: string): T {
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
