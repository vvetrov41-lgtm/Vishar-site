import { ApiError, type CrmClient } from './api';

interface OAuthMethods {
  getAuthorizationDetails: (authorizationId: string) => Promise<{ data: any; error: any }>;
  approveAuthorization: (authorizationId: string) => Promise<{ data: any; error: any }>;
  denyAuthorization: (authorizationId: string) => Promise<{ data: any; error: any }>;
}

interface OAuthCapableClient extends CrmClient {
  auth: CrmClient['auth'] & { oauth?: OAuthMethods };
}

export interface GptConsentSummary {
  integration_key: string;
  client_display_name: string;
  artist_id: string;
  artist_display_name: string;
  can_read_appointments: boolean;
  can_manage_appointments: boolean;
}

/**
 * The consent screen has to describe two different bindings truthfully. A
 * legacy GPT is fixed to one artist; the shared Vishar GPT is bound to the
 * signed-in CRM user and reaches only the artists that user is authorized for.
 * `binding_mode` is what the screen renders from, so it is never inferred from
 * a display string.
 */
export interface GptConsentDetails {
  integration_key: string;
  client_display_name: string;
  binding_mode: 'artist' | 'profile';
  artist_display_name: string | null;
  artist_count: number;
  can_read_appointments: boolean;
  can_manage_appointments: boolean;
}

export interface PendingGptConsent {
  authorizationId: string;
  requestedClientName: string;
  scopes: string[];
  summary: GptConsentSummary;
  /** Null only on a CRM database that predates the unified GPT migration. */
  details: GptConsentDetails | null;
}

export type GptConsentLoadResult =
  | { kind: 'redirect'; redirectUrl: string }
  | { kind: 'consent'; consent: PendingGptConsent };

export interface OAuthConsentApi {
  loadGptOAuthConsent: (authorizationId: string) => Promise<GptConsentLoadResult>;
  decideGptOAuthConsent: (
    authorizationId: string,
    decision: 'approve' | 'deny'
  ) => Promise<string>;
}

function validAuthorizationId(value: string): string {
  const clean = value.trim();
  if (
    clean.length < 8
    || clean.length > 500
    || !/^[A-Za-z0-9._~-]+$/.test(clean)
  ) {
    throw new ApiError('This authorization request is invalid or has expired.');
  }
  return clean;
}

function safeRedirectUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('The authorization server did not return a safe redirect.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('The authorization server did not return a safe redirect.');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ApiError('The authorization server did not return a safe redirect.');
  }
  return parsed.toString();
}

function oauthClientId(data: any): string | null {
  const candidates = [
    data?.client?.id,
    data?.client?.client_id,
    data?.client_id,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim() : null;
}

function requestedClientName(data: any): string {
  const candidates = [data?.client?.name, data?.client?.client_name];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim().slice(0, 120) : 'Private GPT';
}

function requestedScopes(data: any): string[] {
  const scopes = typeof data?.scope === 'string'
    ? data.scope.split(/\s+/).map((scope: string) => scope.trim()).filter(Boolean)
    : [];
  if (scopes.length !== 1 || scopes[0] !== 'email') {
    throw new ApiError('This GPT requested an unexpected OAuth scope.');
  }
  return scopes;
}

function oauthMethods(client: CrmClient): OAuthMethods {
  const methods = (client as OAuthCapableClient).auth.oauth;
  if (!methods) {
    throw new ApiError('OAuth consent is not available in this CRM build.');
  }
  return methods;
}

function consentSummary(data: any): GptConsentSummary {
  if (!Array.isArray(data) || data.length !== 1) {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  const row = data[0] as Partial<GptConsentSummary>;
  if (
    typeof row.integration_key !== 'string'
    || typeof row.client_display_name !== 'string'
    || typeof row.artist_id !== 'string'
    || typeof row.artist_display_name !== 'string'
    || typeof row.can_read_appointments !== 'boolean'
    || typeof row.can_manage_appointments !== 'boolean'
  ) {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  return row as GptConsentSummary;
}

const UNIFIED_ARTIST_SCOPE_LABEL = 'Artists available to your CRM profile';

function consentDetails(data: any): GptConsentDetails {
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  const row = data as Partial<GptConsentDetails>;
  if (
    typeof row.integration_key !== 'string'
    || typeof row.client_display_name !== 'string'
    || (row.binding_mode !== 'artist' && row.binding_mode !== 'profile')
    || typeof row.artist_count !== 'number'
    || !Number.isInteger(row.artist_count)
    || row.artist_count < 1
    || typeof row.can_read_appointments !== 'boolean'
    || typeof row.can_manage_appointments !== 'boolean'
  ) {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  // A GPT fixed to one artist must name that artist. One bound to a profile
  // must not, because it is fixed to none.
  if (row.binding_mode === 'artist') {
    if (typeof row.artist_display_name !== 'string' || !row.artist_display_name.trim()) {
      throw new ApiError('This GPT is not enabled for your CRM access.');
    }
  } else if (row.artist_display_name != null) {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  return {
    integration_key: row.integration_key,
    client_display_name: row.client_display_name,
    binding_mode: row.binding_mode,
    artist_display_name: row.binding_mode === 'artist'
      ? (row.artist_display_name as string)
      : null,
    artist_count: row.artist_count,
    can_read_appointments: row.can_read_appointments,
    can_manage_appointments: row.can_manage_appointments,
  };
}

export function createOAuthConsentApi(client: CrmClient): OAuthConsentApi {
  return {
    async loadGptOAuthConsent(authorizationId: string) {
      const cleanId = validAuthorizationId(authorizationId);
      const result = await oauthMethods(client).getAuthorizationDetails(cleanId);
      if (result.error || !result.data) {
        throw new ApiError('This authorization request is invalid or has expired.');
      }

      if (
        typeof result.data.redirect_url === 'string'
        && !('authorization_id' in result.data)
      ) {
        return { kind: 'redirect' as const, redirectUrl: safeRedirectUrl(result.data.redirect_url) };
      }

      if (result.data.authorization_id !== cleanId) {
        throw new ApiError('The authorization server returned a mismatched request.');
      }

      const clientId = oauthClientId(result.data);
      if (!clientId) {
        throw new ApiError('The authorization server did not identify the requesting GPT.');
      }

      // Prefer the detail contract, which carries the binding mode. Fall back
      // to the long-standing summary only when the RPC itself is unavailable,
      // so an older CRM database still renders a correct legacy screen. A
      // detail payload that arrives malformed is a refusal, not a fallback.
      const detailsResult = await client.rpc('get_gpt_consent_details', {
        p_oauth_client_id: clientId,
      });

      let details: GptConsentDetails | null = null;
      let summary: GptConsentSummary;
      if (detailsResult.error) {
        const summaryResult = await client.rpc('get_gpt_action_consent_summary', {
          p_oauth_client_id: clientId,
        });
        if (summaryResult.error) {
          throw new ApiError('This GPT is not enabled for your CRM access.');
        }
        summary = consentSummary(summaryResult.data);
      } else {
        details = consentDetails(detailsResult.data);
        summary = {
          integration_key: details.integration_key,
          client_display_name: details.client_display_name,
          artist_id: typeof (detailsResult.data as any)?.artist_id === 'string'
            ? (detailsResult.data as any).artist_id
            : '',
          artist_display_name: details.artist_display_name ?? UNIFIED_ARTIST_SCOPE_LABEL,
          can_read_appointments: details.can_read_appointments,
          can_manage_appointments: details.can_manage_appointments,
        };
      }

      return {
        kind: 'consent' as const,
        consent: {
          authorizationId: cleanId,
          requestedClientName: requestedClientName(result.data),
          scopes: requestedScopes(result.data),
          summary,
          details,
        },
      };
    },

    async decideGptOAuthConsent(authorizationId, decision) {
      const cleanId = validAuthorizationId(authorizationId);
      const oauth = oauthMethods(client);
      const result = decision === 'approve'
        ? await oauth.approveAuthorization(cleanId)
        : await oauth.denyAuthorization(cleanId);
      if (result.error || !result.data) {
        throw new ApiError('The authorization decision could not be completed.');
      }
      return safeRedirectUrl(result.data.redirect_url);
    },
  };
}

export const __testing = Object.freeze({
  validAuthorizationId,
  safeRedirectUrl,
  oauthClientId,
  requestedScopes,
  consentSummary,
  consentDetails,
});
