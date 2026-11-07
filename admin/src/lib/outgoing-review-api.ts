// No send capability: a read-only AI advisory before a human presses Send.
import type { CrmClient } from './api';

const ORIGIN = 'https://api.vishartattoo.com';
const REVIEW_PATH = '/crm/outgoing-message-review';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['price','date','duration','deposit','location','promise','unverified']);

export interface OutgoingReviewIssue { category: string; message: string }
export interface OutgoingReview { ok: true; issues: OutgoingReviewIssue[] }
export interface ReviewMessageInput {
  conversationId?: string;
  emailMessageId?: string;
  body: string;
}
export function createOutgoingReviewApi(client: CrmClient, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return {
    async reviewOutgoingMessage(input: ReviewMessageInput): Promise<OutgoingReview> {
      const validTarget = (UUID.test(input.conversationId ?? '') && !input.emailMessageId)
        || (UUID.test(input.emailMessageId ?? '') && !input.conversationId);
      if (!validTarget || typeof input.body !== 'string' || !input.body.trim()
        || input.body.length > 6000) throw new Error('review_invalid_message');
      const session = await client.auth.getSession();
      const jwt = session.data?.session?.access_token;
      if (session.error || !jwt) throw new Error('review_authentication_required');
      const response = await fetcher(ORIGIN + REVIEW_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
        body: JSON.stringify({
          ...(input.conversationId ? { conversation_id: input.conversationId } : { email_message_id: input.emailMessageId }),
          body: input.body,
        }),
        cache: 'no-store',
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error('review_unavailable');
      if (!json || json.ok !== true || !Array.isArray(json.issues) || json.issues.length > 4
        || !json.issues.every((item: any) => item && CATEGORIES.has(item.category)
          && typeof item.message === 'string' && item.message.length <= 260))
        throw new Error('review_unavailable');
      return { ok: true, issues: json.issues };
    },
  };
}
export type OutgoingReviewApi = ReturnType<typeof createOutgoingReviewApi>;
