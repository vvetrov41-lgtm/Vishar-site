// Communications inbox.
//
// One list for every messaging channel, because an operator thinks in
// conversations rather than in providers. The channel is a filter and a badge,
// not a separate screen.
//
// The list is deliberately thin: a label, a channel, a preview, a time and
// whether the conversation still needs attention. Message history is loaded
// only when a conversation is opened, so an artist with a busy Instagram
// account does not pay for it on every inbox render.

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
  conversationNeedsReply,
  participantLabel,
  type CommunicationChannel,
  type CommunicationLinkState,
  type ConversationSummary,
} from '../lib/communications-api';

const COPY = {
  en: {
    title: 'Communications',
    all: 'All',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    everyone: 'Everyone',
    needsReply: 'Needs reply',
    unmatched: 'Unmatched',
    linked: 'Linked clients',
    loading: 'Loading conversations…',
    empty: 'No conversations yet',
    emptyHint: 'Messages appear here as soon as a connected channel receives one.',
    emptyFiltered: 'Nothing matches this filter',
    emptyFilteredHint: 'Try All, or clear the filter.',
    nobodyWaiting: 'Nobody is waiting on a reply',
    nobodyWaitingHint: 'Every open conversation was answered last by you.',
    unknownSender: 'Unknown sender',
    needsAttention: 'Unread',
    awaitingReply: 'Needs reply',
    youRepliedLast: 'You replied last',
    notLinked: 'Not linked',
    archived: 'Archived',
    noPreview: 'No message yet',
    attachment: 'Attachment',
  },
  ru: {
    title: 'Сообщения',
    all: 'Все',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    everyone: 'Все',
    needsReply: 'Ждут ответа',
    unmatched: 'Без клиента',
    linked: 'С клиентом',
    loading: 'Загружаем диалоги…',
    empty: 'Диалогов пока нет',
    emptyHint: 'Сообщения появятся здесь, как только подключённый канал что-то получит.',
    emptyFiltered: 'Ничего не найдено по этому фильтру',
    emptyFilteredHint: 'Попробуйте «Все» или снимите фильтр.',
    nobodyWaiting: 'Никто не ждёт ответа',
    nobodyWaitingHint: 'В каждом открытом диалоге последним ответили вы.',
    unknownSender: 'Неизвестный отправитель',
    needsAttention: 'Не прочитано',
    awaitingReply: 'Ждёт ответа',
    youRepliedLast: 'Вы ответили последним',
    notLinked: 'Без клиента',
    archived: 'В архиве',
    noPreview: 'Сообщений пока нет',
    attachment: 'Вложение',
  },
} as const;

type ChannelFilter = '' | CommunicationChannel;

/**
 * "Who needs a reply?" is the question the operator actually opens this screen
 * with, so it is a view of its own rather than something to work out from the
 * unread badges. The other two views are about the record rather than the
 * person, and stay available behind it.
 */
type ViewFilter = '' | 'needs_reply' | CommunicationLinkState;

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

  const { data, loading, error, reload } = useAsync<ConversationSummary[]>(
    () => api.listConversations({
      channel: channel || undefined,
      linkState,
      limit: 50,
    }),
    [api, channel, linkState],
  );

  // Artist scope is a usability filter here, exactly as it is on every other
  // list. The database has already limited the rows to artists this operator
  // can reach.
  const conversations = useMemo(
    () => (data ?? []).filter(
      (conversation) => (!selectedArtistId || conversation.artist_id === selectedArtistId)
        && (view !== 'needs_reply' || conversationNeedsReply(conversation)),
    ),
    [data, selectedArtistId, view],
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

      {!loading && !error && conversations.length === 0 ? (
        <EmptyState
          title={view === 'needs_reply' ? copy.nobodyWaiting : filtered ? copy.emptyFiltered : copy.empty}
          hint={view === 'needs_reply' ? copy.nobodyWaitingHint : filtered ? copy.emptyFilteredHint : copy.emptyHint}
        />
      ) : null}

      {!loading && !error && conversations.length > 0 ? (
        <div className="list">
          {conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to={`/inbox/${conversation.id}`}
              className={conversationNeedsReply(conversation) ? 'row inbox-row unread' : 'row inbox-row'}
            >
              <div className="inbox-row-head">
                <span className="title">
                  {participantLabel(conversation, copy.unknownSender)}
                </span>
                <span className={`badge channel-${conversation.channel}`}>
                  {conversation.channel === 'instagram' ? copy.instagram : copy.whatsapp}
                </span>
              </div>

              <div className="meta inbox-preview">
                {conversation.latest_preview
                  ?? (conversation.latest_message_type
                    ? `[${copy.attachment}]`
                    : copy.noPreview)}
              </div>

              <div className="meta inbox-row-foot">
                <span>
                  {conversation.last_message_at
                    ? formatDateTime(conversation.last_message_at, language)
                    : ''}
                </span>
                <span className="inbox-flags">
                  {/* Who spoke last, then whether it has been looked at. The
                      two are different questions and the operator needs the
                      first one more often. */}
                  {conversationNeedsReply(conversation) ? (
                    <span className="badge warn">{copy.awaitingReply}</span>
                  ) : conversation.latest_direction === 'outbound' ? (
                    <span className="badge">{copy.youRepliedLast}</span>
                  ) : null}
                  {conversation.has_unread ? (
                    <span className="badge">{copy.needsAttention}</span>
                  ) : null}
                  {conversation.link_state === 'unmatched' ? (
                    <span className="badge">{copy.notLinked}</span>
                  ) : null}
                  {conversation.state === 'archived' ? (
                    <span className="badge">{copy.archived}</span>
                  ) : null}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
