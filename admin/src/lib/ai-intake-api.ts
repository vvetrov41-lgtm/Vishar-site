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
    async retryEnquiryAi(enquiryId: string): Promise<EnquiryAiResult> {
      const response = await client.rpc('retry_enquiry_ai', { p_enquiry_id: enquiryId });
      if (response.error) throw new Error('ai_retry_unavailable');
      return parseResult(response.data);
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
