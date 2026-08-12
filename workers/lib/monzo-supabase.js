import { readSupabaseConfig } from './supabase.js';

const ALLOWED_MONZO_RPCS = new Set([
  'register_monzo_reconciliation_candidate',
]);

export class MonzoSupabaseError extends Error {
  constructor(status, code = 'monzo_database_request_failed') {
    super(code);
    this.name = 'MonzoSupabaseError';
    this.status = status;
    this.code = code;
  }
}

export function createMonzoSupabaseClient(env, fetchImpl = fetch) {
  const { url, authHeaders } = readSupabaseConfig(env);

  async function rpc(name, args) {
    if (!ALLOWED_MONZO_RPCS.has(name)) throw new Error('Monzo RPC is not allowed');
    const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args ?? {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new MonzoSupabaseError(response.status);
    return body;
  }

  return { rpc };
}

export const __testing = { ALLOWED_MONZO_RPCS };
