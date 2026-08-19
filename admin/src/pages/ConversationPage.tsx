// One conversation: history, reply, and the decisions an operator makes about
// an unknown sender.
//
// The screen is built around a deliberate product rule. An inbound direct
// message is not an enquiry. Instagram traffic is greetings, reactions, spam
// and ordinary chat with existing clients as well as real tattoo enquiries, so
// nothing is promoted automatically. An unknown sender arrives as an unmatched
// conversation and stays that way until someone decides what it is.
//
// Nothing on this screen sends an artist, a provider account or a recipient to
// the server. Every action names the conversation and lets the database
// resolve the rest.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import './Inbox.css';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { can } from '../lib/permissions';
import { useDebouncedValue } from '../lib/use-debounced-value';
import {
  participantLabel,
  type ConversationDetail,
  type ConversationMessage,
} from '../lib/communications-api';
import type { Client } from '../lib/types';

const COPY = {
  en: {
    back: 'Back to Communications',
    loading: 'Loading conversation…',
    notFound: 'Conversation not found',
    notFoundHint: 'It may belong to another artist, or it may have been removed.',
    unknownSender: 'Unknown sender',
    unmatchedTitle: 'This sender is not linked to a client',
    unmatchedHint:
      'Nothing was created automatically. Link an existing client, create a new one, or turn this into an enquiry when it really is one.',
    linkExisting: 'Link an existing client',
    searchClients: 'Search clients by name',
    noClientMatches: 'No matching clients',
    link: 'Link',
    createClient: 'Create a client',
    createClientHint:
      'A direct message carries no verified email or phone, so only what you enter is stored.',
    fullName: 'Full name',
    email: 'Email',
    phone: 'Phone',
    instagram: 'Instagram handle',
    create: 'Create',
    createEnquiry: 'Create an enquiry',
    submitEnquiry: 'Create the enquiry',
    createEnquiryHint:
      'This uses the normal enquiry intake, so an email address is required. The enquiry keeps this conversation as its source.',
    projectType: 'Project type',
    idea: 'Idea',
    privacy: 'The client acknowledged the current privacy notice',
    linkedTo: 'Linked client',
    openClient: 'Open client',
    openEnquiry: 'Open enquiry',
    history: 'History',
    noMessages: 'No messages in this conversation yet',
    reply: 'Reply',
    replyPlaceholder: 'Write a reply…',
    send: 'Send',
    sending: 'Sending…',
    archived: 'Archived',
    archive: 'Archive',
    unarchive: 'Move back to the inbox',
    archivedNotice: 'This conversation is archived. Move it back to reply.',
    readOnlyNotice: 'You can read this conversation but not reply to it.',
    windowNotice:
      'A reply is only delivered inside the provider messaging window. If the window has closed, the message is marked failed and no workaround is attempted.',
    queued: 'Queued',
    failed: 'Failed',
    attachment: 'Attachment',
    sentFromApp: 'Sent from the app',
    markRead: 'Mark as read',
  },
  ru: {
    back: 'К списку сообщений',
    loading: 'Загружаем диалог…',
    notFound: 'Диалог не найден',
    notFoundHint: 'Возможно, он принадлежит другому мастеру или был удалён.',
    unknownSender: 'Неизвестный отправитель',
    unmatchedTitle: 'Отправитель не связан с клиентом',
    unmatchedHint:
      'Ничего не создано автоматически. Свяжите с существующим клиентом, создайте нового или оформите заявку, если это действительно заявка.',
    linkExisting: 'Связать с существующим клиентом',
    searchClients: 'Поиск клиента по имени',
    noClientMatches: 'Совпадений нет',
    link: 'Связать',
    createClient: 'Создать клиента',
    createClientHint:
      'В личных сообщениях нет подтверждённого email или телефона, поэтому сохраняется только то, что вы введёте.',
    fullName: 'Имя',
    email: 'Email',
    phone: 'Телефон',
    instagram: 'Instagram',
    create: 'Создать',
    createEnquiry: 'Создать заявку',
    submitEnquiry: 'Создать заявку сейчас',
    createEnquiryHint:
      'Используется обычный приём заявок, поэтому email обязателен. Заявка сохранит этот диалог как источник.',
    projectType: 'Тип работы',
    idea: 'Идея',
    privacy: 'Клиент подтвердил текущую политику конфиденциальности',
    linkedTo: 'Клиент',
    openClient: 'Открыть клиента',
    openEnquiry: 'Открыть заявку',
    history: 'История',
    noMessages: 'Сообщений в этом диалоге пока нет',
    reply: 'Ответ',
    replyPlaceholder: 'Написать ответ…',
    send: 'Отправить',
    sending: 'Отправляем…',
    archived: 'В архиве',
    archive: 'В архив',
    unarchive: 'Вернуть в список',
    archivedNotice: 'Диалог в архиве. Верните его в список, чтобы ответить.',
    readOnlyNotice: 'Вы можете читать этот диалог, но не отвечать в нём.',
    windowNotice:
      'Ответ доставляется только внутри окна сообщений провайдера. Если окно закрыто, сообщение будет помечено как неудачное — обход правил не выполняется.',
    queued: 'В очереди',
    failed: 'Ошибка',
    attachment: 'Вложение',
    sentFromApp: 'Отправлено из приложения',
    markRead: 'Отметить прочитанным',
  },
} as const;

type Panel = 'none' | 'link' | 'client' | 'enquiry';

export function ConversationPage({ conversationId }: { conversationId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { language } = useLanguage();
  const { navigate } = useRouter();
  const copy = COPY[language];
  const mayReply = can(profile?.role, 'editEnquiry');

  const [panel, setPanel] = useState<Panel>('none');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [body, setBody] = useState('');

  const {
    data: conversation, loading, error, reload,
  } = useAsync<ConversationDetail | null>(
    () => api.getConversation(conversationId),
    [api, conversationId],
  );

  const {
    data: messages, loading: messagesLoading, reload: reloadMessages,
  } = useAsync<ConversationMessage[]>(
    () => api.listMessages(conversationId),
    [api, conversationId],
  );

  // Opening a conversation is what marks it read. Doing it on render rather
  // than behind a button keeps the unread count honest without an extra tap.
  useEffect(() => {
    if (!conversation || !mayReply) return;
    void api.markRead(conversationId).catch(() => {
      // A failed read mark is cosmetic; the conversation is still readable.
    });
  }, [api, conversation, conversationId, mayReply]);

  const label = useMemo(
    () => (conversation
      ? participantLabel(
        { ...conversation, client_name: null },
        copy.unknownSender,
      )
      : copy.unknownSender),
    [conversation, copy.unknownSender],
  );

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setPanel('none');
      reload();
      reloadMessages();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }, [reload, reloadMessages]);

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!conversation) {
    return <EmptyState title={copy.notFound} hint={copy.notFoundHint} />;
  }

  const archived = conversation.state === 'archived';
  const canSend = mayReply && !archived;

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.sendReply(conversationId, text, crypto.randomUUID());
      setBody('');
      reloadMessages();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card conversation-header">
        <Link to="/inbox" className="badge">{copy.back}</Link>
        <h2 className="conversation-title">{label}</h2>
        <div className="meta conversation-badges">
          <span className={`badge channel-${conversation.channel}`}>
            {conversation.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}
          </span>
          {archived ? <span className="badge">{copy.archived}</span> : null}
        </div>

        {conversation.client_id ? (
          <div className="actions">
            <Link to={`/clients/${conversation.client_id}`} className="badge">
              {copy.openClient}
            </Link>
            {conversation.enquiry_id ? (
              <Link to={`/enquiries/${conversation.enquiry_id}`} className="badge">
                {copy.openEnquiry}
              </Link>
            ) : null}
          </div>
        ) : null}

        {mayReply ? (
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => { void run(() => api.setState(conversationId, archived ? 'open' : 'archived')); }}
            >
              {archived ? copy.unarchive : copy.archive}
            </button>
          </div>
        ) : null}
      </div>

      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}

      {conversation.link_state === 'unmatched' && mayReply ? (
        <section className="card">
          <h3>{copy.unmatchedTitle}</h3>
          <p className="notice">{copy.unmatchedHint}</p>
          <div className="actions">
            <button type="button" onClick={() => setPanel(panel === 'link' ? 'none' : 'link')}>
              {copy.linkExisting}
            </button>
            <button type="button" onClick={() => setPanel(panel === 'client' ? 'none' : 'client')}>
              {copy.createClient}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => setPanel(panel === 'enquiry' ? 'none' : 'enquiry')}
            >
              {copy.createEnquiry}
            </button>
          </div>

          {panel === 'link' ? (
            <LinkClientPanel
              copy={copy}
              busy={busy}
              onLink={(clientId) => run(() => api.linkClient(conversationId, clientId))}
            />
          ) : null}

          {panel === 'client' ? (
            <CreateClientPanel
              copy={copy}
              busy={busy}
              defaultInstagram={
                conversation.channel === 'instagram' && conversation.external_username
                  ? `@${conversation.external_username}`
                  : ''
              }
              onCreate={(details) => run(() => api.createClient(conversationId, details))}
            />
          ) : null}

          {panel === 'enquiry' ? (
            <CreateEnquiryPanel
              copy={copy}
              busy={busy}
              defaultName={label === copy.unknownSender ? '' : label}
              defaultInstagram={
                conversation.channel === 'instagram' && conversation.external_username
                  ? `@${conversation.external_username}`
                  : ''
              }
              onCreate={(payload) => run(async () => {
                const created: any = await api.createEnquiry(conversationId, payload);
                if (created?.enquiry_id) navigate(`/enquiries/${created.enquiry_id}`);
                return created;
              })}
            />
          ) : null}
        </section>
      ) : null}

      <section className="card">
        <h3>{copy.history}</h3>
        {messagesLoading ? <LoadingState label={copy.loading} /> : null}
        {!messagesLoading && (messages ?? []).length === 0 ? (
          <EmptyState title={copy.noMessages} compact />
        ) : null}
        {!messagesLoading && (messages ?? []).length > 0 ? (
          <ul className="timeline conversation-history">
            {(messages ?? []).map((message) => (
              <li
                key={message.id}
                className={message.direction === 'inbound' ? 'inbound' : 'outbound'}
              >
                <div className="conversation-body">
                  {message.body ?? `[${copy.attachment}: ${message.message_type}]`}
                </div>
                <div className="when">
                  {formatDateTime(message.created_at, language)}
                  {' · '}
                  {message.status === 'queued' ? copy.queued : null}
                  {message.status === 'failed' ? copy.failed : null}
                  {message.status !== 'queued' && message.status !== 'failed'
                    ? message.status
                    : null}
                  {message.origin === 'provider_app' ? ` · ${copy.sentFromApp}` : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card conversation-composer">
        <h3>{copy.reply}</h3>
        {!mayReply ? <p className="notice">{copy.readOnlyNotice}</p> : null}
        {archived ? <p className="notice warn">{copy.archivedNotice}</p> : null}
        {canSend ? (
          <form onSubmit={(event) => { void send(event); }}>
            <label htmlFor="conversation-reply" className="visually-hidden">{copy.reply}</label>
            <textarea
              id="conversation-reply"
              value={body}
              maxLength={1000}
              disabled={busy}
              placeholder={copy.replyPlaceholder}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className="notice">{copy.windowNotice}</p>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy || !body.trim()}>
                {busy ? copy.sending : copy.send}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </>
  );
}

// The dictionaries are `as const` for key safety, so the shared prop type has
// to widen the literal values back to plain strings.
type Copy = { readonly [K in keyof (typeof COPY)['en']]: string };

function LinkClientPanel({
  copy, busy, onLink,
}: {
  copy: Copy;
  busy: boolean;
  onLink: (clientId: string) => void;
}) {
  const api = useApi();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const { data, loading } = useAsync<Client[]>(
    () => (debounced ? api.listClients(debounced) : Promise.resolve([])),
    [api, debounced],
  );

  return (
    <div className="conversation-panel">
      <label htmlFor="conversation-client-search">{copy.searchClients}</label>
      <input
        id="conversation-client-search"
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {loading ? <LoadingState /> : null}
      {!loading && debounced && (data ?? []).length === 0 ? (
        <p className="notice">{copy.noClientMatches}</p>
      ) : null}
      <div className="list">
        {(data ?? []).map((client) => (
          <div key={client.id} className="row">
            <div className="title">{client.full_name}</div>
            <div className="meta">{client.email ?? client.phone ?? ''}</div>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => onLink(client.id)}>
                {copy.link}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateClientPanel({
  copy, busy, defaultInstagram, onCreate,
}: {
  copy: Copy;
  busy: boolean;
  defaultInstagram: string;
  onCreate: (details: {
    fullName: string; email?: string; phone?: string; instagram?: string;
  }) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState(defaultInstagram);

  return (
    <form
      className="conversation-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ fullName, email, phone, instagram });
      }}
    >
      <p className="notice">{copy.createClientHint}</p>
      <div className="form-grid">
        <label>
          <span>{copy.fullName}</span>
          <input value={fullName} maxLength={160} required onChange={(event) => setFullName(event.target.value)} />
        </label>
        <label>
          <span>{copy.email}</span>
          <input type="email" value={email} maxLength={320} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          <span>{copy.phone}</span>
          <input type="tel" value={phone} maxLength={80} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          <span>{copy.instagram}</span>
          <input value={instagram} maxLength={80} onChange={(event) => setInstagram(event.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !fullName.trim()}>
          {copy.create}
        </button>
      </div>
    </form>
  );
}

function CreateEnquiryPanel({
  copy, busy, defaultName, defaultInstagram, onCreate,
}: {
  copy: Copy;
  busy: boolean;
  defaultName: string;
  defaultInstagram: string;
  onCreate: (payload: {
    idempotencyKey: string;
    client: Record<string, unknown>;
    enquiry: Record<string, unknown>;
    privacyAcknowledged: boolean;
  }) => void;
}) {
  const [fullName, setFullName] = useState(defaultName);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState(defaultInstagram);
  const [projectType, setProjectType] = useState('');
  const [idea, setIdea] = useState('');
  const [privacy, setPrivacy] = useState(false);
  // A stable key means a double submit replays the same intake instead of
  // creating a second enquiry.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  return (
    <form
      className="conversation-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({
          idempotencyKey,
          client: {
            full_name: fullName,
            email,
            phone: phone || null,
            instagram: instagram || null,
            preferred_contact: 'Instagram',
          },
          enquiry: { project_type: projectType || null, idea: idea || null },
          privacyAcknowledged: privacy,
        });
      }}
    >
      <p className="notice">{copy.createEnquiryHint}</p>
      <div className="form-grid">
        <label>
          <span>{copy.fullName}</span>
          <input value={fullName} maxLength={160} required onChange={(event) => setFullName(event.target.value)} />
        </label>
        <label>
          <span>{copy.email}</span>
          <input type="email" value={email} maxLength={320} required onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          <span>{copy.phone}</span>
          <input type="tel" value={phone} maxLength={80} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label>
          <span>{copy.instagram}</span>
          <input value={instagram} maxLength={80} onChange={(event) => setInstagram(event.target.value)} />
        </label>
        <label>
          <span>{copy.projectType}</span>
          <input value={projectType} maxLength={100} onChange={(event) => setProjectType(event.target.value)} />
        </label>
      </div>
      <label>
        <span>{copy.idea}</span>
        <textarea value={idea} maxLength={4000} onChange={(event) => setIdea(event.target.value)} />
      </label>
      <label className="field-row">
        <input type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)} />
        <span>{copy.privacy}</span>
      </label>
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={busy || !fullName.trim() || !email.trim() || !privacy}
        >
          {copy.submitEnquiry}
        </button>
      </div>
    </form>
  );
}
