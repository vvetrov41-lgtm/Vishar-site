import { useEffect, useState } from 'react';
import type { CrmRole } from '../lib/types';
import type { EnquiryReplyState, ReplyOutsideCrmChannel } from '../lib/api';
import { can } from '../lib/permissions';
import { formatDateTime } from '../lib/format';

type ReplyApi = {
  getEnquiryReplyState(enquiryId: string): Promise<EnquiryReplyState>;
  setEnquiryReplyOutsideCrm(enquiryId: string, channel: ReplyOutsideCrmChannel | null): Promise<unknown>;
};

const CHANNELS: ReplyOutsideCrmChannel[] = ['instagram', 'whatsapp', 'email', 'phone', 'in_person', 'other'];

/**
 * Whether the artist has answered this enquiry, and from what evidence
 * (crm_private.enquiry_reply_state). When the reply went out where the CRM
 * cannot see it, the operator can say so: the enquiry then counts as
 * answered, without a reply time, and stays in the statistics.
 */
export function EnquiryReplyEvidence({
  enquiryId,
  role,
  api,
  language,
}: {
  enquiryId: string;
  role: CrmRole | null | undefined;
  api: ReplyApi;
  language: 'en' | 'ru';
}) {
  const [state, setState] = useState<EnquiryReplyState | null>(null);
  const [channel, setChannel] = useState<ReplyOutsideCrmChannel>('instagram');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getEnquiryReplyState(enquiryId)
      .then((value) => { if (live) setState(value); })
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [api, enquiryId]);

  const ru = language === 'ru';
  const channelLabel: Record<ReplyOutsideCrmChannel, string> = ru
    ? { instagram: 'Instagram', whatsapp: 'WhatsApp', email: 'Email', phone: 'Телефон', in_person: 'Лично', other: 'Другое' }
    : { instagram: 'Instagram', whatsapp: 'WhatsApp', email: 'Email', phone: 'Phone', in_person: 'In person', other: 'Other' };
  const sourceLabel: Record<string, string> = ru
    ? { communication_message: 'сообщение WhatsApp/Instagram', crm_email: 'письмо из CRM', gmail_mailbox: 'письмо в Gmail' }
    : { communication_message: 'WhatsApp/Instagram message', crm_email: 'email from the CRM', gmail_mailbox: 'email in Gmail' };

  if (!state) return null;
  const canRecord = can(role, 'transitionEnquiry');

  async function save(next: ReplyOutsideCrmChannel | null) {
    setBusy(true);
    setError(null);
    try {
      await api.setEnquiryReplyOutsideCrm(enquiryId, next);
      setState(await api.getEnquiryReplyState(enquiryId));
    } catch {
      setError(ru ? 'Не удалось сохранить.' : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  let summary: string;
  if (state.first_reply_at) {
    summary = ru
      ? `Первый ответ: ${formatDateTime(state.first_reply_at, language)} (${sourceLabel[state.first_reply_source ?? ''] ?? state.first_reply_source})`
      : `First reply: ${formatDateTime(state.first_reply_at, language)} (${sourceLabel[state.first_reply_source ?? ''] ?? state.first_reply_source})`;
  } else if (state.answered) {
    summary = ru ? 'Ответ был, время первого ответа неизвестно.' : 'Answered; the first reply time is not known.';
  } else {
    summary = ru ? 'Ответа клиенту не видно ни в одном канале.' : 'No reply to the client is visible on any channel.';
  }

  return (
    <div className="enquiry-reply-evidence" style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: '0.9rem' }}>{ru ? 'Ответ клиенту' : 'Reply to the client'}</h3>
      <p style={{ margin: '0 0 8px' }}>{summary}</p>
      {state.outside_crm_channel ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0 0 8px' }}>
          {ru
            ? `Отмечено: ответ отправлен вне CRM (${channelLabel[state.outside_crm_channel]}).`
            : `Recorded: answered outside the CRM (${channelLabel[state.outside_crm_channel]}).`}
          {canRecord ? (
            <>
              {' '}
              <button type="button" className="link-button" disabled={busy} onClick={() => void save(null)}>
                {ru ? 'Отменить отметку' : 'Undo'}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {canRecord && !state.answered ? (
        <div className="actions" style={{ marginTop: 0 }}>
          <select
            aria-label={ru ? 'Канал ответа' : 'Reply channel'}
            value={channel}
            disabled={busy}
            onChange={(event) => setChannel(event.target.value as ReplyOutsideCrmChannel)}
          >
            {CHANNELS.map((value) => <option key={value} value={value}>{channelLabel[value]}</option>)}
          </select>
          <button type="button" disabled={busy} onClick={() => void save(channel)}>
            {ru ? 'Я уже ответил вне CRM' : 'I already replied outside the CRM'}
          </button>
        </div>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}
