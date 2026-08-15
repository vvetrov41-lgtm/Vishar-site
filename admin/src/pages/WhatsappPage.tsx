import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useApi, useSession } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { formatDateTime } from '../lib/format';
import { can } from '../lib/permissions';
import {
  conversationTitle,
  maskContact,
  withinCustomerServiceWindow,
  type WhatsappConversation,
  type WhatsappMessage,
} from '../lib/whatsapp-api';

interface WhatsappData {
  conversations: WhatsappConversation[];
  selected: WhatsappConversation | null;
  messages: WhatsappMessage[];
}

/**
 * How a message is labelled in the timeline. Coexistence means a WhatsApp
 * conversation can contain messages this CRM sent and messages the artist
 * typed in the WhatsApp Business App, and the difference matters when someone
 * is deciding whether a client has already been answered.
 */
export function messageLabelKey(message: Pick<WhatsappMessage, 'direction' | 'origin'>): string {
  if (message.direction === 'inbound') return 'whatsapp.fromClient';
  if (message.origin === 'business_app') return 'whatsapp.fromBusinessApp';
  if (message.origin === 'automation') return 'whatsapp.fromAutomation';
  return 'whatsapp.fromCrm';
}

export function statusBadgeClass(status: WhatsappMessage['status']): string {
  if (status === 'failed') return 'badge danger';
  if (status === 'read' || status === 'delivered') return 'badge ok';
  if (status === 'queued') return 'badge warn';
  return 'badge';
}

export function WhatsappPage() {
  const api = useApi();
  const { profile } = useSession();
  const { selectedArtistId } = useArtistScope();
  const { t, language } = useLanguage();
  const role = profile?.role;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<WhatsappData>(async () => {
    const conversations = await api.listWhatsappConversations(selectedArtistId);
    const active = selectedId
      ? conversations.find((conversation) => conversation.id === selectedId) ?? null
      : conversations[0] ?? null;
    const messages = active ? await api.listWhatsappMessages(active.id) : [];
    return { conversations, selected: active, messages };
  }, [api, selectedArtistId, selectedId]);

  if (loading) return <LoadingState label={t('whatsapp.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const conversations = data?.conversations ?? [];
  const selected = data?.selected ?? null;
  const messages = data?.messages ?? [];

  if (conversations.length === 0) {
    return (
      <EmptyState title={t('whatsapp.noConversations')} hint={t('whatsapp.noConversationsHint')} />
    );
  }

  // The database decides whether a send is permitted; this only avoids
  // offering a control that would be refused.
  const canReply = can(role, 'createNotes');
  const replyWindowOpen = selected ? withinCustomerServiceWindow(selected.last_inbound_at) : false;

  async function send() {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.sendWhatsappMessage(selected.id, draft);
      setDraft('');
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('whatsapp.sendFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title={t('whatsapp.conversations')}>
        <div className="list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="row"
              aria-current={conversation.id === selected?.id}
              onClick={() => setSelectedId(conversation.id)}
            >
              <span className="title">{conversationTitle(conversation)}</span>
              <span className="meta">
                {conversation.last_message_at
                  ? formatDateTime(conversation.last_message_at, language)
                  : t('whatsapp.noMessagesYet')}
              </span>
            </button>
          ))}
        </div>
      </Section>

      {selected ? (
        <Section title={conversationTitle(selected)}>
          <dl className="definition">
            <dt>{t('whatsapp.contact')}</dt>
            <dd>{maskContact(selected.contact_wa_id)}</dd>
            <dt>{t('whatsapp.replyWindow')}</dt>
            <dd>
              {replyWindowOpen ? t('whatsapp.windowOpen') : t('whatsapp.windowClosed')}
            </dd>
          </dl>

          {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

          {messages.length === 0 ? (
            <EmptyState title={t('whatsapp.noMessagesYet')} compact />
          ) : (
            <ul className="timeline" style={{ marginTop: 12 }}>
              {messages.map((message) => (
                <li key={message.id}>
                  <div className="actions" style={{ marginBottom: 4 }}>
                    <span className="badge">{t(messageLabelKey(message))}</span>
                    {message.direction === 'outbound' ? (
                      <span className={statusBadgeClass(message.status)}>
                        {t(`whatsapp.status.${message.status}`)}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.body}</div>
                  <div className="when">
                    {formatDateTime(message.provider_timestamp ?? message.created_at, language)}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canReply ? (
            <>
              <label htmlFor="whatsapp-body">{t('whatsapp.reply')}</label>
              <textarea
                id="whatsapp-body"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t('whatsapp.replyPlaceholder')}
                disabled={!replyWindowOpen}
              />
              {!replyWindowOpen ? (
                <div className="notice warn">{t('whatsapp.windowClosedHint')}</div>
              ) : null}
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !replyWindowOpen || draft.trim().length === 0}
                  onClick={() => { void send(); }}
                >
                  {t('whatsapp.send')}
                </button>
              </div>
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
