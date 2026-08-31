// One email conversation, with the action area email actually has.
//
// The shell matches the messaging conversation screen - back link, who this
// is, the same client context strip - so the Inbox feels like one place. The
// action area does not, and deliberately so.
//
// A messaging conversation ends in a composer: type, send. Email ends in an
// approval. Drafts are written by a GPT or by a lifecycle automation, and
// `public.approve_email_draft` is what releases one towards the send pipeline;
// the CRM has no direct-send path and this screen does not add one. Replacing
// that with a composer would route around the approval safeguard that exists
// precisely because a machine wrote the words.

import { useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { ClientContextStrip } from '../components/ClientContextStrip';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
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
      // The key names the record the Gmail thread context is keyed by, so the
      // read is filtered in the database rather than by scanning every email.
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
      return { thread, actionable };
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

  const { thread, actionable } = data;

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
          // An address the CRM has never seen is still real work. It renders by
          // address, with the context strip simply absent rather than broken.
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
              // The database would refuse anyway; saying so is kinder than a
              // button that always fails.
              <p className="notice" role="status">{copy.approvalNotYours}</p>
            )
          ) : null}
        </Section>
      ) : null}

      <Section title={copy.history}>
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

      {/* Inbound mail is not stored in the CRM, so this screen must not imply
          it is showing the whole conversation. The enquiry is where the live
          Gmail thread is reachable. */}
      <p className="meta email-scope-note">
        {copy.outboundOnly}
        {thread.enquiry_id ? (
          <> <Link to={`/enquiries/${thread.enquiry_id}`}>{copy.openEnquiry}</Link>.</>
        ) : null}
      </p>
    </>
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
    history: 'Email history',
    noHistory: 'Nothing sent yet',
    noHistoryHint: 'Approved emails appear here once they leave.',
    deliveryProblem: 'delivery problem',
    outboundOnly: 'This shows email the CRM sent or drafted. Replies from the client live in the mailbox, alongside the enquiry.',
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
    history: 'История писем',
    noHistory: 'Пока ничего не отправлено',
    noHistoryHint: 'Утверждённые письма появятся здесь после отправки.',
    deliveryProblem: 'проблема с доставкой',
    outboundOnly: 'Здесь письма, которые CRM отправила или подготовила. Ответы клиента остаются в почтовом ящике, рядом с заявкой.',
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
