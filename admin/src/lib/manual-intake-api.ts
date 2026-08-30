import { apiMessage, ApiError, friendlyMessage, type CrmClient } from './api';

export interface ManualEnquiryRequest {
  idempotencyKey: string;
  artistId: string;
  fullName: string;
  email: string;
  phone?: string;
  instagram?: string;
  preferredContact?: 'Email' | 'WhatsApp' | 'Instagram' | '';
  travellingFrom?: string;
  projectType?: string;
  placement?: string;
  approximateSize?: string;
  coverUp?: string;
  preferredTiming?: string;
  idea?: string;
  privacyAcknowledged: boolean;
}

export interface ManualEnquiryResult {
  enquiry_id: string;
  client_id: string;
  reference_number: string;
  intake_state: 'complete';
  replayed: boolean;
  client_conflict: boolean;
  client_match_method: string;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function assertResult(value: unknown): ManualEnquiryResult {
  const row = value as Record<string, unknown> | null;
  if (
    !row
    || typeof row.enquiry_id !== 'string'
    || typeof row.client_id !== 'string'
    || typeof row.reference_number !== 'string'
    || row.intake_state !== 'complete'
    || typeof row.replayed !== 'boolean'
    || typeof row.client_conflict !== 'boolean'
    || typeof row.client_match_method !== 'string'
  ) {
    throw new ApiError(apiMessage('The manual enquiry service returned an invalid response.'));
  }
  return row as unknown as ManualEnquiryResult;
}

export function createManualIntakeApi(client: CrmClient) {
  return {
    async createManualEnquiry(request: ManualEnquiryRequest): Promise<ManualEnquiryResult> {
      const result = await client.rpc('create_manual_enquiry', {
        p_idempotency_key: request.idempotencyKey,
        p_artist_id: request.artistId,
        p_client: {
          full_name: request.fullName.trim(),
          email: request.email.trim(),
          phone: optional(request.phone),
          instagram: optional(request.instagram),
          preferred_contact: optional(request.preferredContact),
          travelling_from: optional(request.travellingFrom),
        },
        p_enquiry: {
          project_type: optional(request.projectType),
          placement: optional(request.placement),
          approximate_size: optional(request.approximateSize),
          cover_up: optional(request.coverUp),
          preferred_timing: optional(request.preferredTiming),
          idea: optional(request.idea),
        },
        p_privacy_acknowledged: request.privacyAcknowledged,
      });

      if (result.error) {
        throw new ApiError(
          friendlyMessage(result.error, 'create that manual enquiry'),
          result.error
        );
      }
      return assertResult(result.data);
    },
  };
}

export type ManualIntakeApi = ReturnType<typeof createManualIntakeApi>;
