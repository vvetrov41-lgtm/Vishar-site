import { useEffect, useMemo, useState } from 'react';
import type { Api } from '../lib/api';
import type { CrmRole } from '../lib/types';
import { can } from '../lib/permissions';
import { formatDateTime } from '../lib/format';
import { whatsappDigits } from '../lib/phone';

interface Conversation {
  id: string;
  artist_id: string;
  client_id: string | null;
  integration_key: string;
  contact_wa_id: string;
  last_message_at: string | null;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  origin: 'contact' | 'crm' | 'business_app' | 'automation';
  status: 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  message_type: string;
  body: string | null;
  created_at: string;
}

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
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = can(role, 'editEnquiry');
  const waDigits = useMemo(() => whatsappDigits(phone), [phone]);

  async function load() {
    const found = await api.getWhatsAppConversationForClient(clientId, artistId);
    setConversation(found as Conversation | null);
    if (found) {
      setMessages((await api.listWhatsAppMessages((found as Conversation).id)) as Message[]);
    } else {
      setMessages([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.getWhatsAppConversationForClient(clientId, artistId);
        if (cancelled) return;
        setConversation(found as Conversation | null);
        if (found) {
          const rows = await api.listWhatsAppMessages((found as Conversation).id);
          if (!cancelled) setMessages(rows as Message[]);
        }
      } catch {
        if (!cancelled) setError(language === 'ru' ? 'Не удалось загрузить WhatsApp.' : 'Could not load WhatsApp.');
      }
    })();
    return () => { cancelled = true; };
  }, [api, artistId, clientId, language]);

  async function startConversation() {
    setBusy(true);
    setError(null);
    try {
      await api.ensureWhatsAppConversationForEnquiry(enquiryId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (language === 'ru' ? 'Не удалось открыть диалог.' : 'Could not open conversation.'));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!conversation || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.queueWhatsAppMessage(conversation.id, body.trim(), crypto.randomUUID());
      setBody('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (language === 'ru' ? 'Не удалось поставить сообщение в очередь.' : 'Could not queue message.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="actions" style={{ marginTop: 0 }}>
        {waDigits ? (
          <a className="badge" href={`https://wa.me/${waDigits}`} target="_blank" rel="noreferrer">
            {language === 'ru' ? 'Открыть в WhatsApp' : 'Open in WhatsApp'}
          </a>
        ) : null}
        {!conversation && canSend ? (
          <button type="button" disabled={busy} onClick={() => { void startConversation(); }}>
            {language === 'ru' ? 'Подключить диалог к CRM' : 'Connect conversation to CRM'}
          </button>
        ) : null}
      </div>

      {!waDigits ? (
        <p className="notice warn" role="status">
          {language === 'ru'
            ? 'Для CRM WhatsApp нужен международный номер или британский мобильный номер вида 07…'
            : 'CRM WhatsApp requires an international number or a UK mobile number beginning 07…'}
        </p>
      ) : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}

      {conversation ? (
        <>
          {messages.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>
              {language === 'ru' ? 'Сообщений в CRM пока нет.' : 'No CRM messages yet.'}
            </p>
          ) : (
            <ul className="timeline">
              {messages.map((message) => (
                <li key={message.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    {message.body ?? `[${message.message_type}]`}
                  </div>
                  <div className="meta">
                    <span className="badge">{message.direction === 'inbound' ? '←' : '→'} {message.status}</span>{' '}
                    <span>{formatDateTime(message.created_at, language)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canSend ? (
            <>
              <label htmlFor="whatsapp-message">
                {language === 'ru' ? 'Сообщение WhatsApp' : 'WhatsApp message'}
              </label>
              <textarea
                id="whatsapp-message"
                value={body}
                maxLength={4096}
                disabled={busy}
                onChange={(event) => setBody(event.target.value)}
                placeholder={language === 'ru' ? 'Написать клиенту…' : 'Write to the client…'}
              />
              <div className="actions">
                <button type="button" className="primary" disabled={busy || !body.trim()} onClick={() => { void send(); }}>
                  {language === 'ru' ? 'Отправить через CRM' : 'Send via CRM'}
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p style={{ color: 'var(--muted)', marginBottom: 0 }}>
          {language === 'ru'
            ? 'История CRM появится после подключения WhatsApp-интеграции этого мастера.'
            : 'CRM history will appear after this artist’s WhatsApp integration is connected.'}
        </p>
      )}
    </div>
  );
}
