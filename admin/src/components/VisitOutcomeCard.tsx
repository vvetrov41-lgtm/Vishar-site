import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { formatDateTime, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi, useOptionalSession } from '../lib/session';
import { canAccess } from '../lib/permissions';
import { suggestSessionPrice, type ArtistSessionPricing } from '../lib/session-pricing';
import {
  VisitOutcomeError,
  type ConsultationOutcome,
  type PaymentMethod,
  type RecordVisitOutcomeInput,
  type VisitOutcomeContext,
  type VisitOutcomeRefusal,
  type VisitOutcomeValue,
  type WorkResult,
} from '../lib/visit-outcome-api';
import {
  OperationKeys,
  dateInputAfter,
  deferUntil,
  followUpAt,
  minutesToHoursInput,
  parseHoursInput,
  parseMoneyInput,
  previewPayment,
} from '../lib/visit-outcome';
import type { Appointment, AppointmentType } from '../lib/appointment-api';

type Step = 'ask' | 'attended' | 'consultation' | 'saved';

const TATTOO_TYPES: AppointmentType[] = ['tattoo_session', 'touch_up'];
const METHODS: PaymentMethod[] = ['cash', 'bank_transfer', 'card', 'other'];
const WORK_RESULTS: WorkResult[] = ['work_complete', 'next_session_needed', 'touch_up_needed'];

export interface VisitOutcomeCardProps {
  sessionId: string;
  /** Today already knows the client and time; the card does not wait for them. */
  subject?: string | null;
  at?: string | null;
  appointmentType?: AppointmentType | null;
  /** 'today' asks; 'panel' (appointment page) shows the saved result and allows a correction. */
  mode?: 'today' | 'panel';
  onSaved?: () => void;
}

export function VisitOutcomeCard({ sessionId, subject, at, appointmentType, mode = 'today', onSaved }: VisitOutcomeCardProps) {
  const api = useApi();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [context, setContext] = useState<VisitOutcomeContext | null>(null);
  const [pricing, setPricing] = useState<ArtistSessionPricing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [step, setStep] = useState<Step>('ask');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const keys = useRef(new OperationKeys());

  // Tattoo form
  const [hours, setHours] = useState('');
  const [price, setPrice] = useState('');
  const [received, setReceived] = useState('');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [outside, setOutside] = useState(false);
  const [work, setWork] = useState<WorkResult>('work_complete');
  const [notes, setNotes] = useState('');
  // Consultation form
  const [consultChoice, setConsultChoice] = useState<ConsultationOutcome | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const [followDate, setFollowDate] = useState('');
  const [closeEnquiry, setCloseEnquiry] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api.getVisitOutcomeContext(sessionId).then(async (data) => {
      if (cancelled) return;
      setContext(data);
      if (data.outcome?.state === 'confirmed') setStep((current) => (current === 'ask' ? 'saved' : current));
      if (data.can.view_finance && TATTOO_TYPES.includes(data.session.appointment_type)) {
        const artistPricing = await api.getArtistSessionPricing(data.session.artist_id).catch(() => null);
        if (!cancelled) setPricing(artistPricing);
      }
    }).catch((reason) => {
      if (cancelled) return;
      if (reason instanceof VisitOutcomeError && reason.refusal === 'unavailable') setUnavailable(true);
      setLoadError(reason instanceof Error ? reason.message : copy.loadFailed);
    });
    return () => { cancelled = true; };
  }, [api, sessionId, refresh, copy.loadFailed]);

  const type = context?.session.appointment_type ?? appointmentType ?? null;
  const isTattoo = type != null && TATTOO_TYPES.includes(type);
  const currency = context?.session.currency ?? 'GBP';
  const finance = context?.finance ?? null;
  const canMoney = Boolean(context?.can.finance && context?.can.view_finance);

  const workedMinutes = parseHoursInput(hours);
  const priceValue = parseMoneyInput(price);
  const receivedValue = parseMoneyInput(received, { allowZero: true });
  const suggestion = useMemo(() => {
    if (!context || !isTattoo) return null;
    const minutes = workedMinutes ?? context.session.scheduled_minutes;
    const result = suggestSessionPrice(minutes, {
      projectHourlyRate: finance?.hourly_rate ?? null,
      projectCurrency: finance?.project_currency ?? currency,
      artistPricing: pricing,
    });
    return result && result.currency === currency ? result.price : null;
  }, [context, isTattoo, workedMinutes, finance, pricing, currency]);
  const preview = previewPayment(finance, priceValue, receivedValue ?? 0, outside);

  const openAttended = useCallback(() => {
    if (!context) return;
    const saved = context.outcome?.state === 'confirmed' ? context.outcome : null;
    const minutes = saved?.worked_minutes ?? context.session.scheduled_minutes;
    setHours(minutesToHoursInput(minutes));
    const knownPrice = saved?.final_price ?? context.finance?.stored_price ?? null;
    const startPrice = knownPrice ?? suggestion;
    setPrice(startPrice != null ? String(startPrice) : '');
    setWork(saved?.work_result ?? 'work_complete');
    setNotes(saved?.notes ?? '');
    setMethod(null);
    // "Paid" on the appointment without a ledger entry: offer to confirm the
    // price only, never to record the money again.
    const paidBadge = context.session.payment_status === 'paid';
    setOutside(Boolean(saved?.paid_outside_crm) || (paidBadge && (context.finance?.deposit_paid ?? 0) + (context.finance?.invoiced_paid ?? 0) === 0));
    setReceived('');
    setError(null);
    setNotice(null);
    setStep('attended');
  }, [context, suggestion]);

  // Pre-fill "received now" with the balance once the price is known.
  useEffect(() => {
    if (step !== 'attended') return;
    if (received !== '' || outside) return;
    if (preview.dueBefore != null && preview.dueBefore > 0 && canMoney) setReceived(String(preview.dueBefore));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preview.dueBefore]);

  function refusalText(refusal: VisitOutcomeRefusal, fallback: string): string {
    return copy.refusal[refusal] ?? fallback;
  }

  async function send(outcome: VisitOutcomeValue, details: RecordVisitOutcomeInput['details']) {
    if (!context) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const request = { sessionId, outcome, details, expectedVersion: context.version };
    try {
      const result = await api.recordVisitOutcome({ ...request, operationId: keys.current.keyFor(request) });
      keys.current.reset();
      setNotice(result.aftercare_already_sent && outcome !== 'attended' ? copy.savedAftercareSent : copy.saved);
      setStep('saved');
      setRefresh((value) => value + 1);
      onSaved?.();
    } catch (reason) {
      const refusal = reason instanceof VisitOutcomeError ? reason.refusal : 'unknown';
      setError(refusalText(refusal, reason instanceof Error ? reason.message : copy.saveFailed));
      if (refusal === 'stale') {
        keys.current.reset();
        setRefresh((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  async function closeAs(outcome: 'no_show' | 'cancelled') {
    if (!context) return;
    const warning = context.aftercare_sent ? ` ${copy.aftercareCannotRecall}` : '';
    if (!await confirmDialog({
      title: outcome === 'no_show' ? copy.confirmNoShowTitle : copy.confirmCancelTitle,
      message: (isTattoo ? copy.confirmCloseTattoo : copy.confirmCloseConsultation) + warning,
      confirmLabel: outcome === 'no_show' ? copy.noShow : copy.cancelled,
      cancelLabel: cancelLabelFor(language),
      tone: 'danger',
    })) return;
    await send(outcome, notes.trim() ? { notes: notes.trim() } : {});
  }

  async function postpone() {
    if (!context) return;
    setBusy(true);
    setError(null);
    const until = deferUntil(new Date()).toISOString();
    const request = { sessionId, until, expectedVersion: context.version, kind: 'defer' };
    try {
      await api.deferVisitOutcome({ sessionId, until, expectedVersion: context.version, operationId: keys.current.keyFor(request) });
      keys.current.reset();
      setNotice(copy.postponed(formatDateTime(until, language)));
      onSaved?.();
      setRefresh((value) => value + 1);
    } catch (reason) {
      const refusal = reason instanceof VisitOutcomeError ? reason.refusal : 'unknown';
      setError(refusalText(refusal, reason instanceof Error ? reason.message : copy.saveFailed));
      if (refusal === 'stale') { keys.current.reset(); setRefresh((value) => value + 1); }
    } finally {
      setBusy(false);
    }
  }

  async function saveAttended() {
    if (workedMinutes == null) { setError(copy.invalidHours); return; }
    const details: RecordVisitOutcomeInput['details'] = { worked_minutes: workedMinutes, work_result: work };
    if (notes.trim()) details.notes = notes.trim();
    if (canMoney) {
      if (priceValue == null) { setError(copy.invalidPrice); return; }
      details.final_price = priceValue;
      const amount = outside ? 0 : receivedValue;
      if (amount == null) { setError(copy.invalidReceived); return; }
      if (preview.overBalance && !outside) { setError(copy.refusal.over_balance ?? copy.saveFailed); return; }
      if (amount > 0) {
        if (!method) { setError(copy.chooseMethod); return; }
        if (!await confirmDialog({
          title: copy.receiveConfirmTitle,
          message: `${copy.receiveConfirmMessage} ${formatMoney(amount, currency, language)}`,
          confirmLabel: copy.receiveConfirmButton,
          cancelLabel: cancelLabelFor(language),
          tone: 'primary',
        })) return;
        details.received_now = amount;
        details.payment_method = method;
      }
      if (outside) details.paid_outside_crm = true;
    }
    await send('attended', details);
  }

  async function saveConsultation() {
    if (!consultChoice) return;
    const details: RecordVisitOutcomeInput['details'] = {};
    if (notes.trim()) details.notes = notes.trim();
    if (consultChoice === 'booked') {
      if (!linked) { setError(copy.chooseBooking); return; }
      details.linked_session_id = linked;
    }
    if ((consultChoice === 'ready_to_book' || consultChoice === 'thinking') && followDate) {
      const when = followUpAt(followDate);
      if (!when) { setError(copy.invalidDate); return; }
      details.follow_up_at = when;
    }
    if (consultChoice === 'declined' && closeEnquiry) details.close_enquiry = true;
    await send(consultChoice, details);
  }

  // ------------------------------------------------------------------ render
  if (unavailable) return null;

  const title = context?.session.client_name ?? subject ?? copy.client;
  const when = context?.session.start_at ?? at ?? null;
  const header = (
    <div className="visit-outcome-head">
      <div className="title">{mode === 'today' ? title : copy.panelTitle}</div>
      <div className="meta">
        {type ? <span className="badge">{copy.type[type]}</span> : null}{' '}
        {when ? formatDateTime(when, language) : null}
        {context ? <>{' · '}<span className="badge">{copy.status[context.session.status] ?? context.session.status}</span></> : null}
      </div>
    </div>
  );

  if (!context) {
    return (
      <div className="row visit-outcome" aria-busy={!loadError}>
        {header}
        {loadError
          ? <p className="notice warn" role="alert">{loadError} <button type="button" className="badge" onClick={() => setRefresh((v) => v + 1)}>{copy.retry}</button></p>
          : <p className="meta">{copy.loading}</p>}
      </div>
    );
  }

  const saved = context.outcome?.state === 'confirmed' ? context.outcome : null;
  const mayRecord = context.can.record;
  const factLine = isTattoo && context.can.view_finance && finance
    ? [
      finance.deposit_paid > 0 ? `${copy.depositPaid}: ${formatMoney(finance.deposit_paid, currency, language)}` : null,
      finance.invoiced_paid > 0 ? `${copy.receivedEarlier}: ${formatMoney(finance.invoiced_paid, currency, language)}` : null,
      context.session.payment_status === 'paid' && finance.deposit_paid + finance.invoiced_paid === 0 ? copy.markedPaid : null,
      finance.stored_price == null ? copy.priceMissing : null,
    ].filter(Boolean).join(' · ')
    : null;

  return (
    <div className={`row visit-outcome visit-outcome-${mode}`} data-session-id={sessionId}>
      {header}
      {factLine ? <div className="meta visit-outcome-facts">{factLine}</div> : null}
      {notice ? <p className="notice ok" role="status">{notice}</p> : null}
      {error ? <p className="notice warn" role="alert">{error}</p> : null}

      {step === 'saved' && saved ? (
        <SavedSummary context={context} language={language} />
      ) : null}
      {step === 'saved' && saved && mayRecord && mode === 'panel' ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => {
            if (isTattoo) { if (saved.outcome === 'attended') openAttended(); else setStep('ask'); }
            else { setConsultChoice(null); setStep('ask'); }
          }}>{copy.correct}</button>
        </div>
      ) : null}

      {step === 'ask' && !mayRecord ? <p className="meta">{copy.readOnly}</p> : null}

      {step === 'ask' && mayRecord ? (
        <>
          <p className="visit-outcome-question">{isTattoo ? copy.askTattoo : copy.askConsultation}</p>
          {isTattoo ? (
            <div className="visit-outcome-actions">
              <button type="button" className="primary" disabled={busy} onClick={openAttended}>{copy.attended}</button>
              <button type="button" disabled={busy} onClick={() => void closeAs('no_show')}>{copy.noShow}</button>
              <button type="button" disabled={busy} onClick={() => void closeAs('cancelled')}>{copy.cancelled}</button>
              {!saved ? <button type="button" className="secondary" disabled={busy} onClick={() => void postpone()}>{copy.later}</button> : null}
            </div>
          ) : (
            <div className="visit-outcome-actions">
              {(['booked', 'ready_to_book', 'thinking', 'declined'] as ConsultationOutcome[]).map((choice) => (
                <button key={choice} type="button" className={choice === 'booked' ? 'primary' : undefined} disabled={busy}
                  onClick={() => {
                    setConsultChoice(choice);
                    setLinked(context.bookings?.length === 1 ? context.bookings[0].id : null);
                    setFollowDate(choice === 'thinking' ? dateInputAfter(new Date(), 7) : choice === 'ready_to_book' ? dateInputAfter(new Date(), 2) : '');
                    setCloseEnquiry(false);
                    setNotes(saved?.notes ?? '');
                    setError(null);
                    setStep('consultation');
                  }}>
                  {copy.consult[choice]}
                </button>
              ))}
              <button type="button" disabled={busy} onClick={() => void closeAs('no_show')}>{copy.noShow}</button>
              {!saved ? <button type="button" className="secondary" disabled={busy} onClick={() => void postpone()}>{copy.later}</button> : null}
            </div>
          )}
        </>
      ) : null}

      {step === 'attended' ? (
        <form className="visit-outcome-form" onSubmit={(event) => { event.preventDefault(); void saveAttended(); }}>
          <label className="visit-field">
            {copy.hours}
            <input inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} aria-describedby={`vo-hours-${sessionId}`} />
            <span className="meta" id={`vo-hours-${sessionId}`}>{copy.hoursHint(minutesToHoursInput(context.session.scheduled_minutes))}</span>
          </label>

          {canMoney ? (
            <>
              <label className="visit-field">
                {copy.price(currency)}
                <input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
                {suggestion != null ? (
                  <span className="meta">
                    {copy.suggested}: {formatMoney(suggestion, currency, language)}{' '}
                    {priceValue !== suggestion ? <button type="button" className="badge" onClick={() => setPrice(String(suggestion))}>{copy.useSuggestion}</button> : null}
                  </span>
                ) : null}
              </label>

              {preview.state === 'needs_review' ? (
                <p className="notice warn">{copy.needsReview}{' '}
                  {context.session.project_id ? <Link to={`/projects/${context.session.project_id}`}>{copy.projectFinance}</Link> : null}
                </p>
              ) : (
                <>
                  <div className="visit-outcome-money meta">
                    {finance && finance.deposit_paid > 0 ? <div>{copy.depositApplied}: {formatMoney(finance.deposit_paid, currency, language)}</div> : null}
                    {finance && finance.invoiced_paid > 0 ? <div>{copy.receivedEarlier}: {formatMoney(finance.invoiced_paid, currency, language)}</div> : null}
                    {preview.dueBefore != null ? <div><strong>{copy.toCollect}: {formatMoney(preview.dueBefore, currency, language)}</strong></div> : null}
                  </div>
                  {preview.dueBefore !== 0 ? (
                    <label className="visit-check">
                      <input type="checkbox" checked={outside} onChange={(event) => { setOutside(event.target.checked); if (event.target.checked) setReceived(''); }} />
                      {copy.paidOutside}
                    </label>
                  ) : null}
                  {!outside && preview.dueBefore !== 0 ? (
                    <>
                      <label className="visit-field">
                        {copy.receivedNow(currency)}
                        <input inputMode="decimal" value={received} onChange={(event) => setReceived(event.target.value)} />
                      </label>
                      {(receivedValue ?? 0) > 0 ? (
                        <div className="visit-segment" role="group" aria-label={copy.method}>
                          {METHODS.map((value) => (
                            <button key={value} type="button" aria-pressed={method === value}
                              className={method === value ? 'primary' : undefined} onClick={() => setMethod(value)}>
                              {copy.methods[value]}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {preview.totalPaid != null ? (
                    <p className={`meta visit-outcome-total ${preview.overBalance ? 'warn' : ''}`}>
                      {copy.summary(
                        formatMoney(preview.totalPaid, currency, language),
                        formatMoney(outside ? 0 : Math.min(receivedValue ?? 0, preview.dueBefore ?? 0), currency, language),
                        formatMoney(preview.dueAfter ?? 0, currency, language),
                      )}
                      {' · '}{copy.paymentState[preview.state]}
                    </p>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <p className="meta">{copy.noFinance}</p>
          )}

          <div className="visit-segment" role="group" aria-label={copy.result}>
            {WORK_RESULTS.map((value) => (
              <button key={value} type="button" aria-pressed={work === value}
                className={work === value ? 'primary' : undefined} onClick={() => setWork(value)}>
                {copy.work[value]}
              </button>
            ))}
          </div>
          <label className="visit-field">
            {copy.notes}
            <textarea value={notes} maxLength={2000} rows={2} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="visit-outcome-actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? copy.saving : copy.save}</button>
            <button type="button" disabled={busy} onClick={() => { setStep(saved ? 'saved' : 'ask'); setError(null); }}>{copy.back}</button>
          </div>
        </form>
      ) : null}

      {step === 'consultation' && consultChoice ? (
        <form className="visit-outcome-form" onSubmit={(event) => { event.preventDefault(); void saveConsultation(); }}>
          <p className="visit-outcome-question">{copy.consult[consultChoice]}</p>
          {consultChoice === 'booked' ? (
            context.bookings && context.bookings.length > 0 ? (
              <div className="visit-segment visit-bookings" role="radiogroup" aria-label={copy.chooseBooking}>
                {context.bookings.map((booking) => (
                  <button key={booking.id} type="button" role="radio" aria-checked={linked === booking.id}
                    className={linked === booking.id ? 'primary' : undefined} onClick={() => setLinked(booking.id)}>
                    {copy.type[booking.appointment_type]} · {formatDateTime(booking.start_at, language)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="notice">{copy.noBooking}{' '}
                <Link to={`/clients/${context.session.client_id}`}>{copy.goBook}</Link>
              </p>
            )
          ) : null}
          {consultChoice === 'ready_to_book' || consultChoice === 'thinking' ? (
            <label className="visit-field">
              {copy.followUp}
              <input type="date" value={followDate} onChange={(event) => setFollowDate(event.target.value)} />
              <span className="meta">{copy.followUpHint}</span>
            </label>
          ) : null}
          {consultChoice === 'declined' && context.session.enquiry_id
            && !['declined', 'converted', 'closed'].includes(context.session.enquiry_status ?? '') ? (
              <label className="visit-check">
                <input type="checkbox" checked={closeEnquiry} onChange={(event) => setCloseEnquiry(event.target.checked)} />
                {copy.closeEnquiry}
              </label>
            ) : null}
          <label className="visit-field">
            {copy.notes}
            <textarea value={notes} maxLength={2000} rows={2} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div className="visit-outcome-actions">
            <button type="submit" className="primary"
              disabled={busy || (consultChoice === 'booked' && !linked)}>{busy ? copy.saving : copy.save}</button>
            <button type="button" disabled={busy} onClick={() => { setStep(saved ? 'saved' : 'ask'); setError(null); }}>{copy.back}</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The outcome on the appointment page: closed until opened, so a calendar list
 * does not load every appointment's finance. Available for any past visit,
 * including ones from before the Today rollout (voluntary review).
 */
export function VisitOutcomePanel({ appointment, initiallyOpen = false, onSaved }: {
  appointment: Appointment;
  initiallyOpen?: boolean;
  onSaved?: () => void;
}) {
  const session = useOptionalSession();
  const { language } = useLanguage();
  const [open, setOpen] = useState(initiallyOpen);
  const scope = session?.memberships.filter((member) => member.artist_id === appointment.artist_id) ?? [];
  const canView = session != null && canAccess(session.profile?.role, 'viewSessions', scope);
  const past = Date.parse(appointment.start_at) <= Date.now();
  if (!canView || !past || !['confirmed', 'completed', 'no_show', 'cancelled'].includes(appointment.status)) return null;
  if (!open) {
    return (
      <div className="visit-outcome-toggle" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" aria-expanded={false} onClick={() => setOpen(true)}>
          {COPY[language].panelTitle}
        </button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12 }}>
      <VisitOutcomeCard sessionId={appointment.id} appointmentType={appointment.appointment_type}
        at={appointment.start_at} mode="panel" onSaved={onSaved} />
    </div>
  );
}

export function visitOutcomeLabel(outcome: VisitOutcomeValue, language: Language): string {
  return COPY[language].outcome[outcome] ?? outcome;
}

function SavedSummary({ context, language }: { context: VisitOutcomeContext; language: Language }) {
  const copy = COPY[language];
  const outcome = context.outcome;
  if (!outcome?.outcome) return null;
  const currency = context.session.currency;
  const parts: string[] = [copy.outcome[outcome.outcome]];
  if (outcome.worked_minutes) parts.push(copy.workedFor(minutesToHoursInput(outcome.worked_minutes)));
  if (outcome.work_result) parts.push(copy.work[outcome.work_result]);
  if (outcome.final_price != null) parts.push(`${copy.priceShort}: ${formatMoney(outcome.final_price, currency, language)}`);
  if (outcome.payment_state) parts.push(copy.paymentState[outcome.payment_state]);
  if (outcome.outstanding) parts.push(`${copy.outstanding}: ${formatMoney(outcome.outstanding, currency, language)}`);
  return (
    <div className="visit-outcome-saved">
      <p className="meta"><span className="badge ok">{copy.confirmed}</span> {parts.join(' · ')}</p>
      {outcome.notes ? <p className="meta">{outcome.notes}</p> : null}
      {outcome.aftercare_sent_before_outcome && outcome.outcome !== 'attended'
        ? <p className="meta">{copy.aftercareCannotRecall}</p> : null}
    </div>
  );
}

type Copy = {
  [key: string]: any;
  refusal: Partial<Record<VisitOutcomeRefusal, string>>;
};

const COPY: Record<Language, Copy> = {
  ru: {
    client: 'Клиент',
    panelTitle: 'Итог визита',
    loading: 'Загружаю запись…',
    loadFailed: 'Не удалось загрузить запись.',
    retry: 'Повторить',
    askTattoo: 'Как прошёл сеанс?',
    askConsultation: 'Как прошла консультация?',
    attended: 'Сеанс состоялся',
    noShow: 'Клиент не пришёл',
    cancelled: 'Сеанс отменён',
    later: 'Отложить',
    readOnly: 'Итог отмечает мастер или менеджер с доступом к записям.',
    consult: {
      booked: 'Записался на тату',
      ready_to_book: 'Готов записаться, дата не выбрана',
      thinking: 'Думает',
      declined: 'Отказался',
      no_show: 'Не пришёл',
    },
    outcome: {
      attended: 'Сеанс состоялся', no_show: 'Клиент не пришёл', cancelled: 'Сеанс отменён',
      booked: 'Записался на тату', ready_to_book: 'Готов записаться', thinking: 'Думает', declined: 'Отказался',
    },
    type: {
      tattoo_session: 'Тату-сеанс', touch_up: 'Коррекция',
      in_person_consultation: 'Очная консультация', video_consultation: 'Видеоконсультация',
    },
    status: {
      draft: 'Черновик', proposed: 'Предложена', confirmed: 'Подтверждена',
      completed: 'Завершена по времени', cancelled: 'Отменена', no_show: 'Неявка',
    },
    hours: 'Фактическое время работы, часы',
    hoursHint: (h: string) => `По календарю ${h || '—'} ч. Это не подтверждено, поправь при необходимости.`,
    price: (c: string) => `Итоговая стоимость, ${c}`,
    priceShort: 'Стоимость',
    suggested: 'По ставке',
    useSuggestion: 'Подставить',
    depositPaid: 'Депозит',
    depositApplied: 'Учтён депозит',
    receivedEarlier: 'Получено ранее',
    markedPaid: 'Отмечено «оплачено», платежа в CRM нет',
    priceMissing: 'Цена не указана',
    toCollect: 'Осталось получить',
    paidOutside: 'Остаток уже получен раньше, вне CRM (новый платёж не создаётся)',
    receivedNow: (c: string) => `Получено сейчас, ${c}`,
    method: 'Способ оплаты',
    methods: { cash: 'Наличные', bank_transfer: 'Перевод', card: 'Карта', other: 'Другое' },
    summary: (total: string, now: string, left: string) => `Всего оплачено ${total}, новое поступление ${now}, остаток ${left}`,
    paymentState: {
      paid: 'Оплачено полностью', part_paid: 'Оплачено частично', unpaid: 'Не оплачено',
      needs_review: 'Нужна сверка', not_recorded: 'Оплата не указана', unknown: '',
    },
    outstanding: 'Остаток',
    needsReview: 'Платежи по этому сеансу нужно сверить в финансах проекта. Итог можно сохранить без новой оплаты.',
    projectFinance: 'Финансы проекта',
    noFinance: 'Стоимость и оплату подтвердит человек с доступом к финансам.',
    result: 'Результат',
    work: { work_complete: 'Работа завершена', next_session_needed: 'Нужен следующий сеанс', touch_up_needed: 'Нужна коррекция' },
    workedFor: (h: string) => `${h} ч`,
    notes: 'Заметки (необязательно)',
    save: 'Сохранить итог',
    saving: 'Сохраняю…',
    back: 'Назад',
    correct: 'Исправить итог',
    confirmed: 'Подтверждено',
    saved: 'Итог сохранён.',
    savedAftercareSent: 'Итог сохранён. Памятка по уходу уже ушла клиенту, отозвать её нельзя.',
    saveFailed: 'Не удалось сохранить итог.',
    postponed: (when: string) => `Отложено до ${when}.`,
    invalidHours: 'Укажи время работы в часах, например 4 или 4.5.',
    invalidPrice: 'Укажи итоговую стоимость больше нуля.',
    invalidReceived: 'Сумма должна быть числом, например 730 или 730.50.',
    chooseMethod: 'Выбери способ оплаты.',
    chooseBooking: 'Выбери запись клиента',
    invalidDate: 'Неверная дата напоминания.',
    noBooking: 'Тату-записи у клиента пока нет.',
    goBook: 'Открыть клиента и записать',
    followUp: 'Напомнить связаться',
    followUpHint: 'Напоминание создаётся только при сохранении. Клиенту ничего не отправляется. Очисти дату, если напоминание не нужно.',
    closeEnquiry: 'Закрыть заявку как отказ',
    aftercareCannotRecall: 'Памятка по уходу уже была отправлена клиенту, отозвать её нельзя.',
    confirmNoShowTitle: 'Клиент не пришёл?',
    confirmCancelTitle: 'Сеанс отменён?',
    confirmCloseTattoo: 'Запись закроется. Неотправленные памятка и сообщение о заживлении для этой записи не уйдут. Депозит не меняется.',
    confirmCloseConsultation: 'Консультация будет отмечена как неявка.',
    receiveConfirmTitle: 'Деньги получены?',
    receiveConfirmMessage: 'В CRM будет записано поступление. С клиента ничего не списывается.',
    receiveConfirmButton: 'Да, получено',
    refusal: {
      stale: 'Итог изменили в другой вкладке или на другом устройстве. Данные обновлены, проверь и сохрани снова.',
      over_balance: 'Сумма больше остатка к оплате. Депозит и прошлые платежи уже учтены.',
      needs_review: 'Платежи по сеансу нужно сверить в финансах проекта. Сохрани итог без новой оплаты.',
      money_recorded: 'По визиту уже записана оплата. Чтобы сменить итог, сначала оформи возврат в финансах проекта.',
      finance_access: 'Для стоимости и оплаты нужен доступ к финансам.',
      permission: 'Нет доступа к этой записи.',
      not_started: 'Сеанс ещё не начался.',
      not_finished: 'Консультация ещё не закончилась.',
      booking_required: 'Выбери существующую тату-запись этого клиента.',
      closed: 'Запись уже закрыта в другом месте. Открой её, чтобы изменить.',
      already_confirmed: 'Итог уже подтверждён.',
      price_below_paid: 'Стоимость меньше уже полученных денег.',
      unavailable: 'Итоги визитов пока недоступны.',
    },
  },
  en: {
    client: 'Client',
    panelTitle: 'Visit outcome',
    loading: 'Loading the appointment…',
    loadFailed: 'Could not load the appointment.',
    retry: 'Retry',
    askTattoo: 'How did the session go?',
    askConsultation: 'How did the consultation go?',
    attended: 'Session happened',
    noShow: 'Client did not come',
    cancelled: 'Session cancelled',
    later: 'Later',
    readOnly: 'The outcome is recorded by someone who manages appointments.',
    consult: {
      booked: 'Booked a tattoo',
      ready_to_book: 'Ready to book, no date yet',
      thinking: 'Thinking it over',
      declined: 'Declined',
      no_show: 'Did not come',
    },
    outcome: {
      attended: 'Session happened', no_show: 'Client did not come', cancelled: 'Session cancelled',
      booked: 'Booked a tattoo', ready_to_book: 'Ready to book', thinking: 'Thinking it over', declined: 'Declined',
    },
    type: {
      tattoo_session: 'Tattoo session', touch_up: 'Touch-up',
      in_person_consultation: 'In-person consultation', video_consultation: 'Video consultation',
    },
    status: {
      draft: 'Draft', proposed: 'Proposed', confirmed: 'Confirmed',
      completed: 'Completed by schedule', cancelled: 'Cancelled', no_show: 'No-show',
    },
    hours: 'Actual working time, hours',
    hoursHint: (h: string) => `Calendar slot ${h || '—'} h. Not confirmed; change it if needed.`,
    price: (c: string) => `Final price, ${c}`,
    priceShort: 'Price',
    suggested: 'At your rate',
    useSuggestion: 'Use',
    depositPaid: 'Deposit',
    depositApplied: 'Deposit applied',
    receivedEarlier: 'Received earlier',
    markedPaid: 'Marked "paid", no payment in the CRM',
    priceMissing: 'No price yet',
    toCollect: 'Left to collect',
    paidOutside: 'The balance was already received outside the CRM (no new payment is created)',
    receivedNow: (c: string) => `Received now, ${c}`,
    method: 'Payment method',
    methods: { cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' },
    summary: (total: string, now: string, left: string) => `Paid in total ${total}, new money now ${now}, balance ${left}`,
    paymentState: {
      paid: 'Paid in full', part_paid: 'Part paid', unpaid: 'Unpaid',
      needs_review: 'Needs review', not_recorded: 'Payment not recorded', unknown: '',
    },
    outstanding: 'Balance',
    needsReview: 'Payments for this session need review in project finances. You can save the outcome without a new payment.',
    projectFinance: 'Project finances',
    noFinance: 'Someone with finance access confirms the price and payment.',
    result: 'Result',
    work: { work_complete: 'Work complete', next_session_needed: 'Next session needed', touch_up_needed: 'Touch-up needed' },
    workedFor: (h: string) => `${h} h`,
    notes: 'Notes (optional)',
    save: 'Save outcome',
    saving: 'Saving…',
    back: 'Back',
    correct: 'Correct the outcome',
    confirmed: 'Confirmed',
    saved: 'Outcome saved.',
    savedAftercareSent: 'Outcome saved. The aftercare guide had already been sent and cannot be recalled.',
    saveFailed: 'Could not save the outcome.',
    postponed: (when: string) => `Postponed until ${when}.`,
    invalidHours: 'Enter the working time in hours, for example 4 or 4.5.',
    invalidPrice: 'Enter a final price above zero.',
    invalidReceived: 'Enter the amount as a number, for example 730 or 730.50.',
    chooseMethod: 'Choose how the money was received.',
    chooseBooking: 'Choose the client\'s booking',
    invalidDate: 'That reminder date is not valid.',
    noBooking: 'This client has no tattoo booking yet.',
    goBook: 'Open the client to book',
    followUp: 'Remind me to get in touch',
    followUpHint: 'The reminder is created only when you save. Nothing is sent to the client. Clear the date if you do not need one.',
    closeEnquiry: 'Close the enquiry as declined',
    aftercareCannotRecall: 'The aftercare guide was already sent to the client and cannot be recalled.',
    confirmNoShowTitle: 'The client did not come?',
    confirmCancelTitle: 'The session was cancelled?',
    confirmCloseTattoo: 'The appointment will be closed. Unsent aftercare and healing check-in for it will not go out. The deposit is not changed.',
    confirmCloseConsultation: 'The consultation will be marked as a no-show.',
    receiveConfirmTitle: 'Money received?',
    receiveConfirmMessage: 'This records money already received in the CRM. Nothing is charged to the client.',
    receiveConfirmButton: 'Yes, received',
    refusal: {
      stale: 'The outcome was changed in another tab or device. The card was refreshed; check it and save again.',
      over_balance: 'That is more than the remaining balance. The deposit and earlier payments are already counted.',
      needs_review: 'Payments for this session need review in project finances. Save the outcome without a new payment.',
      money_recorded: 'Money was recorded for this visit. Refund it in project finances before changing the outcome.',
      finance_access: 'Price and payment need finance access.',
      permission: 'You do not have access to this appointment.',
      not_started: 'The session has not started yet.',
      not_finished: 'The consultation has not finished yet.',
      booking_required: 'Choose an existing tattoo booking of this client.',
      closed: 'The appointment was closed elsewhere. Open it to change that.',
      already_confirmed: 'The outcome is already confirmed.',
      price_below_paid: 'The price is lower than money already received.',
      unavailable: 'Visit outcomes are not available yet.',
    },
  },
};
