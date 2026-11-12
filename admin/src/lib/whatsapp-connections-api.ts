import { apiMessage, ApiError, type CrmClient } from './api';
import type { WhatsAppEmbeddedSignupResult } from './meta-whatsapp-embedded-signup';
import type { Artist } from './types';

export interface WhatsAppIntegrationMetadata {
  id: string;
  artist_id: string;
  provider: 'meta_cloud_api';
  integration_key: string;
  external_account_label: string | null;
  is_enabled: boolean;
  connected_at: string | null;
  updated_at: string;
}

export interface WhatsAppProvisioningResult {
  ok: true;
  connected: true;
  connected_at: string;
  integration_key: string;
  waba_name: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
}

export interface MetaReviewTemplateMetadata {
  id: string | null;
  name: string;
  status: string | null;
  language: string;
  category: string;
}

export interface MetaReviewTemplateResult {
  ok: true;
  action: 'create' | 'delete' | 'status' | 'send' | 'business';
  accepted?: boolean;
  message_id?: string;
  template?: MetaReviewTemplateMetadata | null;
  deleted?: boolean;
  business?: { business_id: string; waba_id: string; waba_name: string | null };
}

export type ExistingWhatsAppProvisioningResult = WhatsAppProvisioningResult;

type WhatsAppArtist = Pick<Artist, 'id' | 'slug' | 'display_name'>;

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';
const OPERATOR_CRM_ORIGIN = 'https://app.vishartattoo.com';
const PRODUCTION_CRM_ORIGIN = 'https://crm.vishartattoo.com';

export function embeddedSignupProvisionUrl(path: string, browserOrigin: string): string {
  return browserOrigin === OPERATOR_CRM_ORIGIN ? `${PRODUCTION_CRM_ORIGIN}${path}` : path;
}
const EXISTING_ACCOUNT_ARTISTS = new Map([
  ['a1111111-1111-4111-8111-111111111111', 'vladimir'],
  ['a2222222-2222-4222-8222-222222222222', 'kristina'],
]);

export type WhatsAppCrmEnvironment = 'production' | 'staging';

export function whatsappCrmEnvironment(supabaseUrl: string): WhatsAppCrmEnvironment {
  let origin: string;
  try {
    origin = new URL(supabaseUrl).origin;
  } catch {
    throw new ApiError(apiMessage('WhatsApp integration controls are unavailable in this CRM environment.'));
  }
  if (origin === PRODUCTION_SUPABASE_ORIGIN) return 'production';
  if (origin === STAGING_SUPABASE_ORIGIN) return 'staging';
  throw new ApiError(apiMessage('WhatsApp integration controls are unavailable in this CRM environment.'));
}

export function whatsappIntegrationKey(supabaseUrl: string, artistSlug: string): string {
  const slug = artistSlug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ApiError(apiMessage('The artist routing key is not valid for WhatsApp.'));
  }
  return `${slug}-${whatsappCrmEnvironment(supabaseUrl)}`;
}

function assertSafeMetadata(value: unknown): WhatsAppIntegrationMetadata[] {
  if (!Array.isArray(value)) throw new ApiError(apiMessage('Could not load WhatsApp connections.'));
  return value.map((row) => {
    if (
      !row
      || typeof row !== 'object'
      || typeof (row as any).id !== 'string'
      || typeof (row as any).artist_id !== 'string'
      || (row as any).provider !== 'meta_cloud_api'
      || typeof (row as any).integration_key !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test((row as any).integration_key)
      || ((row as any).external_account_label !== null && typeof (row as any).external_account_label !== 'string')
      || typeof (row as any).is_enabled !== 'boolean'
      || ((row as any).connected_at !== null && typeof (row as any).connected_at !== 'string')
      || typeof (row as any).updated_at !== 'string'
    ) {
      throw new ApiError(apiMessage('Could not load WhatsApp connections.'));
    }
    return row as WhatsAppIntegrationMetadata;
  });
}

function assertProvisioningResponse(value: unknown, expectedIntegrationKey: string): WhatsAppProvisioningResult {
  if (!value || typeof value !== 'object') {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true
    || row.connected !== true
    || typeof row.connected_at !== 'string'
    || !Number.isFinite(Date.parse(row.connected_at))
    || row.integration_key !== expectedIntegrationKey
    || (row.waba_name !== null && typeof row.waba_name !== 'string')
    || (row.display_phone_number !== null && typeof row.display_phone_number !== 'string')
    || (row.verified_name !== null && typeof row.verified_name !== 'string')
  ) {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  return value as WhatsAppProvisioningResult;
}

function assertExistingProvisioningResponse(value: WhatsAppProvisioningResult): ExistingWhatsAppProvisioningResult {
  return value;
}

function safeProvisioningDiagnostic(payload: Record<string, unknown> | null, responseStatus: number): string {
  const error = payload && typeof payload.error === 'string'
    ? payload.error
    : `provisioning_failed_http_${responseStatus}`;
  if (error === 'meta_waba_not_discoverable' && payload) {
    // Permission names Meta granted, so a refusal shows what was missing.
    const names = (value: unknown) => (Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && /^[a-z_]{1,64}(:\d{1,3})?$/.test(item)).slice(0, 16)
      : []);
    const scopes = names(payload.meta_scopes);
    const granular = names(payload.meta_granular_scopes);
    return [
      error,
      scopes.length ? `scopes=${scopes.join(',')}` : 'scopes=none',
      granular.length ? `granular=${granular.join(',')}` : 'granular=none',
    ].join(' ');
  }
  if (error !== 'meta_request_failed' || !payload) return error;

  const details: string[] = [error];
  if (Number.isInteger(payload.graph_code)) details.push(`graph_code=${payload.graph_code}`);
  if (Number.isInteger(payload.graph_subcode)) details.push(`graph_subcode=${payload.graph_subcode}`);
  if (Number.isInteger(payload.upstream_status)) details.push(`upstream_status=${payload.upstream_status}`);
  return details.join(' ');
}

function assertMetaReviewTemplate(value: unknown): MetaReviewTemplateMetadata {
  if (!value || typeof value !== 'object') {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  const row = value as Record<string, unknown>;
  if (
    (row.id !== null && typeof row.id !== 'string')
    || typeof row.name !== 'string'
    || !/^meta_review_permission_demo_[0-9]{14}$/.test(row.name)
    || (row.status !== null && typeof row.status !== 'string')
    || typeof row.language !== 'string'
    || typeof row.category !== 'string'
  ) {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  return row as unknown as MetaReviewTemplateMetadata;
}

function assertMetaReviewResponse(value: unknown, expectedAction: 'create' | 'delete' | 'status' | 'send' | 'business'): MetaReviewTemplateResult {
  if (!value || typeof value !== 'object') {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  const row = value as Record<string, unknown>;
  if (row.ok !== true || row.action !== expectedAction) {
    throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
  }
  if (expectedAction === 'business') {
    const business = row.business && typeof row.business === 'object'
      ? row.business as Record<string, unknown> : null;
    if (!business || business.business_id !== '692776505711216'
      || typeof business.waba_id !== 'string' || !/^[1-9][0-9]{5,30}$/.test(business.waba_id)
      || (business.waba_name !== null && typeof business.waba_name !== 'string')) {
      throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
    }
    return { ok: true, action: 'business', business: {
      business_id: business.business_id, waba_id: business.waba_id,
      waba_name: business.waba_name as string | null,
    } };
  }
  if (expectedAction === 'send') {
    if (row.accepted !== true || typeof row.message_id !== 'string'
      || !/^wamid\.[A-Za-z0-9_.=-]{8,256}$/.test(row.message_id)) {
      throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
    }
    return { ok: true, action: 'send', accepted: true, message_id: row.message_id };
  }
  if (expectedAction === 'delete') {
    if (typeof row.deleted !== 'boolean') {
      throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
    }
    return { ok: true, action: expectedAction, deleted: row.deleted };
  }
  if (row.template !== null && row.template !== undefined) {
    return { ok: true, action: expectedAction, template: assertMetaReviewTemplate(row.template) };
  }
  return { ok: true, action: expectedAction, template: null };
}

export function createWhatsAppConnectionsApi(client: CrmClient) {
  async function configure(artist: WhatsAppArtist, supabaseUrl: string, enabled: boolean) {
    const integrationKey = whatsappIntegrationKey(supabaseUrl, artist.slug);
    const result = await client.rpc('configure_artist_integration', {
      p_artist_id: artist.id,
      p_integration_type: 'whatsapp',
      p_provider: 'meta_cloud_api',
      p_integration_key: integrationKey,
      p_external_account_label: `${artist.display_name} WhatsApp`,
      p_configuration: {},
      p_is_enabled: enabled,
    });
    if (result.error) {
      throw new ApiError(
        enabled ? 'Could not enable that WhatsApp connection.' : 'Could not update that WhatsApp connection.',
        result.error,
      );
    }
    return result.data;
  }

  async function crmAccessToken(): Promise<string> {
    const session = await client.auth.getSession();
    const accessToken = session.data?.session?.access_token;
    if (!accessToken) {
      throw new ApiError(apiMessage('Your CRM session expired. Sign in again before connecting WhatsApp.'));
    }
    return accessToken;
  }

  async function provisioningRequest(
    endpoint: string,
    accessToken: string,
    body: Record<string, unknown>,
    expectedIntegrationKey: string,
  ): Promise<WhatsAppProvisioningResult> {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const diagnostic = safeProvisioningDiagnostic(payload, response.status);
      throw new ApiError(`WhatsApp provisioning failed: ${diagnostic}.`);
    }
    return assertProvisioningResponse(payload, expectedIntegrationKey);
  }

  return {
    async listWhatsAppIntegrations(): Promise<WhatsAppIntegrationMetadata[]> {
      const result = await client
        .from('artist_integrations')
        .select('id, artist_id, provider, integration_key, external_account_label, is_enabled, connected_at, updated_at')
        .eq('integration_type', 'whatsapp')
        .order('updated_at', { ascending: false });
      if (result.error) throw new ApiError(apiMessage('Could not load WhatsApp connections.'), result.error);
      return assertSafeMetadata(result.data ?? []);
    },

    async prepareWhatsAppIntegration(artist: WhatsAppArtist, supabaseUrl: string) {
      return configure(artist, supabaseUrl, false);
    },

    async setWhatsAppIntegrationEnabled(artist: WhatsAppArtist, supabaseUrl: string, enabled: boolean) {
      return configure(artist, supabaseUrl, enabled);
    },

    async provisionExistingProductionWhatsApp(
      artist: WhatsAppArtist,
      supabaseUrl: string,
      metaAccessToken: string,
    ): Promise<ExistingWhatsAppProvisioningResult> {
      if (whatsappCrmEnvironment(supabaseUrl) !== 'production') {
        throw new ApiError(apiMessage('Production WhatsApp provisioning is unavailable in this CRM environment.'));
      }
      const approvedSlug = EXISTING_ACCOUNT_ARTISTS.get(artist.id);
      if (!approvedSlug || artist.slug !== approvedSlug) {
        throw new ApiError(apiMessage('Production WhatsApp onboarding is unavailable for this artist.'));
      }
      const token = metaAccessToken.trim();
      if (token.length < 40 || token.length > 4096 || /\s/.test(token)) {
        throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
      }
      const expectedIntegrationKey = whatsappIntegrationKey(supabaseUrl, approvedSlug);
      const accessToken = await crmAccessToken();
      const result = await provisioningRequest(
        '/api/whatsapp/existing-account/provision',
        accessToken,
        { artist_id: artist.id, access_token: token },
        expectedIntegrationKey,
      );
      return assertExistingProvisioningResponse(result);
    },

    async checkCoexistenceWebhookReadiness(artist: WhatsAppArtist, supabaseUrl: string): Promise<void> {
      if (whatsappCrmEnvironment(supabaseUrl) !== 'production' || artist.slug !== 'kristina') {
        throw new ApiError(apiMessage('Production WhatsApp provisioning is unavailable in this CRM environment.'));
      }
      const accessToken = await crmAccessToken();
      const url = embeddedSignupProvisionUrl(
        `/api/whatsapp/embedded-signup/provision?artist_id=${encodeURIComponent(artist.id)}`,
        window.location.origin,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new ApiError(apiMessage('Meta readiness check timed out or could not be reached. Try again later.'));
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const reason = payload && typeof payload.error === 'string'
          ? payload.error : `coexistence_preflight_failed_http_${response.status}`;
        throw new ApiError(reason);
      }
      if (payload?.ok !== true || payload?.ready !== true) {
        throw new ApiError(apiMessage('WhatsApp provisioning returned an invalid response.'));
      }
    },

    async provisionProductionWhatsApp(
      artist: WhatsAppArtist,
      supabaseUrl: string,
      signup: WhatsAppEmbeddedSignupResult,
    ): Promise<WhatsAppProvisioningResult> {
      if (whatsappCrmEnvironment(supabaseUrl) !== 'production') {
        throw new ApiError(apiMessage('Production WhatsApp provisioning is unavailable in this CRM environment.'));
      }
      if (signup.event !== 'FINISH' && signup.event !== 'CODE_ONLY') {
        throw new ApiError(apiMessage('Meta Embedded Signup did not finish authorization.'));
      }

      const expectedIntegrationKey = whatsappIntegrationKey(supabaseUrl, artist.slug);
      const accessToken = await crmAccessToken();
      return provisioningRequest(
        embeddedSignupProvisionUrl('/api/whatsapp/embedded-signup/provision', window.location.origin),
        accessToken,
        {
          artist_id: artist.id,
          code: signup.authorizationCode,
          session: signup.wabaId ? {
            waba_id: signup.wabaId,
            phone_number_id: signup.phoneNumberId,
          } : null,
          ...(signup.redirectFlow === 'crm_root' ? { redirect_uri_mode: 'crm_root' } : {}),
        },
        expectedIntegrationKey,
      );
    },

    async getBusinessReviewLoginConfig(): Promise<{ config_id: string }> {
      const accessToken = await crmAccessToken();
      const response = await fetch(embeddedSignupProvisionUrl(
        '/api/whatsapp/meta-review/business-login', window.location.origin,
      ), {
        method: 'GET',
        cache: 'no-store',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || payload?.ok !== true || typeof payload.config_id !== 'string'
        || !/^[1-9][0-9]{8,24}$/.test(payload.config_id)) {
        throw new ApiError(typeof payload?.error === 'string' ? payload.error : 'meta_review_business_login_unavailable');
      }
      return { config_id: payload.config_id };
    },

    async completeBusinessReviewLogin(code: string): Promise<{ business_id: string; business_name: string | null }> {
      if (!/^[\\x21-\\x7e]{10,2048}$/.test(code)) throw new ApiError('invalid_oauth_code');
      const accessToken = await crmAccessToken();
      const response = await fetch(embeddedSignupProvisionUrl(
        '/api/whatsapp/meta-review/business-login', window.location.origin,
      ), {
        method: 'POST',
        cache: 'no-store',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || payload?.ok !== true) {
        throw new ApiError(typeof payload?.error === 'string' ? payload.error : 'meta_review_business_login_failed');
      }
      if (typeof payload.business_id !== 'string' || !/^[1-9][0-9]{5,30}$/.test(payload.business_id)
        || (payload.business_name !== null && typeof payload.business_name !== 'string')
        || payload.permission !== 'business_management') {
        throw new ApiError('meta_review_business_login_invalid_response');
      }
      return { business_id: payload.business_id, business_name: payload.business_name };
    },

    async manageMetaReviewTemplate(
      action: 'create' | 'delete' | 'status' | 'send' | 'business',
      recipient?: string,
      templateName?: string,
    ): Promise<MetaReviewTemplateResult> {
      const accessToken = await crmAccessToken();
      const response = await fetch(embeddedSignupProvisionUrl(
        '/api/whatsapp/meta-review/template', window.location.origin,
      ), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(action === 'send' ? { action, recipient, template_name: templateName } : { action }),
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const error = payload && typeof payload.error === 'string'
          ? payload.error
          : `meta_review_failed_http_${response.status}`;
        const details: string[] = [error];
        if (!payload || typeof payload.error !== 'string') {
          const ray = response.headers.get('cf-ray');
          details.push(response.headers.get('x-vishar-review-handler') === 'template-v1'
            ? 'handler=template-v1' : 'handler=not_reached');
          if (ray && /^[a-z0-9-]{8,80}$/i.test(ray)) details.push(`cf_ray=${ray}`);
        }
        if (payload && Number.isInteger(payload.graph_code)) details.push(`graph_code=${payload.graph_code}`);
        if (payload && Number.isInteger(payload.graph_subcode)) details.push(`graph_subcode=${payload.graph_subcode}`);
        if (payload && Number.isInteger(payload.upstream_status)) details.push(`upstream_status=${payload.upstream_status}`);
        if (payload && typeof payload.stage === 'string' && /^[a-z_]{1,40}$/.test(payload.stage)) details.push(`stage=${payload.stage}`);
        if (payload && typeof payload.graph_message === 'string' && payload.graph_message) {
          details.push(`graph_message="${payload.graph_message.slice(0, 240)}"`);
        }
        throw new ApiError(`Meta review template failed: ${details.join(' ')}.`);
      }
      return assertMetaReviewResponse(payload, action);
    },
  };
}

export type WhatsAppConnectionsApi = ReturnType<typeof createWhatsAppConnectionsApi>;
