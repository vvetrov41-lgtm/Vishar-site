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
  artist_id: string | null;
  artist_display_name: string;
  can_read_appointments: boolean;
  can_manage_appointments: boolean;
  identity_mode: 'legacy_fixed' | 'unified_user';
  accessible_artists: Array<{ key: string; display_name: string }>;
}

export interface PendingGptConsent {
  authorizationId: string;
  requestedClientName: string;
  scopes: string[];
  summary: GptConsentSummary;
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
    || !(row.artist_id === null || typeof row.artist_id === 'string')
    || typeof row.artist_display_name !== 'string'
    || typeof row.can_read_appointments !== 'boolean'
    || typeof row.can_manage_appointments !== 'boolean'
    || !['legacy_fixed', 'unified_user'].includes(String(row.identity_mode))
    || !Array.isArray(row.accessible_artists)
    || row.accessible_artists.length < 1
    || row.accessible_artists.some((artist) => (
      !artist
      || typeof artist.key !== 'string'
      || typeof artist.display_name !== 'string'
    ))
  ) {
    throw new ApiError('This GPT is not enabled for your CRM access.');
  }
  return row as GptConsentSummary;
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

      const summaryResult = await client.rpc('get_gpt_action_consent_summary', {
        p_oauth_client_id: clientId,
      });
      if (summaryResult.error) {
        throw new ApiError('This GPT is not enabled for your CRM access.');
      }

      return {
        kind: 'consent' as const,
        consent: {
          authorizationId: cleanId,
          requestedClientName: requestedClientName(result.data),
          scopes: requestedScopes(result.data),
          summary: consentSummary(summaryResult.data),
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
});
