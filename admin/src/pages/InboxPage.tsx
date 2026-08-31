// The unified inbox.
//
// One list for every channel, because an operator thinks in conversations
// rather than in providers. The channel is a filter and a badge, not a
// separate screen.
//
// Email joins on the same shelf but keeps its own semantics. Messaging
// channels know who spoke last; email does not, because the CRM stores no
// inbound mail (see lib/email-threads.ts). So an email row waits on the
// operator for a different, equally real reason: a draft nobody approved, or a
// send that failed. The row says which.
//
// The list is deliberately thin: a label, a channel, a preview, a time and why
// it is waiting. Message history and email bodies load only when a row is
// opened, so an artist with a busy account does not pay for it on every render.

import { useMemo, useState } from 'react';
import './Inbox.css';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import {
  participantLabel,
  type CommunicationLinkState,
  type ConversationSummary,
} from '../lib/communications-api';
import { groupEmailThreads } from '../lib/email-threads';
import {
  conversationItem,
  emailItem,
  isWaiting,
  mergeInbox,
  type InboxChannel,
  type InboxItem,
} from '../lib/inbox-items';
import type { Client, EmailMessage } from '../lib/types';

const COPY = {
  en: {
    title: 'Communications',
    all: 'All',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    email: 'Email',
    everyone: 'Everyone',
    needsReply: 'Needs reply',
    unmatched: 'Unmatched',
    linked: 'Linked clients',
    loading: 'Loading conversations…',
    empty: 'No conversations yet',
    emptyHint: 'Messages appear here as soon as a connected channel receives one.',
    emptyFiltered: 'Nothing matches this filter',
    emptyFilteredHint: 'Try All, or clear the filter.',
    nobodyWaiting: 'Nobody is waiting on you',
    nobodyWaitingHint: 'No unanswered message, no draft waiting for approval, no failed send.',
    unknownSender: 'Unknown sender',
    needsAttention: 'Unread',
    awaitingReply: 'Needs reply',
    draftWaiting: 'Draft to approve',
    sendFailed: 'Send failed',
    youRepliedLast: 'You replied last',
    notLinked: 'Not linked',
    archived: 'Archived',
    noPreview: 'No message yet',
    noSubject: 'No subject',
    attachment: 'Attachment',
    emailUnavailable: 'Email conversations could not be loaded.',
  },
  ru: {
    title: 'Сообщения',
    all: 'Все',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    email: 'Почта',
    everyone: 'Все',
    needsReply: 'Ждут ответа',
    unmatched: 'Без клиента',
    linked: 'С клиентом',
    loading: 'Загружаем диалоги…',
    empty: 'Диалогов пока нет',
    emptyHint: 'Сообщения появятся здесь, как только подключённый канал что-то получит.',
    emptyFiltered: 'Ничего не найдено по этому фильтру',
    emptyFilteredHint: 'Попробуйте «Все» или снимите фильтр.',
    nobodyWaiting: 'Вас никто не ждёт',
    nobodyWaitingHint: 'Нет неотвеченных сообщений, писем на утверждение и неудачных отправок.',
    unknownSender: 'Неизвестный отправитель',
    needsAttention: 'Не прочитано',
    awaitingReply: 'Ждёт ответа',
    draftWaiting: 'Письмо на утверждение',
    sendFailed: 'Письмо не отправлено',
    youRepliedLast: 'Вы ответили последним',
    notLinked: 'Без клиента',
    archived: 'В архиве',
    noPreview: 'Сообщений пока нет',
    noSubject: 'Без темы',
    attachment: 'Вложение',
    emailUnavailable: 'Не удалось загрузить переписку по почте.',
  },
} as const;

type ChannelFilter = '' | InboxChannel;

/**
 * "Who needs a reply?" is the question the operator actually opens this screen
 * with, so it is a view of its own rather than something to work out from the
 * unread badges. The other two views are about the record rather than the
 * person, and stay available behind it.
 *
 * Link state is a messaging idea, so choosing it also narrows the list to
 * messaging channels rather than silently dropping every email row.
 */
type ViewFilter = '' | 'needs_reply' | CommunicationLinkState;

interface InboxData {
  conversations: ConversationSummary[];
  items: InboxItem[];
  /** Email failing must not empty the Inbox; it degrades to a quiet notice. */
  emailFailed: boolean;
}

export function InboxPage() {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const { selectedArtistId } = useArtistScope();
  const [channel, setChannel] = useState<ChannelFilter>('');
  const [view, setView] = useState<ViewFilter>('');

  // Needs-reply is decided from the newest message's direction, which the
  // projection already carries, so it is applied here rather than asked of the
  // server. Link state is a server filter because the database indexes it.
  const linkState: CommunicationLinkState | undefined = view === 'unmatched' || view === 'linked'
    ? view
    : undefined;

  const { data, loading, error, reload } = useAsync<InboxData>(
    async () => {
      const conversations = await api.listConversations({
        channel: channel === 'whatsapp' || channel === 'instagram' ? channel : undefined,
        linkState,
        limit: 50,
      });

      // A Gmail outage, a revoked integration or a policy change must not take
      // the whole work queue with it. Messaging is the load-bearing half of
      // this screen; email is additive, so its failure is a notice.
      let emails: EmailMessage[] = [];
      let emailFailed = false;
      if (!linkState) {
        try {
          emails = await api.listEmailMessages({
            artistId: selectedArtistId ?? undefined,
            limit: 200,
          });
        } catch {
          emailFailed = true;
        }
      }

      const threads = groupEmailThreads(emails);
      const clientIds = [
        ...new Set(threads.map((thread) => thread.client_id).filter((id): id is string => Boolean(id))),
      ];
      // One lookup for every email row, rather than one per row. An email
      // addressed to somebody with no client card still renders - by address -
      // rather than disappearing from the queue.
      let clients: Client[] = [];
      if (clientIds.length > 0) {
        clients = await api.listClientsByIds(clientIds).catch(() => []);
      }
      const nameById = new Map(clients.map((client) => [client.id, client.full_name]));

      return {
        conversations,
        emailFailed,
        items: mergeInbox([
          ...conversations.map(
            (conversation) => conversationItem(conversation, participantLabel(conversation, copy.unknownSender)),
          ),
          ...threads.map(
            (thread) => emailItem(
              thread,
              (thread.client_id ? nameById.get(thread.client_id) : null) ?? thread.to_email,
            ),
          ),
        ]),
      };
    },
    [api, channel, linkState, selectedArtistId, copy.unknownSender],
  );

  // Artist scope is a usability filter here, exactly as it is on every other
  // list. The database has already limited the rows to artists this operator
  // can reach.
  const items = useMemo(
    () => (data?.items ?? []).filter(
      (item) => (!selectedArtistId || item.artist_id === selectedArtistId)
        && (channel === '' || item.channel === channel)
        && (view !== 'needs_reply' || isWaiting(item)),
    ),
    [data, selectedArtistId, channel, view],
  );

  const conversationById = useMemo(
    () => new Map((data?.conversations ?? []).map((conversation) => [conversation.id, conversation])),
    [data],
  );

  const filtered = channel !== '' || view !== '';

  return (
    <>
      <div className="card">
        <div className="inbox-filters" role="tablist" aria-label={copy.title}>
          {([
            ['', copy.all],
            ['instagram', copy.instagram],
            ['whatsapp', copy.whatsapp],
            ['email', copy.email],
          ] as [ChannelFilter, string][]).map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              role="tab"
              aria-selected={channel === value}
              className={channel === value ? 'inbox-filter selected' : 'inbox-filter'}
              onClick={() => setChannel(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="inbox-filters secondary">
          {([
            ['', copy.everyone],
            ['needs_reply', copy.needsReply],
            ['unmatched', copy.unmatched],
            ['linked', copy.linked],
          ] as [ViewFilter, string][]).map(([value, label]) => (
            <button
              key={value || 'everyone'}
              type="button"
              aria-pressed={view === value}
              className={view === value ? 'inbox-filter selected' : 'inbox-filter'}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? <LoadingState label={copy.loading} /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {!loading && !error && data?.emailFailed ? (
        <p className="notice warn" role="status">{copy.emailUnavailable}</p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title={view === 'needs_reply' ? copy.nobodyWaiting : filtered ? copy.emptyFiltered : copy.empty}
          hint={view === 'needs_reply' ? copy.nobodyWaitingHint : filtered ? copy.emptyFilteredHint : copy.emptyHint}
        />
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <div className="list">
          {items.map((item) => {
            const conversation = item.channel === 'email'
              ? undefined
              : conversationById.get(item.key.replace('conversation-', ''));
            return (
              <Link
                key={item.key}
                to={item.href.replace(/^#/, '')}
                className={isWaiting(item) ? 'row inbox-row unread' : 'row inbox-row'}
              >
                <div className="inbox-row-head">
                  <span className="title">{item.title}</span>
                  <span className={`badge channel-${item.channel}`}>
                    {item.channel === 'instagram'
                      ? copy.instagram
                      : item.channel === 'whatsapp'
                        ? copy.whatsapp
                        : copy.email}
                  </span>
                </div>

                <div className="meta inbox-preview">
                  {item.preview
                    ?? (item.channel === 'email'
                      ? copy.noSubject
                      : conversation?.latest_message_type
                        ? `[${copy.attachment}]`
                        : copy.noPreview)}
                </div>

                <div className="meta inbox-row-foot">
                  <span>{item.timestamp ? formatDateTime(item.timestamp, language) : ''}</span>
                  <span className="inbox-flags">
                    {/* Why this row is waiting, in its own channel's terms.
                        Messaging says who spoke last; email says what the
                        pipeline is stuck on. */}
                    {item.reason === 'client_replied' ? (
                      <span className="badge warn">{copy.awaitingReply}</span>
                    ) : item.reason === 'draft_awaiting_approval' ? (
                      <span className="badge warn">{copy.draftWaiting}</span>
                    ) : item.reason === 'send_failed' ? (
                      <span className="badge danger">{copy.sendFailed}</span>
                    ) : conversation?.latest_direction === 'outbound' ? (
                      <span className="badge">{copy.youRepliedLast}</span>
                    ) : null}
                    {item.unread ? <span className="badge">{copy.needsAttention}</span> : null}
                    {conversation?.link_state === 'unmatched' ? (
                      <span className="badge">{copy.notLinked}</span>
                    ) : null}
                    {conversation?.state === 'archived' ? (
                      <span className="badge">{copy.archived}</span>
                    ) : null}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
