// Healing question and Google review request suggestions on Today.
//
// The database owns every rule: which visits are suggested, the approved
// WhatsApp template, the 24-hour window, suppression and per-artist access
// (supabase/migrations/20261118230000_review_request_suggestions.sql,
// 20261119120000_send_healing_question.sql and
// 20261119130000_review_request_followups.sql). The browser only shows the
// suggestion and sends the artist's decision with an operation id, so a
// double press or a retry after a dropped connection records one decision.
// Nothing here sends a message without the artist pressing a button.

import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { ApiOperation } from './api-errors';

export type ReviewChannel = 'whatsapp' | 'instagram' | 'email';
export interface ReviewChannelOption { channel: ReviewChannel; available: boolean; reason: string | null }

export interface HealingSuggestion {
  client_id: string;
  client_name: string;
  anchor_session_id: string;
  project_id: string | null;
  project_title: string | null;
  last_session_at: string;
  days_since: number;
  draft_message: string;
  channels?: ReviewChannelOption[];
}

export interface ReviewFollowup {
  review_request_id: string;
  client_id: string;
  client_name: string;
  anchor_session_id: string;
  healing_asked_at: string;
  healing_message_status: string | null;
  conversation_id: string | null;
  status: 'awaiting_reply' | 'replied';
  replied_at: string | null;
  reply_message_id: string | null;
  reply_text: string | null;
  reply_attachment_count: number;
  draft_message: string | null;
  channels?: ReviewChannelOption[];
  healing_channel?: ReviewChannel;
}

export interface ReviewSuggestions {
  artist_id: string;
  review_url_configured: boolean;
  suggestions: HealingSuggestion[];
}

export interface ReviewFollowups {
  artist_id: string;
  review_url_configured: boolean;
  items: ReviewFollowup[];
}

/** Why the CRM refused a decision, in words the section can translate. */
export type ReviewRefusal =
  | 'not_suggested'
  | 'already_decided'
  | 'template_not_ready'
  | 'no_whatsapp'
  | 'not_reachable'
  | 'name_unusable'
  | 'no_review_link'
  | 'no_reply'
  | 'window_closed'
  | 'channel_unavailable'
  | 'invalid'
  | 'permission'
  | 'unavailable'
  | 'unknown';

export class ReviewRequestError extends ApiError {
  constructor(message: string, public readonly refusal: ReviewRefusal, cause?: unknown) {
    super(message, cause);
    this.name = 'ReviewRequestError';
  }
}

export function classifyReviewError(error: unknown): ReviewRefusal {
  const code = readString(error, 'code');
  const message = readString(error, 'message').toLowerCase();
  if (code === 'PGRST202' || code === '42883') return 'unavailable';
  if (code === '42501' || code === 'PGRST301') return 'permission';
  if (message.includes('not a current healing suggestion')) return 'not_suggested';
  if (message.includes('already sent') || message.includes('already decided')) return 'already_decided';
  if (message.includes('template is not approved')) return 'template_not_ready';
  if (message.includes('no open whatsapp conversation') || message.includes('whatsapp is not connected')) return 'no_whatsapp';
  if (message.includes('does not accept') || message.includes('client is not available')) return 'not_reachable';
  if (message.includes('first name is not usable')) return 'name_unusable';
  if (message.includes('no google review link')) return 'no_review_link';
  if (message.includes('has not replied')) return 'no_reply';
  if (message.includes('selected channel is unavailable')) return 'channel_unavailable';
  if (message.includes('free-form window is closed')) return 'window_closed';
  if (code === '22023' || code === '23514') return 'invalid';
  return 'unknown';
}

function readString(error: unknown, key: 'code' | 'message'): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function createReviewRequestsApi(client: CrmClient) {
  async function call<T>(name: string, args: Record<string, unknown>, what: ApiOperation): Promise<T> {
    const result = await client.rpc(name, args);
    if (result.error) {
      throw new ReviewRequestError(friendlyMessage(result.error, what), classifyReviewError(result.error), result.error);
    }
    return result.data as T;
  }

  return {
    async listReviewSuggestions(artistId: string): Promise<ReviewSuggestions> {
      const data = await call<any>('list_review_suggestions', { p_artist_id: artistId }, 'load healing and review suggestions');
      return {
        artist_id: artistId,
        review_url_configured: data?.review_url_configured === true,
        suggestions: list<HealingSuggestion>(data?.suggestions),
      };
    },

    async listReviewFollowups(artistId: string): Promise<ReviewFollowups> {
      const data = await call<any>('list_review_followups', { p_artist_id: artistId }, 'load healing and review suggestions');
      return {
        artist_id: artistId,
        review_url_configured: data?.review_url_configured === true,
        items: list<ReviewFollowup>(data?.items),
      };
    },

    /** "Ask": queues the approved healing-question template on WhatsApp. */
    async sendHealingQuestion(artistId: string, anchorSessionId: string, operationId: string, channel?: ReviewChannel): Promise<void> {
      await call(channel ? 'send_healing_question_v2' : 'send_healing_question', {
        p_artist_id: artistId,
        p_anchor_session_id: anchorSessionId,
        p_operation_id: operationId,
        ...(channel ? { p_channel: channel } : {}),
      }, 'send that healing question');
    },

    /** "Later" hides the suggestion for `days`; "don't ask" hides it for this visit. */
    async decideHealingSuggestion(
      artistId: string,
      anchorSessionId: string,
      action: 'snooze' | 'dismiss',
      operationId: string,
      snoozeDays = 14,
    ): Promise<void> {
      await call('act_on_review_suggestion', {
        p_artist_id: artistId,
        p_anchor_session_id: anchorSessionId,
        p_action: action,
        p_operation_id: operationId,
        p_snooze_days: snoozeDays,
      }, 'postpone that healing question');
    },

    /** Sends the artist's edited review request inside the WhatsApp window. */
    async askForReview(artistId: string, reviewRequestId: string, body: string, operationId: string, channel?: ReviewChannel): Promise<void> {
      await call(channel ? 'ask_for_review_v2' : 'ask_for_review', {
        p_artist_id: artistId,
        p_review_request_id: reviewRequestId,
        p_operation_id: operationId,
        p_body: body,
        ...(channel ? { p_channel: channel } : {}),
      }, 'ask for that review');
    },

    async closeReviewRequest(artistId: string, reviewRequestId: string, operationId: string): Promise<void> {
      await call('close_review_request', {
        p_artist_id: artistId,
        p_review_request_id: reviewRequestId,
        p_operation_id: operationId,
      }, 'close that review request');
    },
  };
}

export type ReviewRequestsApi = ReturnType<typeof createReviewRequestsApi>;
