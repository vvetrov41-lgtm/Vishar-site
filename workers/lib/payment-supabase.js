// Narrow Supabase client for the future public payment-redirect Worker.
// It exposes no table API and only the single backend redirect resolver RPC.

import { readSupabaseConfig } from './supabase.js';

const ALLOWED_PAYMENT_RPCS = new Set([
  'resolve_monzo_deposit_redirect',
]);

export class PaymentSupabaseError extends Error {
  constructor(status) {
    super('payment database request failed');
    this.name = 'PaymentSupabaseError';
    this.status = status;
  }
}

export function createPaymentSupabaseClient(env, fetchImpl = fetch) {
  const { url, authHeaders } = readSupabaseConfig(env);

  async function rpc(name, args) {
    if (!ALLOWED_PAYMENT_RPCS.has(name)) {
      throw new Error('payment RPC is not allowed');
    }

    const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args ?? {}),
    });

    if (!response.ok) throw new PaymentSupabaseError(response.status);
    return response.json();
  }

  return { rpc };
}
