import { useCallback, useEffect, useId, useState } from 'react';
import { useLanguage, type Language } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi, useOptionalSession } from '../lib/session';
import { canAccess } from '../lib/permissions';
import { whatsappDigits } from '../lib/phone';
import type { Appointment } from '../lib/appointment-api';
import type { CancelledSlotCandidates, SlotCandidate, SlotCandidateReason, SlotFit, SlotState } from '../lib/cancelled-slot-api';

/**
 * Who could take a cancelled slot. Read-only: the artist copies a draft or
 * opens their own WhatsApp; the CRM sends, queues and books nothing.
 */
export function CancelledSlotPanel({ appointment, now = Date.now() }: { appointment: Appointment; now?: number }) {
  const session = useOptionalSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [open, setOpen] = useState(false);
  const scope = session?.memberships.filter((member) => member.artist_id === appointment.artist_id) ?? [];
  const canView = session != null
    && canAccess(session.profile?.role, 'viewSessions', scope)
    && canAccess(session.profile?.role, 'viewClients', scope);
  if (!canView || appointment.status !== 'cancelled' || Date.parse(appointment.start_at) <= now) return null;

  return (
    <div className="cancelled-slot" style={{ marginTop: 12 }}>
      {open ? (
        <CandidateList sessionId={appointment.id} language={language} onClose={() => setOpen(false)} />
      ) : (
        <button type="button" className="secondary" aria-expanded={false} onClick={() => setOpen(true)}>
          {copy.open}
        </button>
      )}
    </div>
  );
}

function CandidateList({ sessionId, language, onClose }: { sessionId: string; language: Language; onClose: () => void }) {
  const api = useApi();
  const copy = COPY[language];
  const [data, setData] = useState<CancelledSlotCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadError = copy.loadError;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.listCancelledSlotCandidates(sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : loadError);
    } finally {
      setLoading(false);
    }
  }, [api, sessionId, loadError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="notice" aria-label={copy.title}>
      <div className="title">{copy.title}</div>
      <p className="meta">{copy.manualOnly}</p>
      {loading ? <p className="meta">{copy.loading}</p> : null}
      {error ? (
        <p className="notice warn" role="alert">
          {error}{' '}
          <button type="button" onClick={() => { void load(); }}>{copy.retry}</button>
        </p>
      ) : null}
      {data && data.slot.state !== 'open' ? <p className="meta">{copy.state[data.slot.state]}</p> : null}
      {data && data.slot.state === 'open' && data.candidates.length === 0 ? <p className="meta">{copy.none}</p> : null}
      {data && data.slot.state === 'open' ? (
        <div className="list">
          {data.candidates.map((candidate) => (
            <CandidateRow key={candidate.client_id} candidate={candidate} slotHours={data.slot.duration_hours} language={language} />
          ))}
        </div>
      ) : null}
      <div className="actions">
        <button type="button" onClick={() => { void load(); }} disabled={loading}>{copy.refresh}</button>
        <button type="button" onClick={onClose}>{copy.close}</button>
      </div>
    </section>
  );
}

function CandidateRow({ candidate, slotHours, language }: { candidate: SlotCandidate; slotHours: number; language: Language }) {
  const copy = COPY[language];
  const [draft, setDraft] = useState(candidate.draft_message);
  const [copied, setCopied] = useState(false);
  const digits = whatsappDigits(candidate.phone);
  // Unique per rendered row: two open slot panels can list the same client.
  const fieldId = useId();

  async function copyDraft() {
    try {
      await navigator.clipboard?.writeText(draft);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="row" data-slot-candidate={candidate.client_id}>
      <div className="title">
        <Link to={`/clients/${candidate.client_id}`}>{candidate.client_name}</Link>
      </div>
      <div className="meta">
        <span className="badge">{copy.reason[candidate.reason]}</span>{' '}
        <span className={candidate.fit === 'longer' ? 'badge warn' : 'badge'}>{fitLabel(candidate.fit, candidate.needed_hours, slotHours, language)}</span>
        {candidate.project_id ? <>{' '}<Link to={`/projects/${candidate.project_id}`} className="badge">{copy.project}</Link></> : null}
        {!candidate.project_id && candidate.enquiry_id ? <>{' '}<Link to={`/enquiries/${candidate.enquiry_id}`} className="badge">{copy.enquiry}</Link></> : null}
      </div>
      <label htmlFor={fieldId} className="meta" style={{ display: 'block', marginTop: 8 }}>{copy.draft}</label>
      <textarea id={fieldId} value={draft} rows={4} style={{ width: '100%' }}
        onChange={(event) => { setDraft(event.target.value); setCopied(false); }} />
      <div className="actions">
        <button type="button" onClick={() => { void copyDraft(); }}>{copied ? copy.copied : copy.copy}</button>
        {digits ? (
          <a className="badge" href={`https://wa.me/${digits}?text=${encodeURIComponent(draft)}`} target="_blank" rel="noreferrer"
            style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}>
            {copy.whatsapp}
          </a>
        ) : <span className="meta">{copy.noPhone}</span>}
      </div>
    </div>
  );
}

function hours(value: number, language: Language): string {
  if (value < 1) return language === 'ru' ? `${Math.round(value * 60)} мин` : `${Math.round(value * 60)} min`;
  return language === 'ru' ? `${value} ч` : `${value} h`;
}

function fitLabel(fit: SlotFit, needed: number | null, slotHours: number, language: Language): string {
  const copy = COPY[language];
  if (fit === 'unknown' || needed === null) return copy.fitUnknown;
  const text = `${hours(needed, language)} / ${hours(slotHours, language)}`;
  return fit === 'fits' ? `${copy.fits}: ${text}` : `${copy.longer}: ${text}`;
}

type Copy = {
  open: string; title: string; manualOnly: string; loading: string; loadError: string; retry: string;
  none: string; refresh: string; close: string; draft: string; copy: string; copied: string;
  whatsapp: string; noPhone: string; project: string; enquiry: string;
  fits: string; longer: string; fitUnknown: string;
  reason: Record<SlotCandidateReason, string>;
  state: Record<Exclude<SlotState, 'open'>, string>;
};

const COPY: Record<Language, Copy> = {
  en: {
    open: 'Who can take this slot?',
    title: 'Fill this slot',
    manualOnly: 'Nothing is sent automatically. Copy a draft or open WhatsApp and send it yourself.',
    loading: 'Finding clients…',
    loadError: 'Could not find clients for this slot.',
    retry: 'Try again',
    none: 'No suitable clients right now.',
    refresh: 'Refresh',
    close: 'Close',
    draft: 'Draft message',
    copy: 'Copy',
    copied: 'Copied',
    whatsapp: 'Open WhatsApp',
    noPhone: 'No phone number',
    project: 'Project',
    enquiry: 'Enquiry',
    fits: 'Fits',
    longer: 'Longer than the slot',
    fitUnknown: 'Length unknown',
    reason: {
      deposit_paid_no_date: 'Deposit paid, no date',
      open_follow_up: 'Open follow-up',
      touch_up_due: 'Touch-up due',
      project_no_date: 'Project without a date',
      enquiry_awaiting_consultation: 'Waiting for a consultation',
    },
    state: {
      past: 'This time has already passed.',
      taken: 'Another appointment already uses this time.',
      not_cancelled: 'This appointment is not cancelled.',
    },
  },
  ru: {
    open: 'Кто может занять это окно?',
    title: 'Заполнить окно',
    manualOnly: 'Ничего не отправляется автоматически. Скопируй черновик или открой WhatsApp и отправь сам.',
    loading: 'Ищем клиентов…',
    loadError: 'Не удалось подобрать клиентов на это окно.',
    retry: 'Повторить',
    none: 'Сейчас подходящих клиентов нет.',
    refresh: 'Обновить',
    close: 'Закрыть',
    draft: 'Черновик сообщения',
    copy: 'Скопировать',
    copied: 'Скопировано',
    whatsapp: 'Открыть WhatsApp',
    noPhone: 'Нет телефона',
    project: 'Проект',
    enquiry: 'Заявка',
    fits: 'Подходит',
    longer: 'Дольше окна',
    fitUnknown: 'Длина неизвестна',
    reason: {
      deposit_paid_no_date: 'Депозит оплачен, даты нет',
      open_follow_up: 'Открытое напоминание',
      touch_up_due: 'Пора на коррекцию',
      project_no_date: 'Проект без даты',
      enquiry_awaiting_consultation: 'Ждёт консультацию',
    },
    state: {
      past: 'Это время уже прошло.',
      taken: 'Это время уже занято другой записью.',
      not_cancelled: 'Эта запись не отменена.',
    },
  },
};
