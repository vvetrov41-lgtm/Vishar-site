// WhatsApp, from the enquiry.
//
// This panel used to be a second WhatsApp interface: its own thread view and
// its own composer, reading the `whatsapp_*` compatibility views over the same
// rows the Communications inbox already shows. Two places to reply to one
// person meant two sets of behaviour to learn and no single answer to "has this
// client been answered?".
//
// What is left is what only exists here: opening the thread in the phone's own
// WhatsApp, and connecting an enquiry's client to a CRM conversation for the
// first time. The conversation itself is the inbox's, and this links into it.

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import type { CrmRole } from '../lib/types';
import { can } from '../lib/permissions';
import { formatDateTime } from '../lib/format';
import { Link } from '../lib/router';
import { whatsappDigits } from '../lib/phone';

interface Conversation {
  id: string;
  artist_id: string;
  client_id: string | null;
  integration_key: string;
  contact_wa_id: string;
  last_message_at: string | null;
}

const COPY = {
  en: {
    openInWhatsApp: 'Open in WhatsApp',
    openConversation: 'Open conversation',
    connect: 'Connect conversation to CRM',
    lastMessage: 'Last message {date}',
    noMessages: 'No messages in the CRM yet',
    loadFailed: 'Could not load WhatsApp.',
    connectFailed: 'Could not open conversation.',
    numberNeeded: 'CRM WhatsApp requires an international number or a UK mobile number beginning 07…',
    notConnected: 'CRM history will appear after this artist’s WhatsApp integration is connected.',
    repliesLive: 'Replies are sent from the conversation, alongside every other channel.',
  },
  ru: {
    openInWhatsApp: 'Открыть в WhatsApp',
    openConversation: 'Открыть переписку',
    connect: 'Подключить диалог к CRM',
    lastMessage: 'Последнее сообщение {date}',
    noMessages: 'Сообщений в CRM пока нет',
    loadFailed: 'Не удалось загрузить WhatsApp.',
    connectFailed: 'Не удалось открыть диалог.',
    numberNeeded: 'Для CRM WhatsApp нужен международный номер или британский мобильный номер вида 07…',
    notConnected: 'История CRM появится после подключения WhatsApp-интеграции этого мастера.',
    repliesLive: 'Ответы отправляются из переписки, вместе со всеми остальными каналами.',
  },
} as const;

export function EnquiryWhatsAppPanel({
  api,
  enquiryId,
  clientId,
  artistId,
  phone,
  role,
  language,
}: {
  api: Api;
  enquiryId: string;
  clientId: string;
  artistId: string;
  phone: string | null;
  role: CrmRole | undefined;
  language: 'en' | 'ru';
}) {
  const copy = COPY[language];
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mayConnect = can(role, 'editEnquiry');
  const waDigits = whatsappDigits(phone);

  const load = useCallback(async () => {
    const found = await api.getWhatsAppConversationForClient(clientId, artistId);
    setConversation(found as Conversation | null);
  }, [api, artistId, clientId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.getWhatsAppConversationForClient(clientId, artistId);
        if (!cancelled) setConversation(found as Conversation | null);
      } catch {
        if (!cancelled) setError(copy.loadFailed);
      }
    })();
    return () => { cancelled = true; };
  }, [api, artistId, clientId, copy.loadFailed]);

  async function startConversation() {
    setBusy(true);
    setError(null);
    try {
      await api.ensureWhatsAppConversationForEnquiry(enquiryId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.connectFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="actions" style={{ marginTop: 0 }}>
        {conversation ? (
          <Link
            to={`/inbox/${conversation.id}`}
            className="badge"
            style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}
          >
            {copy.openConversation}
          </Link>
        ) : null}
        {waDigits ? (
          <a
            className="badge"
            href={`https://wa.me/${waDigits}`}
            target="_blank"
            rel="noreferrer"
            style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}
          >
            {copy.openInWhatsApp}
          </a>
        ) : null}
        {!conversation && mayConnect ? (
          <button type="button" disabled={busy} onClick={() => { void startConversation(); }}>
            {copy.connect}
          </button>
        ) : null}
      </div>

      {!waDigits ? (
        <p className="notice warn" role="status">{copy.numberNeeded}</p>
      ) : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}

      {conversation ? (
        <p className="meta" style={{ marginBottom: 0 }}>
          {conversation.last_message_at
            ? copy.lastMessage.replace('{date}', formatDateTime(conversation.last_message_at, language))
            : copy.noMessages}
          {' · '}
          {copy.repliesLive}
        </p>
      ) : (
        <p className="meta" style={{ marginBottom: 0 }}>{copy.notConnected}</p>
      )}
    </div>
  );
}
