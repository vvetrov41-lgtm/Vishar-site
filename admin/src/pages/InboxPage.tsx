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
    email: 'Email',
    everyone: 'Everyone',
    unmatched: 'Unmatched',
    linked: 'Linked clients',
    loading: 'Loading conversations…',
    empty: 'No conversations yet',
    emptyHint: 'Messages appear here as soon as a connected channel receives one.',
    emptyFiltered: 'Nothing matches this filter',
    emptyFilteredHint: 'Try All, or clear the unmatched filter.',
    unknownSender: 'Unknown sender',
    needsAttention: 'Unread',
    notLinked: 'Not linked',
    archived: 'Archived',
    noPreview: 'No message yet',
    emailNotice:
      'Email conversations still live on the enquiry, under Email drafts. They are not duplicated here.',
    attachment: 'Attachment',
  },
  ru: {
    title: 'Сообщения',
    all: 'Все',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    email: 'Email',
    everyone: 'Все',
    unmatched: 'Без клиента',
    linked: 'С клиентом',
    loading: 'Загружаем диалоги…',
    empty: 'Диалогов пока нет',
    emptyHint: 'Сообщения появятся здесь, как только подключённый канал что-то получит.',
    emptyFiltered: 'Ничего не найдено по этому фильтру',
    emptyFilteredHint: 'Попробуйте «Все» или снимите фильтр «Без клиента».',
    unknownSender: 'Неизвестный отправитель',
    needsAttention: 'Не прочитано',
    notLinked: 'Без клиента',
    archived: 'В архиве',
    noPreview: 'Сообщений пока нет',
    emailNotice:
      'Переписка по email остаётся в карточке заявки, в разделе черновиков. Здесь она не дублируется.',
    attachment: 'Вложение',
  },
} as const;

type ChannelFilter = '' | CommunicationChannel | 'email';
type LinkFilter = '' | CommunicationLinkState;

export function InboxPage() {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const { selectedArtistId } = useArtistScope();
  const [channel, setChannel] = useState<ChannelFilter>('');
  const [linkState, setLinkState] = useState<LinkFilter>('');

  const { data, loading, error, reload } = useAsync<ConversationSummary[]>(
    () => (channel === 'email'
      ? Promise.resolve([])
      : api.listConversations({
        channel: channel || undefined,
        linkState: linkState || undefined,
        limit: 50,
      })),
    [api, channel, linkState],
  );

  // Artist scope is a usability filter here, exactly as it is on every other
  // list. The database has already limited the rows to artists this operator
  // can reach.
  const conversations = useMemo(
    () => (data ?? []).filter(
      (conversation) => !selectedArtistId || conversation.artist_id === selectedArtistId,
    ),
    [data, selectedArtistId],
  );

  const filtered = channel !== '' || linkState !== '';

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

        {channel !== 'email' ? (
          <div className="inbox-filters secondary">
            {([
              ['', copy.everyone],
              ['unmatched', copy.unmatched],
              ['linked', copy.linked],
            ] as [LinkFilter, string][]).map(([value, label]) => (
              <button
                key={value || 'everyone'}
                type="button"
                aria-pressed={linkState === value}
                className={linkState === value ? 'inbox-filter selected' : 'inbox-filter'}
                onClick={() => setLinkState(value)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Gmail keeps its own thread model. Saying so is more honest than
          showing an empty tab that looks broken. */}
      {channel === 'email' ? (
        <p className="notice" role="status">{copy.emailNotice}</p>
      ) : null}

      {channel !== 'email' && loading ? <LoadingState label={copy.loading} /> : null}
      {channel !== 'email' && error ? <ErrorState message={error} onRetry={reload} /> : null}

      {channel !== 'email' && !loading && !error && conversations.length === 0 ? (
        <EmptyState
          title={filtered ? copy.emptyFiltered : copy.empty}
          hint={filtered ? copy.emptyFilteredHint : copy.emptyHint}
        />
      ) : null}

      {channel !== 'email' && !loading && !error && conversations.length > 0 ? (
        <div className="list">
          {conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to={`/inbox/${conversation.id}`}
              className={conversation.has_unread ? 'row inbox-row unread' : 'row inbox-row'}
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
                  {conversation.has_unread ? (
                    <span className="badge warn">{copy.needsAttention}</span>
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
