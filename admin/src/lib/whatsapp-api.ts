// WhatsApp conversation reads and the CRM send.
//
// Reads come back already filtered by row level security, so a member of one
// artist simply does not see the other artist's conversations. The send is a
// named RPC that takes a conversation the CRM already owns — never a phone
// number — so a browser cannot address an arbitrary destination, choose an
// artist or select a provider account.
//
// No Meta credential exists in this layer. The browser never sees an access
// token, an app secret or a phone number id.

import { ApiError, friendlyMessage, type CrmClient } from './api';

/**
 * Mirrors the private helper in `api.ts`: a Supabase RLS denial arrives as an
 * ordinary error, and its raw text would leak schema detail to the screen.
 */
function unwrap<T>(result: { data: T | null; error: unknown }, what: string): T {
  if (result.error) {
    throw new ApiError(friendlyMessage(result.error, what), result.error);
  }
  return result.data as T;
}

export type WhatsappDirection = 'inbound' | 'outbound';
export type WhatsappOrigin = 'contact' | 'crm' | 'business_app' | 'automation';
export type WhatsappStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsappConversation {
  id: string;
  artist_id: string;
  client_id: string | null;
  contact_wa_id: string;
  contact_label: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
}

export interface WhatsappMessage {
  id: string;
  conversation_id: string;
  direction: WhatsappDirection;
  origin: WhatsappOrigin;
  status: WhatsappStatus;
  message_type: string;
  body: string | null;
  provider_timestamp: string | null;
  error_code: string | null;
  created_at: string;
}

export interface WhatsappSendResult {
  message_id: string;
  conversation_id: string;
  status: string;
  replayed: boolean;
}

const MAX_BODY_LENGTH = 4096;

/**
 * Meta's 24-hour customer service window. Outside it a free-form reply is
 * refused by Meta and an approved template is required, which this CRM does
 * not send yet — so the composer says so rather than letting a reply fail at
 * the provider.
 */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinCustomerServiceWindow(
  lastInboundAt: string | null,
  now: number = Date.now()
): boolean {
  if (!lastInboundAt) return false;
  const parsed = Date.parse(lastInboundAt);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed < CUSTOMER_SERVICE_WINDOW_MS;
}

/**
 * A contact identifier is displayed, never used for routing. It is masked so a
 * shoulder-surfed CRM screen does not expose a client's full number.
 */
export function maskContact(contactWaId: string): string {
  if (!/^[0-9]{6,20}$/.test(contactWaId)) return '—';
  return `+${contactWaId.slice(0, 2)} ••• ${contactWaId.slice(-4)}`;
}

export function conversationTitle(conversation: WhatsappConversation): string {
  return conversation.contact_label?.trim() || maskContact(conversation.contact_wa_id);
}

export interface WhatsappApi {
  listWhatsappConversations(artistId?: string | null): Promise<WhatsappConversation[]>;
  getWhatsappConversation(conversationId: string): Promise<WhatsappConversation | null>;
  listWhatsappMessages(conversationId: string): Promise<WhatsappMessage[]>;
  sendWhatsappMessage(conversationId: string, body: string): Promise<WhatsappSendResult>;
}

export function createWhatsappApi(client: CrmClient): WhatsappApi {
  return {
    async listWhatsappConversations(artistId?: string | null) {
      let query = client
        .from('whatsapp_conversations')
        .select('id, artist_id, client_id, contact_wa_id, contact_label, last_message_at, last_inbound_at')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(100);
      if (artistId) query = query.eq('artist_id', artistId);
      const result = await query;
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load WhatsApp conversations'), result.error);
      }
      return (result.data ?? []) as WhatsappConversation[];
    },

    async getWhatsappConversation(conversationId: string) {
      const result = await client
        .from('whatsapp_conversations')
        .select('id, artist_id, client_id, contact_wa_id, contact_label, last_message_at, last_inbound_at')
        .eq('id', conversationId)
        .maybeSingle();
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load that WhatsApp conversation'), result.error);
      }
      return (result.data ?? null) as WhatsappConversation | null;
    },

    async listWhatsappMessages(conversationId: string) {
      const result = await client
        .from('whatsapp_messages')
        .select('id, conversation_id, direction, origin, status, message_type, body, provider_timestamp, error_code, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (result.error) {
        throw new ApiError(friendlyMessage(result.error, 'load that WhatsApp conversation'), result.error);
      }
      return (result.data ?? []) as WhatsappMessage[];
    },

    async sendWhatsappMessage(conversationId: string, body: string) {
      const trimmed = body.trim();
      if (!trimmed) throw new ApiError('Write a message before sending.');
      if (trimmed.length > MAX_BODY_LENGTH) {
        throw new ApiError('That message is too long for WhatsApp.');
      }
      // A fresh request id per send. Retrying the same id is idempotent in the
      // database, so an interrupted click cannot send the client two messages.
      const requestId = crypto.randomUUID();
      return unwrap(
        await client.rpc('queue_whatsapp_message', {
          p_conversation_id: conversationId,
          p_body: trimmed,
          p_request_id: requestId,
        }),
        'send that WhatsApp message'
      ) as WhatsappSendResult;
    },
  };
}

export const __testing = { MAX_BODY_LENGTH };
