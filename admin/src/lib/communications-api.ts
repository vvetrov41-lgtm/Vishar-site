// Communications inbox client.
//
// Every conversation, message and operator action is reached through the
// artist-scoped RPCs and the row level security on the neutral core. Nothing
// here asserts an artist, a provider account or a recipient: the browser names
// a conversation, and the database resolves everything else from it.

import { ApiError, type CrmClient } from './api';

export type CommunicationChannel = 'whatsapp' | 'instagram';
export type CommunicationDirection = 'inbound' | 'outbound';
export type CommunicationOrigin = 'contact' | 'crm' | 'provider_app' | 'automation';
export type CommunicationStatus =
  | 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type CommunicationLinkState = 'unmatched' | 'linked';
export type CommunicationConversationState = 'open' | 'archived';

export interface ConversationSummary {
  id: string;
  artist_id: string;
  channel: CommunicationChannel;
  link_state: CommunicationLinkState;
  state: CommunicationConversationState;
  client_id: string | null;
  client_name: string | null;
  enquiry_id: string | null;
  external_username: string | null;
  external_display_label: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  operator_read_at: string | null;
  has_unread: boolean;
  latest_preview: string | null;
  latest_direction: CommunicationDirection | null;
  latest_message_type: string | null;
}

export interface ConversationDetail {
  id: string;
  artist_id: string;
  channel: CommunicationChannel;
  link_state: CommunicationLinkState;
  state: CommunicationConversationState;
  client_id: string | null;
  enquiry_id: string | null;
  external_username: string | null;
  external_display_label: string | null;
  last_message_at: string | null;
}

/**
 * A client's own conversations, whatever channel they arrived on.
 *
 * The inbox RPC is keyset-paginated across every conversation the operator can
 * reach, which answers "who is waiting?" but not "what has this client said?".
 * Reading the conversation rows for one client directly is the same row level
 * security boundary the RPC enforces (`can_access_artist`), scoped by client
 * instead of by page, so the client workspace needs no new database surface.
 */
export interface ClientConversation {
  id: string;
  artist_id: string;
  channel: CommunicationChannel;
  link_state: CommunicationLinkState;
  state: CommunicationConversationState;
  client_id: string | null;
  enquiry_id: string | null;
  external_username: string | null;
  external_display_label: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  operator_read_at: string | null;
}

export interface ConversationMessage {
  id: string;
  direction: CommunicationDirection;
  origin: CommunicationOrigin;
  status: CommunicationStatus;
  message_type: string;
  body: string | null;
  attachments: { type: string }[];
  created_at: string;
  error_code: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The inbox renders provider-shaped values, so every row is checked before it
 * is trusted enough to put on screen. A malformed row is a bug worth surfacing,
 * not something to render half of.
 */
function assertConversations(value: unknown): ConversationSummary[] {
  if (!Array.isArray(value)) throw new ApiError('Could not load the inbox.');
  return value.map((row: any) => {
    if (
      !row
      || typeof row !== 'object'
      || !UUID.test(row.id ?? '')
      || !UUID.test(row.artist_id ?? '')
      || (row.channel !== 'whatsapp' && row.channel !== 'instagram')
      || (row.link_state !== 'linked' && row.link_state !== 'unmatched')
      || (row.state !== 'open' && row.state !== 'archived')
      || typeof row.has_unread !== 'boolean'
    ) {
      throw new ApiError('Could not load the inbox.');
    }
    return row as ConversationSummary;
  });
}

/**
 * "Who is waiting on me?"
 *
 * Unread and needing a reply are different questions, and the inbox only
 * answered the first. Opening a conversation marks it read, so a thread the
 * operator looked at and did not answer stopped being unread while the client
 * carried on waiting. Needing a reply means the client spoke last, whatever
 * anyone has read.
 *
 * The two overloads exist because the two reads carry different evidence for
 * the same fact: the inbox projection knows the direction of the newest
 * message, and a conversation row knows when each side last spoke.
 */
export function conversationNeedsReply(
  conversation: Pick<ConversationSummary, 'state' | 'latest_direction'>,
): boolean {
  return conversation.state === 'open' && conversation.latest_direction === 'inbound';
}

export function clientConversationNeedsReply(
  conversation: Pick<ClientConversation, 'state' | 'last_inbound_at' | 'last_outbound_at'>,
): boolean {
  if (conversation.state !== 'open') return false;
  const inbound = conversation.last_inbound_at ? Date.parse(conversation.last_inbound_at) : Number.NaN;
  if (Number.isNaN(inbound)) return false;
  const outbound = conversation.last_outbound_at ? Date.parse(conversation.last_outbound_at) : Number.NaN;
  return Number.isNaN(outbound) || outbound < inbound;
}

/**
 * A participant label the operator can recognise.
 *
 * A linked conversation shows the client. An unmatched one shows the provider
 * handle when the connector has learned it, and otherwise says plainly that
 * the sender is unknown rather than showing a raw provider identifier.
 */
export function participantLabel(
  conversation: Pick<
    ConversationSummary,
    'client_name' | 'external_username' | 'external_display_label' | 'channel'
  >,
  unknownLabel: string,
): string {
  if (conversation.client_name) return conversation.client_name;
  if (conversation.external_display_label) return conversation.external_display_label;
  if (conversation.external_username) {
    return conversation.channel === 'instagram'
      ? `@${conversation.external_username}`
      : conversation.external_username;
  }
  return unknownLabel;
}

export function createCommunicationsApi(client: CrmClient) {
  return {
    async listConversations(filter: {
      channel?: CommunicationChannel;
      linkState?: CommunicationLinkState;
      limit?: number;
      before?: string;
    } = {}): Promise<ConversationSummary[]> {
      const result = await client.rpc('list_communication_conversations', {
        p_channel: filter.channel ?? null,
        p_link_state: filter.linkState ?? null,
        p_limit: filter.limit ?? 30,
        p_before: filter.before ?? null,
      });
      if (result.error) throw new ApiError('Could not load the inbox.', result.error);
      return assertConversations(result.data ?? []);
    },

    async getConversation(conversationId: string): Promise<ConversationDetail | null> {
      const result = await client
        .from('communication_conversations')
        .select(
          'id, artist_id, channel, link_state, state, client_id, enquiry_id, '
          + 'external_username, external_display_label, last_message_at',
        )
        .eq('id', conversationId)
        .maybeSingle();
      if (result.error) throw new ApiError('Could not load that conversation.', result.error);
      return (result.data as ConversationDetail | null) ?? null;
    },

    /**
     * Conversations belonging to one client, newest activity first.
     *
     * Bounded deliberately: a client workspace shows recent threads, not an
     * archive. Rows carry no message body — the preview is fetched per thread
     * only where one is actually rendered.
     */
    async listConversationsForClient(clientId: string, limit = 10): Promise<ClientConversation[]> {
      const result = await client
        .from('communication_conversations')
        .select(
          'id, artist_id, channel, link_state, state, client_id, enquiry_id, '
          + 'external_username, external_display_label, last_message_at, '
          + 'last_inbound_at, last_outbound_at, operator_read_at',
        )
        .eq('client_id', clientId)
        .order('last_message_at', { ascending: false })
        .limit(limit);
      if (result.error) throw new ApiError('Could not load that client\'s conversations.', result.error);
      return (result.data ?? []) as ClientConversation[];
    },

    // History is loaded per conversation and bounded. The inbox never pulls
    // message bodies for every row in the list.
    async listMessages(conversationId: string, limit = 100): Promise<ConversationMessage[]> {
      const result = await client
        .from('communication_messages')
        .select('id, direction, origin, status, message_type, body, attachments, created_at, error_code')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (result.error) throw new ApiError('Could not load those messages.', result.error);
      return (result.data ?? []) as ConversationMessage[];
    },

    async sendReply(conversationId: string, body: string, requestId: string) {
      const result = await client.rpc('queue_communication_message', {
        p_conversation_id: conversationId,
        p_body: body,
        p_request_id: requestId,
      });
      if (result.error) throw new ApiError('Could not queue that reply.', result.error);
      return result.data;
    },

    async markRead(conversationId: string) {
      const result = await client.rpc('mark_communication_conversation_read', {
        p_conversation_id: conversationId,
      });
      if (result.error) throw new ApiError('Could not update that conversation.', result.error);
      return result.data;
    },

    async setState(conversationId: string, state: CommunicationConversationState) {
      const result = await client.rpc('set_communication_conversation_state', {
        p_conversation_id: conversationId,
        p_state: state,
      });
      if (result.error) throw new ApiError('Could not update that conversation.', result.error);
      return result.data;
    },

    async linkClient(conversationId: string, clientId: string) {
      const result = await client.rpc('link_communication_conversation_client', {
        p_conversation_id: conversationId,
        p_client_id: clientId,
      });
      if (result.error) throw new ApiError('Could not link that client.', result.error);
      return result.data;
    },

    async createClient(conversationId: string, details: {
      fullName: string;
      email?: string;
      phone?: string;
      instagram?: string;
    }) {
      const result = await client.rpc('create_client_from_communication', {
        p_conversation_id: conversationId,
        p_full_name: details.fullName,
        p_email: details.email || null,
        p_phone: details.phone || null,
        p_instagram: details.instagram || null,
      });
      if (result.error) throw new ApiError('Could not create that client.', result.error);
      return result.data;
    },

    async createEnquiry(conversationId: string, payload: {
      idempotencyKey: string;
      client: Record<string, unknown>;
      enquiry: Record<string, unknown>;
      privacyAcknowledged: boolean;
    }) {
      const result = await client.rpc('create_enquiry_from_communication', {
        p_conversation_id: conversationId,
        p_idempotency_key: payload.idempotencyKey,
        p_client: payload.client,
        p_enquiry: payload.enquiry,
        p_privacy_acknowledged: payload.privacyAcknowledged,
      });
      if (result.error) throw new ApiError('Could not create that enquiry.', result.error);
      return result.data;
    },
  };
}

export type CommunicationsApi = ReturnType<typeof createCommunicationsApi>;
