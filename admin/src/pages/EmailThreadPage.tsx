// One email conversation, with live mailbox history and the protected CRM
// approval path in the same workspace.
//
// Live Gmail is read-only. Draft approval still releases mail through the
// existing outbox; this screen deliberately has no direct-send composer.

import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { ClientContextStrip } from '../components/ClientContextStrip';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import type { LiveGmailHistory, LiveGmailMessage } from '../lib/email-api';
import { formatDateTime } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { groupEmailThreads, stateFor, type EmailThread } from '../lib/email-threads';
import type { EmailMessageDetail } from '../lib/types';

interface ThreadView {
  thread: EmailThread | null;
  /** The body of whatever the operator has to act on, loaded only here. */
  actionable: EmailMessageDetail | null;
  /** Current provider history, never persisted in the browser-side CRM model. */
  liveGmail: LiveGmailHistory | null;
  /** Stable gateway code only, never provider response detail. */
  liveGmailError: string | null;
}

export function EmailThreadPage({ threadKey }: { threadKey: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const role = profile?.role;
  const mayApprove = can(role, 'approveEmail');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<ThreadView>(
    async () => {
      const [kind, id] = splitKey(threadKey);
      const messages = kind === 'enquiry'
        ? await api.listEmailMessages({ enquiryId: id, limit: 100 })
        : kind === 'client'
          ? await api.listEmailMessages({ clientId: id, limit: 100 })
          : (await api.listEmailMessages({ limit: 200 })).filter((message) => message.id === id);

      const thread = groupEmailThreads(messages).find((candidate) => candidate.key === threadKey) ?? null;
      const actionable = thread?.actionable_message_id
        ? await api.getEmailMessage(thread.actionable_message_id)
        : null;

      let liveGmail: LiveGmailHistory | null = null;
      let liveGmailError: string | null = null;
      if (thread?.enquiry_id) {
        try {
          liveGmail = await api.listLiveGmailHistory(thread.enquiry_id);
        } catch (cause) {
          liveGmailError = cause instanceof Error ? cause.message : 'gmail_live_unavailable';
        }
      }

      return { thread, actionable, liveGmail, liveGmailError };
    },
    [api, threadKey],
  );

  async function approve(messageId: string) {
    setActionError(null);
    setNotice(null);
    const confirmed = await confirmDialog({
      title: copy.confirmTitle,
      message: copy.confirmBody,
      confirmLabel: copy.approve,
      cancelLabel: cancelLabelFor(language),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.approveEmailDraft(messageId);
      setNotice(copy.approved);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : copy.approveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.thread) {
    return <EmptyState title={copy.notFound} hint={copy.notFoundHint} />;
  }

  const { thread, actionable, liveGmail, liveGmailError } = data;

  return (
    <>
      <div className="card conversation-header">
        <Link to="/inbox" className="badge">{copy.back}</Link>
        <h2 className="conversation-title">{thread.subject || copy.noSubject}</h2>
        <div className="meta conversation-badges">
          <span className="badge channel-email">{copy.email}</span>
          <span className={badgeClass(thread)}>{stateLabel(thread, language)}</span>
        </div>
        <p className="meta">{copy.to}: {thread.to_email}</p>

        {thread.client_id ? (
          <>
            <ClientContextStrip clientId={thread.client_id} />
            <div className="actions">
              <Link to={`/clients/${thread.client_id}`} className="badge">{copy.openClient}</Link>
              {thread.enquiry_id ? (
                <Link to={`/enquiries/${thread.enquiry_id}`} className="badge">{copy.openEnquiry}</Link>
              ) : null}
              {thread.project_id ? (
                <Link to={`/projects/${thread.project_id}`} className="badge">{copy.openProject}</Link>
              ) : null}
            </div>
          </>
        ) : (
          <p className="meta">{copy.noClient}</p>
        )}
      </div>

      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}

      {actionable ? (
        <Section title={thread.state === 'send_failed' ? copy.failedTitle : copy.draftTitle}>
          {thread.state === 'send_failed' ? (
            <p className="meta">{copy.failedHint}</p>
          ) : (
            <p className="meta">
              {actionable.created_by_kind === 'human' ? copy.draftByPerson : copy.draftByMachine}
            </p>
          )}
          <p className="email-subject"><strong>{actionable.subject}</strong></p>
          <pre className="email-body">{actionable.body}</pre>
          {thread.state === 'awaiting_approval' ? (
            mayApprove ? (
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => { void approve(actionable.id); }}
                >
                  {copy.approve}
                </button>
              </div>
            ) : (
              <p className="notice" role="status">{copy.approvalNotYours}</p>
            )
          ) : null}
        </Section>
      ) : null}

      {thread.enquiry_id ? (
        <Section title={copy.liveHistory}>
          {liveGmailError ? (
            <div className="notice warn" role="status">
              <p>{liveGmailError === 'gmail_reconnect_required' ? copy.gmailReconnect : copy.gmailUnavailable}</p>
              <button type="button" onClick={reload}>{copy.retry}</button>
            </div>
          ) : liveGmail?.threads.length ? (
            <div className="list">
              {liveGmail.threads.map((liveThread) => (
                <div key={liveThread.thread_context_id} className="row">
                  <div className="inbox-row-head">
                    <span className="title">{liveThread.subject || copy.noSubject}</span>
                    <span className="badge">{copy.live}</span>
                  </div>
                  <div className="list">
                    {liveThread.messages.map((message, index) => (
                      <LiveMessage
                        key={`${liveThread.thread_context_id}-${index}`}
                        message={message}
                        language={language}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title={copy.noLiveHistory} hint={copy.noLiveHistoryHint} />
          )}
        </Section>
      ) : (
        <p className="meta email-scope-note">{copy.liveNeedsEnquiry}</p>
      )}

      <Section title={copy.crmHistory}>
        {thread.messages.length === 0 ? (
          <EmptyState title={copy.noHistory} hint={copy.noHistoryHint} />
        ) : (
          <div className="list">
            {thread.messages.map((message) => (
              <div key={message.id} className="row">
                <div className="inbox-row-head">
                  <span className="title">{message.subject}</span>
                  <span className={`badge ${stateBadge(stateFor(message.status))}`}>
                    {statusLabel(message.status, language)}
                  </span>
                </div>
                <div className="meta">
                  {formatDateTime(message.created_at, language)}
                  {message.error_code ? ` · ${copy.deliveryProblem}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <p className="meta email-scope-note">{copy.sendBoundary}</p>
    </>
  );
}

function LiveMessage({ message, language }: { message: LiveGmailMessage; language: Language }) {
  const copy = COPY[language];
  return (
    <div className="row">
      <div className="inbox-row-head">
        <span className="title">{message.direction === 'inbound' ? copy.clientMessage : copy.studioMessage}</span>
        <span className={`badge ${message.direction === 'inbound' ? 'warn' : 'ok'}`}>
          {message.direction === 'inbound' ? copy.incoming : copy.outgoing}
        </span>
      </div>
      <div className="meta">
        {message.from} → {message.to}
        {message.timestamp ? ` · ${formatDateTime(message.timestamp, language)}` : ''}
      </div>
      <pre className="email-body">{message.body}</pre>
    </div>
  );
}

function splitKey(key: string): ['enquiry' | 'client' | 'message', string] {
  if (key.startsWith('enquiry-')) return ['enquiry', key.slice('enquiry-'.length)];
  if (key.startsWith('client-')) return ['client', key.slice('client-'.length)];
  return ['message', key.replace(/^message-/, '')];
}

function badgeClass(thread: EmailThread): string {
  if (thread.state === 'send_failed') return 'badge danger';
  if (thread.state === 'awaiting_approval') return 'badge warn';
  if (thread.state === 'sent') return 'badge ok';
  return 'badge';
}

function stateBadge(state: ReturnType<typeof stateFor>): string {
  if (state === 'send_failed') return 'danger';
  if (state === 'awaiting_approval') return 'warn';
  if (state === 'sent') return 'ok';
  return '';
}

function stateLabel(thread: EmailThread, language: Language): string {
  return COPY[language].state[thread.state];
}

function statusLabel(status: EmailMessageDetail['status'], language: Language): string {
  return COPY[language].status[status];
}

const COPY = {
  en: {
    email: 'Email',
    back: 'Back to Inbox',
    loading: 'Loading this email…',
    notFound: 'That email conversation is not here',
    notFoundHint: 'It may belong to an artist outside your access, or it may have been removed.',
    noSubject: 'No subject',
    to: 'To',
    openClient: 'Open client',
    openEnquiry: 'Open enquiry',
    openProject: 'Open project',
    noClient: 'This address is not linked to a client card.',
    draftTitle: 'Waiting for your approval',
    draftByMachine: 'Written automatically. Nothing is sent until you approve it.',
    draftByPerson: 'Written by a person. Nothing is sent until it is approved.',
    failedTitle: 'This did not send',
    failedHint: 'The provider refused this message. Check the Gmail connection, then have it drafted again.',
    approve: 'Approve and send',
    approved: 'Approved. It now goes out through the send queue.',
    approveFailed: 'Could not approve that email.',
    approvalNotYours: 'Only the studio owner can approve an email for sending.',
    confirmTitle: 'Approve this email?',
    confirmBody: 'It will be sent to the client from the studio mailbox. This cannot be recalled.',
    liveHistory: 'Live Gmail conversation',
    live: 'Live Gmail',
    incoming: 'Incoming',
    outgoing: 'Outgoing',
    clientMessage: 'Client',
    studioMessage: 'Studio',
    noLiveHistory: 'No Gmail messages found',
    noLiveHistoryHint: 'There is no mailbox thread between this client and the connected artist account yet.',
    gmailReconnect: 'Gmail needs to be reconnected before live replies can be read here.',
    gmailUnavailable: 'Live Gmail is temporarily unavailable. Stored CRM email history is still available below.',
    retry: 'Retry Gmail',
    liveNeedsEnquiry: 'Live Gmail history is available after this email is linked to an enquiry.',
    crmHistory: 'CRM delivery history',
    noHistory: 'Nothing sent yet',
    noHistoryHint: 'Approved emails appear here once they leave.',
    deliveryProblem: 'delivery problem',
    sendBoundary: 'Live Gmail above is read-only. Sending still goes through CRM draft approval and the protected outbox.',
    state: {
      send_failed: 'Send failed',
      awaiting_approval: 'Draft to approve',
      in_flight: 'Sending',
      sent: 'Sent',
      closed: 'Closed',
    },
    status: {
      draft: 'Draft',
      approved: 'Approved',
      queued: 'Queued',
      sent: 'Sent',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
  },
  ru: {
    email: 'Почта',
    back: 'Назад к сообщениям',
    loading: 'Загружаем письмо…',
    notFound: 'Этой переписки здесь нет',
    notFoundHint: 'Возможно, она относится к мастеру вне вашего доступа или была удалена.',
    noSubject: 'Без темы',
    to: 'Кому',
    openClient: 'Открыть клиента',
    openEnquiry: 'Открыть заявку',
    openProject: 'Открыть проект',
    noClient: 'Этот адрес не связан с карточкой клиента.',
    draftTitle: 'Ждёт вашего утверждения',
    draftByMachine: 'Составлено автоматически. Ничего не уйдёт, пока вы не утвердите.',
    draftByPerson: 'Составлено человеком. Ничего не уйдёт до утверждения.',
    failedTitle: 'Письмо не отправлено',
    failedHint: 'Провайдер отклонил это письмо. Проверьте подключение Gmail и составьте письмо заново.',
    approve: 'Утвердить и отправить',
    approved: 'Утверждено. Письмо уйдёт через очередь отправки.',
    approveFailed: 'Не удалось утвердить письмо.',
    approvalNotYours: 'Утверждать письма может только владелец студии.',
    confirmTitle: 'Утвердить это письмо?',
    confirmBody: 'Оно будет отправлено клиенту из почты студии. Отозвать письмо будет нельзя.',
    liveHistory: 'Переписка Gmail',
    live: 'Gmail сейчас',
    incoming: 'Входящее',
    outgoing: 'Исходящее',
    clientMessage: 'Клиент',
    studioMessage: 'Студия',
    noLiveHistory: 'Писем в Gmail не найдено',
    noLiveHistoryHint: 'Между этим клиентом и подключённой почтой мастера пока нет переписки.',
    gmailReconnect: 'Нужно переподключить Gmail, чтобы читать ответы клиента прямо здесь.',
    gmailUnavailable: 'Gmail сейчас недоступен. Сохранённая история CRM остаётся доступна ниже.',
    retry: 'Повторить Gmail',
    liveNeedsEnquiry: 'Живая история Gmail появится, когда письмо будет связано с заявкой.',
    crmHistory: 'История отправки CRM',
    noHistory: 'Пока ничего не отправлено',
    noHistoryHint: 'Утверждённые письма появятся здесь после отправки.',
    deliveryProblem: 'проблема с доставкой',
    sendBoundary: 'Gmail выше работает только на чтение. Отправка по-прежнему идёт через утверждение черновика и защищённую очередь CRM.',
    state: {
      send_failed: 'Не отправлено',
      awaiting_approval: 'На утверждение',
      in_flight: 'Отправляется',
      sent: 'Отправлено',
      closed: 'Закрыто',
    },
    status: {
      draft: 'Черновик',
      approved: 'Утверждено',
      queued: 'В очереди',
      sent: 'Отправлено',
      failed: 'Ошибка',
      cancelled: 'Отменено',
    },
  },
} as const;
