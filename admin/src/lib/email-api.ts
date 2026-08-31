// Operator-facing email reads and protected operator writes.
//
// Stored CRM email stays behind Supabase RLS. Live Gmail is different: the
// browser sends its existing Supabase session only to the fixed Gmail Worker
// origin, where the session is re-verified and mapped to one exact enquiry and
// artist before Google is touched. Provider credentials and raw Gmail ids never
// enter this module.
//
// Writes stay behind named RPCs. Approval releases a draft towards the existing
// send pipeline. Dismissal only closes a terminal failed warning; neither path
// provides a direct Gmail send method.

import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { EmailMessage, EmailMessageDetail } from './types';

const LIST_COLUMNS =
  'id, artist_id, status, to_email, subject, created_by_kind, created_at, '
  + 'client_id, enquiry_id, project_id, approved_at, sent_at, failed_at, error_code';
const GMAIL_OPERATOR_ORIGIN = 'https://gmail.vishartattoo.com';

export interface EmailMessageFilter {
  artistId?: string;
  clientId?: string;
  enquiryId?: string;
  limit?: number;
}

export interface LiveGmailMessage {
  from: string;
  to: string;
  subject: string;
  timestamp: string;
  body: string;
  direction: 'inbound' | 'outbound';
  untrusted_content: true;
}

export interface LiveGmailThread {
  thread_context_id: string;
  subject: string;
  message_count: number;
  messages: LiveGmailMessage[];
  untrusted_content: true;
}

export interface LiveGmailHistory {
  enquiry_id: string;
  threads: LiveGmailThread[];
  untrusted_content: true;
}

/**
 * A thread from the client-scoped read.
 *
 * It carries no `thread_context_id`, and that absence is deliberate rather
 * than an omission. A thread context is unique per (artist, enquiry, provider
 * thread), so one can only exist once an enquiry has been chosen. This read
 * chooses none - it exists so an operator can SEE a client's correspondence -
 * and creating contexts from it would bind one Gmail conversation to whichever
 * enquiry happened to be looked at first.
 */
export interface LiveGmailClientThread {
  subject: string;
  message_count: number;
  messages: LiveGmailMessage[];
  untrusted_content: true;
}

export interface LiveGmailClientHistory {
  client_id: string;
  threads: LiveGmailClientThread[];
  untrusted_content: true;
}

/**
 * One known client with recent Gmail activity, as discovery returns it.
 *
 * No provider identifier of any kind, and no message body: discovery answers
 * who has written, not what they wrote. Opening the row reads the client's
 * history through the client-scoped route, which is the one place message
 * content is fetched.
 */
export interface GmailInboxClient {
  client_id: string;
  client_name: string | null;
  subject: string;
  last_message_at: string | null;
  direction: 'inbound' | 'outbound';
  untrusted_content: true;
}

export interface GmailInboxDiscovery {
  artist_id: string;
  clients: GmailInboxClient[];
  untrusted_content: true;
}

export interface LiveGmailOptions {
  threadLimit?: number;
  messageLimit?: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error('gmail_live_invalid_limit');
  }
  return resolved;
}

function validMessage(value: unknown): value is LiveGmailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.from === 'string'
    && typeof row.to === 'string'
    && typeof row.subject === 'string'
    && typeof row.timestamp === 'string'
    && typeof row.body === 'string'
    && (row.direction === 'inbound' || row.direction === 'outbound')
    && row.untrusted_content === true;
}

function validClientThread(value: unknown): value is LiveGmailClientThread {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.subject === 'string'
    && typeof row.message_count === 'number'
    && row.untrusted_content === true
    && Array.isArray(row.messages)
    && row.messages.every(validMessage);
}

function parseClientHistory(value: unknown, clientId: string): LiveGmailClientHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('gmail_live_invalid_response');
  const row = value as Record<string, unknown>;
  if (row.client_id !== clientId || row.untrusted_content !== true
    || !Array.isArray(row.threads) || !row.threads.every(validClientThread)) {
    throw new Error('gmail_live_invalid_response');
  }
  return row as unknown as LiveGmailClientHistory;
}

function validInboxClient(value: unknown): value is GmailInboxClient {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.client_id === 'string'
    && (row.client_name === null || typeof row.client_name === 'string')
    && typeof row.subject === 'string'
    && (row.last_message_at === null || typeof row.last_message_at === 'string')
    && (row.direction === 'inbound' || row.direction === 'outbound')
    && row.untrusted_content === true;
}

function parseInboxDiscovery(value: unknown, artistId: string): GmailInboxDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('gmail_live_invalid_response');
  const row = value as Record<string, unknown>;
  if (row.artist_id !== artistId || row.untrusted_content !== true
    || !Array.isArray(row.clients) || !row.clients.every(validInboxClient)) {
    throw new Error('gmail_live_invalid_response');
  }
  return row as unknown as GmailInboxDiscovery;
}

function validThread(value: unknown): value is LiveGmailThread {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.thread_context_id === 'string'
    && /^[0-9a-f-]{36}$/i.test(row.thread_context_id)
    && typeof row.subject === 'string'
    && Number.isInteger(row.message_count)
    && Array.isArray(row.messages)
    && row.messages.every(validMessage)
    && row.untrusted_content === true;
}

function parseLiveHistory(value: unknown, enquiryId: string): LiveGmailHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('gmail_live_invalid_response');
  const row = value as Record<string, unknown>;
  if (row.enquiry_id !== enquiryId || !Array.isArray(row.threads) || !row.threads.every(validThread) || row.untrusted_content !== true) {
    throw new Error('gmail_live_invalid_response');
  }
  return row as unknown as LiveGmailHistory;
}

export function createEmailApi(client: CrmClient, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return {
    /** Stored email for the operator's reachable artists, newest first. */
    async listEmailMessages(filter: EmailMessageFilter = {}): Promise<EmailMessage[]> {
      let query = client
        .from('email_messages')
        .select(LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(filter.limit ?? 100);
      if (filter.artistId) query = query.eq('artist_id', filter.artistId);
      if (filter.clientId) query = query.eq('client_id', filter.clientId);
      if (filter.enquiryId) query = query.eq('enquiry_id', filter.enquiryId);

      const result = await query;
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load email conversations'), result.error);
      }
      return (result.data ?? []) as EmailMessage[];
    },

    /** One stored CRM message with its body, read only when a thread opens. */
    async getEmailMessage(id: string): Promise<EmailMessageDetail | null> {
      const result = await client
        .from('email_messages')
        .select(`${LIST_COLUMNS}, body`)
        .eq('id', id)
        .maybeSingle();
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load that email'), result.error);
      }
      return (result.data as EmailMessageDetail | null) ?? null;
    },

    /**
     * Read the current mailbox history for one enquiry through the production
     * Gmail gateway. The gateway independently verifies this Supabase session,
     * artist membership and enquiry ownership before reading Gmail.
     */
    async listLiveGmailHistory(enquiryId: string, options: LiveGmailOptions = {}): Promise<LiveGmailHistory> {
      if (!/^[0-9a-f-]{36}$/i.test(enquiryId)) throw new Error('gmail_live_invalid_enquiry');
      const threadLimit = boundedInteger(options.threadLimit, 4, 1, 8);
      const messageLimit = boundedInteger(options.messageLimit, 20, 1, 30);
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error) throw new Error('gmail_live_authentication_required');
      const accessToken = sessionResult.data?.session?.access_token;
      if (typeof accessToken !== 'string' || accessToken.length < 16) {
        throw new Error('gmail_live_authentication_required');
      }

      const url = new URL(`/v1/operator/enquiries/${encodeURIComponent(enquiryId)}/gmail/history`, GMAIL_OPERATOR_ORIGIN);
      url.searchParams.set('thread_limit', String(threadLimit));
      url.searchParams.set('message_limit', String(messageLimit));
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        if (response.ok) throw new Error('gmail_live_invalid_response');
      }
      if (!response.ok) {
        const code = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : null;
        throw new Error(typeof code === 'string' ? code : 'gmail_live_unavailable');
      }
      return parseLiveHistory(payload, enquiryId);
    },

    /**
     * Read one client's current Gmail correspondence, once, through the same
     * gateway.
     *
     * For discovery only, and read-only on both sides: the gateway writes no
     * thread context for this route, so nothing here can bind a Gmail thread to
     * an enquiry. Replying still goes through the enquiry route, which has a
     * real enquiry to bind to, and through draft approval as before.
     *
     * The browser sends only the client id. Artist, mailbox and the client's
     * address are all re-derived server-side from the CRM's own records.
     */
    async listLiveGmailForClient(
      clientId: string,
      options: LiveGmailOptions = {},
    ): Promise<LiveGmailClientHistory> {
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('gmail_live_invalid_client');
      const threadLimit = boundedInteger(options.threadLimit, 4, 1, 8);
      const messageLimit = boundedInteger(options.messageLimit, 20, 1, 30);
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error) throw new Error('gmail_live_authentication_required');
      const accessToken = sessionResult.data?.session?.access_token;
      if (typeof accessToken !== 'string' || accessToken.length < 16) {
        throw new Error('gmail_live_authentication_required');
      }

      const url = new URL(`/v1/operator/clients/${encodeURIComponent(clientId)}/gmail/history`, GMAIL_OPERATOR_ORIGIN);
      url.searchParams.set('thread_limit', String(threadLimit));
      url.searchParams.set('message_limit', String(messageLimit));
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        if (response.ok) throw new Error('gmail_live_invalid_response');
      }
      if (!response.ok) {
        const code = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : null;
        throw new Error(typeof code === 'string' ? code : 'gmail_live_unavailable');
      }
      return parseClientHistory(payload, clientId);
    },

    /**
     * Known clients with recent Gmail activity for one artist.
     *
     * This is what lets a client the studio already knows appear in the Inbox
     * the first time they email, before the CRM has ever written to them - the
     * case stored `email_messages` cannot answer, because there is no row.
     *
     * The gateway resolves every address to a CRM client server-side and
     * returns only the ones it can name, so an unknown sender is not something
     * this screen has to remember to filter: it never arrives.
     */
    async listGmailInboxClients(artistId: string): Promise<GmailInboxDiscovery> {
      if (!/^[0-9a-f-]{36}$/i.test(artistId)) throw new Error('gmail_live_invalid_artist');
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error) throw new Error('gmail_live_authentication_required');
      const accessToken = sessionResult.data?.session?.access_token;
      if (typeof accessToken !== 'string' || accessToken.length < 16) {
        throw new Error('gmail_live_authentication_required');
      }

      const url = new URL(`/v1/operator/artists/${encodeURIComponent(artistId)}/gmail/inbox`, GMAIL_OPERATOR_ORIGIN);
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        if (response.ok) throw new Error('gmail_live_invalid_response');
      }
      if (!response.ok) {
        const code = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : null;
        throw new Error(typeof code === 'string' ? code : 'gmail_live_unavailable');
      }
      return parseInboxDiscovery(payload, artistId);
    },

    /** Release a draft towards the existing send pipeline. */
    async approveEmailDraft(id: string): Promise<void> {
      const result = await client.rpc('approve_email_draft', { p_email_message_id: id });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'approve that email draft'), result.error);
      }
    },

    /** Close a terminal failed-delivery warning without retrying or deleting history. */
    async dismissFailedEmailMessage(id: string): Promise<void> {
      const result = await client.rpc('dismiss_failed_email_message', { p_email_message_id: id });
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'change that status'), result.error);
      }
    },
  };
}

export type EmailApi = ReturnType<typeof createEmailApi>;

export const __testing = Object.freeze({
  GMAIL_OPERATOR_ORIGIN, parseLiveHistory, parseClientHistory, parseInboxDiscovery,
});