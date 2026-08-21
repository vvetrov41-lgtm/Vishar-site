import { ApiError, type CrmClient } from './api';
import type { WhatsAppEmbeddedSignupResult } from './meta-whatsapp-embedded-signup';
import type { Artist } from './types';

export interface WhatsAppIntegrationMetadata {
  id: string;
  artist_id: string;
  provider: 'meta_cloud_api';
  integration_key: string;
  external_account_label: string | null;
  is_enabled: boolean;
  updated_at: string;
}

export interface WhatsAppProvisioningResult {
  ok: true;
  integration_key: string;
  waba_name: string | null;
  display_phone_number: string | null;
  verified_name: string | null;
}

type WhatsAppArtist = Pick<Artist, 'id' | 'slug' | 'display_name'>;

const PRODUCTION_SUPABASE_ORIGIN = 'https://vfjexhfdbrjmuxfdvbdx.supabase.co';
const STAGING_SUPABASE_ORIGIN = 'https://gwaliusblwrzisrwnsvs.supabase.co';
const PRODUCTION_ONBOARDING_ARTISTS = new Map([
  ['a1111111-1111-4111-8111-111111111111', 'vladimir'],
  ['a2222222-2222-4222-8222-222222222222', 'kristina'],
]);

export type WhatsAppCrmEnvironment = 'production' | 'staging';

export function whatsappCrmEnvironment(supabaseUrl: string): WhatsAppCrmEnvironment {
  let origin: string;
  try {
    origin = new URL(supabaseUrl).origin;
  } catch {
    throw new ApiError('WhatsApp integration controls are unavailable in this CRM environment.');
  }

  if (origin === PRODUCTION_SUPABASE_ORIGIN) return 'production';
  if (origin === STAGING_SUPABASE_ORIGIN) return 'staging';
  throw new ApiError('WhatsApp integration controls are unavailable in this CRM environment.');
}

export function whatsappIntegrationKey(supabaseUrl: string, artistSlug: string): string {
  const slug = artistSlug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ApiError('The artist routing key is not valid for WhatsApp.');
  }
  return `${slug}-${whatsappCrmEnvironment(supabaseUrl)}`;
}

function assertSafeMetadata(value: unknown): WhatsAppIntegrationMetadata[] {
  if (!Array.isArray(value)) throw new ApiError('Could not load WhatsApp connections.');
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
      || typeof (row as any).updated_at !== 'string'
    ) {
      throw new ApiError('Could not load WhatsApp connections.');
    }
    return row as WhatsAppIntegrationMetadata;
  });
}

function assertProvisioningResponse(
  value: unknown,
  expectedIntegrationKey: string,
): WhatsAppProvisioningResult {
  if (!value || typeof value !== 'object') {
    throw new ApiError('WhatsApp provisioning returned an invalid response.');
  }
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true
    || row.integration_key !== expectedIntegrationKey
    || (row.waba_name !== null && typeof row.waba_name !== 'string')
    || (row.display_phone_number !== null && typeof row.display_phone_number !== 'string')
    || (row.verified_name !== null && typeof row.verified_name !== 'string')
  ) {
    throw new ApiError('WhatsApp provisioning returned an invalid response.');
  }
  return value as WhatsAppProvisioningResult;
}

export function createWhatsAppConnectionsApi(client: CrmClient) {
  async function configure(
    artist: WhatsAppArtist,
    supabaseUrl: string,
    enabled: boolean,
  ) {
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
        enabled
          ? 'Could not enable that WhatsApp connection.'
          : 'Could not update that WhatsApp connection.',
        result.error,
      );
    }
    return result.data;
  }

  return {
    async listWhatsAppIntegrations(): Promise<WhatsAppIntegrationMetadata[]> {
      const result = await client
        .from('artist_integrations')
        .select('id, artist_id, provider, integration_key, external_account_label, is_enabled, updated_at')
        .eq('integration_type', 'whatsapp')
        .order('updated_at', { ascending: false });
      if (result.error) throw new ApiError('Could not load WhatsApp connections.', result.error);
      return assertSafeMetadata(result.data ?? []);
    },

    async prepareWhatsAppIntegration(artist: WhatsAppArtist, supabaseUrl: string) {
      return configure(artist, supabaseUrl, false);
    },

    async setWhatsAppIntegrationEnabled(
      artist: WhatsAppArtist,
      supabaseUrl: string,
      enabled: boolean,
    ) {
      return configure(artist, supabaseUrl, enabled);
    },

    async provisionProductionWhatsApp(
      artist: WhatsAppArtist,
      supabaseUrl: string,
      signup: WhatsAppEmbeddedSignupResult,
    ): Promise<WhatsAppProvisioningResult> {
      if (whatsappCrmEnvironment(supabaseUrl) !== 'production') {
        throw new ApiError('Production WhatsApp provisioning is unavailable in this CRM environment.');
      }
      const approvedSlug = PRODUCTION_ONBOARDING_ARTISTS.get(artist.id);
      if (!approvedSlug || artist.slug !== approvedSlug) {
        throw new ApiError('Production WhatsApp onboarding is unavailable for this artist.');
      }
      if (signup.event !== 'FINISH') throw new ApiError('Meta Embedded Signup did not finish.');

      const expectedIntegrationKey = whatsappIntegrationKey(supabaseUrl, approvedSlug);
      const session = await client.auth.getSession();
      const accessToken = session.data?.session?.access_token;
      if (!accessToken) {
        throw new ApiError('Your CRM session expired. Sign in again before connecting WhatsApp.');
      }

      const response = await fetch('/api/whatsapp/embedded-signup/provision', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          artist_id: artist.id,
          code: signup.authorizationCode,
          session: {
            waba_id: signup.wabaId,
            phone_number_id: signup.phoneNumberId,
          },
        }),
      });

      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const error = payload && typeof payload.error === 'string' ? payload.error : 'provisioning_failed';
        throw new ApiError(`WhatsApp provisioning failed: ${error}.`);
      }
      return assertProvisioningResponse(payload, expectedIntegrationKey);
    },
  };
}

export type WhatsAppConnectionsApi = ReturnType<typeof createWhatsAppConnectionsApi>;
