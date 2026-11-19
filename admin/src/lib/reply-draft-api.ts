// "Suggest reply" (specs/reply-drafts). The Worker returns one draft for the
// composer. Nothing is queued or sent here: the artist edits the text and
// presses the existing Send, which still runs the pre-send review.
import type { CrmClient } from './api';

const ORIGIN = 'https://api.vishartattoo.com';
const PATH = '/crm/reply-draft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRAFT = 800;

export type ReplyDraftFailure =
  | 'window_closed'
  | 'nothing_to_answer'
  | 'access_denied'
  | 'unavailable';

export class ReplyDraftError extends Error {
  constructor(readonly reason: ReplyDraftFailure) { super(reason); }
}

const FAILURES: Record<string, ReplyDraftFailure> = {
  whatsapp_window_closed: 'window_closed',
  nothing_to_answer: 'nothing_to_answer',
  access_denied: 'access_denied',
};

export function createReplyDraftApi(
  client: CrmClient,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  return {
    /**
     * Whether the Worker serves drafts. The route answers 404 without CORS
     * headers while REPLY_DRAFTS_ENABLED is off, so the browser rejects the
     * request and the button stays hidden. No token, no conversation data.
     */
    async replyDraftsAvailable(): Promise<boolean> {
      try {
        const response = await fetcher(ORIGIN + PATH, { method: 'OPTIONS', cache: 'no-store' });
        return response.ok;
      } catch {
        return false;
      }
    },

    async suggestReply(conversationId: string): Promise<string> {
      if (!UUID.test(conversationId)) throw new ReplyDraftError('unavailable');
      const session = await client.auth.getSession();
      const jwt = session.data?.session?.access_token;
      if (session.error || !jwt) throw new ReplyDraftError('access_denied');
      let response: Response;
      try {
        response = await fetcher(ORIGIN + PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
          body: JSON.stringify({ conversation_id: conversationId }),
          cache: 'no-store',
        });
      } catch {
        throw new ReplyDraftError('unavailable');
      }
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        const code = json && typeof json.error === 'string' ? json.error : '';
        throw new ReplyDraftError(FAILURES[code] ?? 'unavailable');
      }
      if (!json || json.ok !== true || typeof json.draft !== 'string'
        || !json.draft.trim() || json.draft.length > MAX_DRAFT) throw new ReplyDraftError('unavailable');
      return json.draft;
    },
  };
}
export type ReplyDraftApi = ReturnType<typeof createReplyDraftApi>;
