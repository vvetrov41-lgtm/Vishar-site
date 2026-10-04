import type { CrmClient } from './api';

export const AI_FIELD_NAMES = [
  'client_name', 'email', 'phone', 'project_description', 'concept', 'placement',
  'style', 'approximate_size', 'colour', 'cover_up', 'budget', 'preferred_dates',
  'reference_images_present', 'discovery_source', 'discovery_source_detail', 'notes',
] as const;
export type AiFieldName = typeof AI_FIELD_NAMES[number];
export interface AiField {
  value: string | boolean | null;
  status: 'explicit' | 'inferred' | 'missing';
}
export interface AiReplyDraft {
  id: string;
  body: string;
  subject: string;
  status: string;
  updated_at: string;
}
export interface EnquiryAiResult {
  status: 'not_requested' | 'pending' | 'processing' | 'succeeded' | 'failed' | 'stale';
  enabled: boolean;
  result?: {
    fields: Record<AiFieldName, AiField>;
    summary: string;
    missing_information: AiFieldName[];
    draft_reply: string;
  } | null;
  draft?: AiReplyDraft | null;
}

/**
 * The read-only Five Pillars projection used by operator surfaces.
 *
 * This is deliberately separate from EnquiryAiResult. Reading it never queues,
 * retries or invokes a model: the server only returns derived state that already
 * exists for this artist/client relationship.
 */
export type ClientAiState =
  | {
      status: 'not_generated';
      enabled: boolean;
    }
  | {
      status: 'ready';
      enabled: boolean;
      summary: string;
      is_stale: boolean;
    };

/**
 * Manual Russian translation of the client's enquiry text. The original text
 * stays the source of truth; a translation is cached per exact source text.
 */
export type EnquiryTranslationStatus =
  | 'none' | 'pending' | 'processing' | 'succeeded' | 'failed' | 'nothing_to_translate' | 'too_long';
export interface EnquiryTranslation {
  status: EnquiryTranslationStatus;
  job_id?: string;
  translation?: string | null;
  model?: string | null;
  translated_at?: string | null;
  error_code?: string | null;
}

/** The TattooAI Worker that runs a translation job. It never returns text. */
export const TRANSLATION_ORIGIN = 'https://api.vishartattoo.com';
const TRANSLATION_STATUSES: EnquiryTranslationStatus[] = [
  'none', 'pending', 'processing', 'succeeded', 'failed', 'nothing_to_translate', 'too_long',
];

function parseTranslation(value: unknown): EnquiryTranslation {
  if (!isObject(value) || !TRANSLATION_STATUSES.includes(value.status as EnquiryTranslationStatus)) {
    throw new Error('translation_unavailable');
  }
  if (value.status === 'succeeded' && (typeof value.translation !== 'string' || !value.translation.trim())) {
    throw new Error('translation_unavailable');
  }
  if (value.job_id !== undefined && (typeof value.job_id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.job_id))) {
    throw new Error('translation_unavailable');
  }
  return value as unknown as EnquiryTranslation;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseResult(value: unknown): EnquiryAiResult {
  if (!isObject(value) || !['not_requested', 'pending', 'processing', 'succeeded', 'failed', 'stale'].includes(String(value.status))
    || typeof value.enabled !== 'boolean') throw new Error('ai_result_unavailable');
  if (value.result != null) {
    const result = value.result;
    if (!isObject(result) || !isObject(result.fields) || typeof result.summary !== 'string'
      || typeof result.draft_reply !== 'string' || !Array.isArray(result.missing_information)
      || !result.missing_information.every((key) => AI_FIELD_NAMES.includes(key as AiFieldName))) {
      throw new Error('ai_result_unavailable');
    }
    for (const name of AI_FIELD_NAMES) {
      const field = result.fields[name];
      if (!isObject(field) || !['explicit', 'inferred', 'missing'].includes(String(field.status))
        || (field.value !== null && typeof field.value !== 'string' && typeof field.value !== 'boolean')) {
        throw new Error('ai_result_unavailable');
      }
    }
  }
  if (value.draft != null) parseDraft(value.draft);
  return value as unknown as EnquiryAiResult;
}

function parseClientAiState(value: unknown): ClientAiState {
  if (!isObject(value) || !['ready', 'not_generated'].includes(String(value.status))
    || typeof value.enabled !== 'boolean') {
    throw new Error('client_ai_state_unavailable');
  }
  if (value.status === 'not_generated') {
    return { status: 'not_generated', enabled: value.enabled };
  }
  if (typeof value.summary !== 'string' || !value.summary.trim() || typeof value.is_stale !== 'boolean') {
    throw new Error('client_ai_state_unavailable');
  }
  return {
    status: 'ready',
    enabled: value.enabled,
    summary: value.summary.trim(),
    is_stale: value.is_stale,
  };
}

function parseDraft(value: unknown): AiReplyDraft {
  if (!isObject(value) || !['id', 'body', 'subject', 'status', 'updated_at'].every((key) => typeof value[key] === 'string')
    || !Number.isFinite(Date.parse(String(value.updated_at)))) throw new Error('ai_draft_unavailable');
  return value as unknown as AiReplyDraft;
}

/** The browser supplies a record and optimistic version, never an artist or model-selected action. */
export function createAiIntakeApi(client: CrmClient) {
  return {
    async getEnquiryAiResult(enquiryId: string): Promise<EnquiryAiResult> {
      const response = await client.rpc('get_enquiry_ai_result', { p_enquiry_id: enquiryId });
      if (response.error) throw new Error('ai_result_unavailable');
      return parseResult(response.data);
    },
    async getClientAiState(artistId: string, clientId: string): Promise<ClientAiState> {
      const response = await client.rpc('get_client_ai_state', {
        p_artist_id: artistId,
        p_client_id: clientId,
      });
      if (response.error) throw new Error('client_ai_state_unavailable');
      return parseClientAiState(response.data);
    },
    async retryEnquiryAi(enquiryId: string): Promise<EnquiryAiResult> {
      const response = await client.rpc('retry_enquiry_ai', { p_enquiry_id: enquiryId });
      if (response.error) throw new Error('ai_retry_unavailable');
      return parseResult(response.data);
    },
    async requestEnquiryTranslation(enquiryId: string): Promise<EnquiryTranslation> {
      const response = await client.rpc('request_enquiry_translation', { p_enquiry_id: enquiryId, p_target_language: 'ru' });
      if (response.error) throw new Error('translation_unavailable');
      return parseTranslation(response.data);
    },
    async getEnquiryTranslation(enquiryId: string): Promise<EnquiryTranslation> {
      const response = await client.rpc('get_enquiry_translation', { p_enquiry_id: enquiryId, p_target_language: 'ru' });
      if (response.error) throw new Error('translation_unavailable');
      return parseTranslation(response.data);
    },
    /** Asks the Worker to run one job. The text is read back through getEnquiryTranslation. */
    async runEnquiryTranslation(jobId: string): Promise<void> {
      if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('translation_unavailable');
      await fetch(`${TRANSLATION_ORIGIN}/crm/enquiry-translations/${jobId}`, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      });
    },
    async editEmailDraft(draft: Pick<AiReplyDraft, 'id' | 'updated_at'>, body: string): Promise<AiReplyDraft> {
      if (!body.trim() || body.length > 12000 || !draft.updated_at) throw new Error('ai_draft_invalid');
      const response = await client.rpc('edit_email_draft', {
        p_message_id: draft.id, p_body: body, p_expected_updated_at: draft.updated_at,
      });
      // Do not surface raw database/provider errors, which can include private input.
      if (response.error) throw new Error('ai_draft_save_failed');
      return parseDraft(response.data);
    },
  };
}
export type AiIntakeApi = ReturnType<typeof createAiIntakeApi>;
