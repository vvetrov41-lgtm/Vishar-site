// Instagram connection management.
//
// Connecting an Instagram professional account is a provider operation, not a
// database write, so it goes through the connector Worker rather than through
// Supabase. The CRM sends its own Supabase session and names an artist; the
// Worker asks the database whether that operator may manage that artist's
// integrations, and derives the integration selector itself.
//
// No token, app secret or provider account id is ever chosen, stored or read
// by this module. The status response deliberately carries only non-secret
// connection state.

import { ApiError, type CrmClient } from './api';

export interface InstagramConnectionStatus {
  artist_id: string;
  integration_key: string;
  is_enabled: boolean;
  connected: boolean;
  token_expires_at: string | null;
  needs_reconnect: boolean;
}

export interface InstagramIntegrationMetadata {
  id: string;
  artist_id: string;
  provider: 'instagram_login';
  integration_key: string;
  external_account_label: string | null;
  is_enabled: boolean;
  updated_at: string;
}

function isHostedInstagramConnectorHost(hostname: string): boolean {
  const labels = hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'vishartattoo' || labels[2] !== 'com') return false;
  return /^instagram(?:-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/.test(labels[0]);
}

/**
 * Reads and validates the connector origin from build configuration.
 *
 * The origin is not free-form: a build that pointed the CRM at an arbitrary
 * host would be sending an operator's Supabase session somewhere unreviewed.
 */
export function readInstagramConnectorOrigin(
  env: Record<string, string | undefined>,
  allowLocal = false,
): string {
  const value = (env.VITE_INSTAGRAM_CONNECTOR_ORIGIN ?? '').trim();
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('VITE_INSTAGRAM_CONNECTOR_ORIGIN must be a permitted connector root URL.');
  }

  const loopback = allowLocal
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  const hosted = parsed.protocol === 'https:'
    && isHostedInstagramConnectorHost(parsed.hostname)
    && !parsed.port;

  if (
    (!hosted && !loopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new ApiError('VITE_INSTAGRAM_CONNECTOR_ORIGIN must be a permitted connector root URL.');
  }

  return parsed.origin;
}

function assertMetadata(value: unknown): InstagramIntegrationMetadata[] {
  if (!Array.isArray(value)) throw new ApiError('Could not load Instagram connections.');
  return value.map((row: any) => {
    if (
      !row
      || typeof row !== 'object'
      || typeof row.id !== 'string'
      || typeof row.artist_id !== 'string'
      || row.provider !== 'instagram_login'
      || typeof row.integration_key !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.integration_key)
      || (row.external_account_label !== null && typeof row.external_account_label !== 'string')
      || typeof row.is_enabled !== 'boolean'
      || typeof row.updated_at !== 'string'
    ) {
      throw new ApiError('Could not load Instagram connections.');
    }
    return row as InstagramIntegrationMetadata;
  });
}

function connectorFailureMessage(status: number, payload: unknown): string {
  if (status === 401) return 'Your CRM session has expired. Sign in again.';
  if (status === 403) return 'You cannot manage this artist Instagram connection.';
  if (status === 429) return 'Too many attempts. Try again shortly.';

  const code = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { error?: unknown }).error
    : null;
  if (code === 'session_verification_unavailable') {
    return 'CRM could not verify your session with its authorization service. Try again shortly.';
  }
  if (code === 'session_verification_request_failed') {
    return 'CRM could not reach its session verification service. Try again shortly.';
  }
  if (code === 'session_verification_upstream_failed') {
    return 'CRM received an unexpected response from its session verification service. Try again shortly.';
  }
  if (code === 'session_verification_response_invalid') {
    return 'CRM received an invalid session verification response. Try again shortly.';
  }
  if (code === 'authorization_backend_unavailable') {
    return 'CRM could not complete the Instagram permission check. Try again shortly.';
  }
  return 'The Instagram connector is unavailable right now.';
}

export function createInstagramConnectionsApi(
  client: CrmClient,
  options: {
    connectorOrigin?: string;
    fetcher?: typeof globalThis.fetch;
  } = {},
) {
  const origin = options.connectorOrigin
    ?? readInstagramConnectorOrigin(
      (import.meta as any).env ?? {},
      Boolean((import.meta as any).env?.DEV),
    );
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

  async function sessionToken(): Promise<string> {
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new ApiError('Your CRM session has expired. Sign in again.');
    }
    return token;
  }

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    if (!origin) throw new ApiError('The Instagram connector is not configured in this build.');
    const token = await sessionToken();
    const response = await fetcher(`${origin}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(connectorFailureMessage(response.status, payload));
    }
    return payload;
  }

  return {
    instagramConnectorConfigured: Boolean(origin),

    async listInstagramIntegrations(): Promise<InstagramIntegrationMetadata[]> {
      const result = await client
        .from('artist_integrations')
        .select('id, artist_id, provider, integration_key, external_account_label, is_enabled, updated_at')
        .eq('integration_type', 'instagram')
        .order('updated_at', { ascending: false });
      if (result.error) throw new ApiError('Could not load Instagram connections.', result.error);
      return assertMetadata(result.data ?? []);
    },

    async instagramConnectionStatus(artistId: string): Promise<InstagramConnectionStatus> {
      return call(`/v1/connections/status?artist_id=${encodeURIComponent(artistId)}`, {
        method: 'GET',
      });
    },

    /**
     * Returns the Meta authorization URL for this artist. The CRM never builds
     * that URL itself, because doing so would mean the browser choosing the
     * app id, the scopes and the redirect.
     */
    async startInstagramConnection(artistId: string): Promise<{ authorize_url: string }> {
      return call('/v1/connections/start', {
        method: 'POST',
        body: JSON.stringify({ artist_id: artistId }),
      });
    },

    async disconnectInstagram(artistId: string): Promise<{ connected: boolean }> {
      return call('/v1/connections/disconnect', {
        method: 'POST',
        body: JSON.stringify({ artist_id: artistId }),
      });
    },
  };
}

export type InstagramConnectionsApi = ReturnType<typeof createInstagramConnectionsApi>;
