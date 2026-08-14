import { ApiError, friendlyMessage, type CrmClient } from './api';

export interface MonzoDepositSettings {
  configured: boolean;
  enabled: boolean;
  payment_url: string | null;
  deposit_amount: number;
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
  delivery_channel: 'email' | 'copy_link';
  delivery_status: 'queued_provider_not_connected' | 'link_created';
  replayed: boolean;
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
  };
}

export type PaymentApi = ReturnType<typeof createPaymentApi>;
