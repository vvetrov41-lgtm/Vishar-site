import { useEffect, useRef, useState } from 'react';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { canAccess } from '../lib/permissions';
import { Link } from '../lib/router';
import type { CheckoutWarning } from '../lib/session-checkout';
import { suggestSessionPrice } from '../lib/session-pricing';
import { useApi, useOptionalSession, useSession } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { InvoiceDocument } from '../lib/invoice-api';
import type { PaymentMethod } from '../lib/visit-outcome-api';

const RECEIPT_METHODS: PaymentMethod[] = ['cash', 'studio_direct', 'bank_transfer', 'card', 'other'];

interface CheckoutData {
  price: number | null;
  suggestion: number | null;
  invoices: InvoiceDocument[];
  depositPaid: number;
  invoicedPaid: number;
  due: number | null;
  warnings: CheckoutWarning[];
  payableInvoiceId: string | null;
}

const CHECKOUT_COPY = {
  ru: {
    toggle: 'Расчёт за сеанс',
    title: 'Оплата за этот сеанс',
    loading: 'Сверяю цену, депозит и платежи…',
    failed: 'Не удалось загрузить финансы. Проверь подключение и попробуй ещё раз.',
    missingPrice: 'Цена сеанса ещё не подтверждена. Ниже лишь предложение по ставке.',
    terminalPrice: 'Сеанс уже завершён: текущие правила CRM не позволяют изменить его цену. Для сверки используй счёт и историю платежей.',
    estimateDue: 'Предварительный остаток по ставке (не подтверждён)',
    enterPrice: 'Цена сеанса, GBP',
    price: 'Цена сеанса',
    estimated: 'Предлагаемая цена',
    savePrice: 'Подтвердить цену',
    saving: 'Сохраняю…',
    deposit: 'Оплаченный депозит',
    paid: 'Оплачено после депозита',
    due: 'Осталось взять с клиента',
    unknown: 'Нельзя безопасно рассчитать сумму. Проверь платежи в проекте.',
    received: 'Фактически получено, GBP',
    record: 'Записать полученную оплату',
    recording: 'Записываю…',
    depositEntry: 'Записать полученный депозит',
    depositAmount: 'Сумма полученного депозита',
    method: 'Как приняли деньги',
    receiptDate: 'Дата получения',
    methods: { cash: 'Наличные', studio_direct: 'Приняла студия', bank_transfer: 'Перевод', card: 'Карта', other: 'Другое' },
    invoice: 'Открыть счёт',
    payments: 'Финансы проекта',
    paidAll: 'Все платежи за сеанс учтены',
    staleStatus: 'Старый статус оплаты в записи может отличаться от фактических платежей.',
    saveConfirmTitle: 'Подтвердить стоимость сеанса?',
    saveConfirmMessage: 'Это сохранит фактическую стоимость сеанса. Для будущих записей это может повлиять на карточку бронирования клиента.',
    receiveConfirmTitle: 'Подтвердить, что деньги получены?',
    receiveConfirmMessage: 'Это создаст запись о полученных деньгах в CRM. Деньги не будут списаны с карты или счёта клиента.',
    receiveConfirmButton: 'Да, деньги получены',
    invalid: 'Введи сумму больше нуля и не больше остатка к оплате.',
    noPrice: 'Введи корректную цену сеанса до £100,000.',
    success: 'Оплата внесена в CRM.',
    priceSaved: 'Цена сеанса подтверждена.',
    warning: {
      unallocated_deposit: 'Есть оплаченный депозит без привязки к конкретному сеансу.',
      unlinked_invoice: 'В проекте есть счёт без точной привязки к сеансу.',
      mixed_invoice: 'Счёт включает несколько сеансов. Нужна отдельная сверка.',
      currency_mismatch: 'В платежах обнаружены разные валюты.',
      overpaid: 'Сумма поступлений больше сохранённой стоимости сеанса.',
      credited_invoice: 'В счёте есть корректировка/кредит. Нужна отдельная сверка.',
      incomplete_history: 'История счетов неполная. Не могу подтвердить остаток.',
    },
  },
  en: {
    toggle: 'Session checkout',
    title: 'Payment for this session',
    loading: 'Checking price, deposit and payments…',
    failed: 'Could not load finance data. Check the connection and try again.',
    missingPrice: 'The session price has not been confirmed. The rate-based figure is only a suggestion.',
    terminalPrice: 'This appointment is already closed: CRM currently blocks session-price edits. Review the linked invoice and payment ledger.',
    estimateDue: 'Provisional amount based on the rate (unconfirmed)',
    enterPrice: 'Session price, GBP',
    price: 'Session price',
    estimated: 'Suggested price',
    savePrice: 'Confirm session price',
    saving: 'Saving…',
    deposit: 'Deposit received',
    paid: 'Other payments received',
    due: 'Amount to collect now',
    unknown: 'Cannot safely calculate the balance. Review payments in this project.',
    received: 'Money actually received, GBP',
    record: 'Record money received',
    recording: 'Recording…',
    depositEntry: 'Record a deposit received',
    depositAmount: 'Deposit received',
    method: 'How the money was received',
    receiptDate: 'Date received',
    methods: { cash: 'Cash', studio_direct: 'Received by studio', bank_transfer: 'Bank transfer', card: 'Card', other: 'Other' },
    invoice: 'Open invoice',
    payments: 'Project finances',
    paidAll: 'All payments for this session accounted for',
    staleStatus: 'The appointment payment badge may lag the actual payment ledger.',
    saveConfirmTitle: 'Confirm this session price?',
    saveConfirmMessage: 'This saves the actual session price. On future appointments it can affect the client booking card.',
    receiveConfirmTitle: 'Confirm that you received these funds?',
    receiveConfirmMessage: 'This records money already received in the CRM. It does not charge the client or initiate a bank transfer.',
    receiveConfirmButton: 'Yes, funds received',
    invalid: 'Enter an amount above zero and no greater than the outstanding balance.',
    noPrice: 'Enter a valid session price up to £100,000.',
    success: 'Payment recorded in the CRM.',
    priceSaved: 'Session price saved.',
    warning: {
      unallocated_deposit: 'A paid deposit is not allocated to a specific session.',
      unlinked_invoice: 'A project invoice does not have a definite session link.',
      mixed_invoice: 'An invoice includes multiple sessions. Reconciliation is needed.',
      currency_mismatch: 'Payments contain conflicting currencies.',
      overpaid: 'Recorded receipts exceed the confirmed session price.',
      credited_invoice: 'An invoice has adjustments or credits and needs review.',
      incomplete_history: 'Invoice history is incomplete, so the due amount is not confirmed.',
    },
  },
};

function parseAmount(raw: string): number | null {
  const value = raw.trim().replace(',', '.');
  if (!/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100000 ? amount : null;
}

/** Render only a capability-scoped toggle; no API access until it is opened.
 * Isolated calendar rows in tests can render without a SessionProvider.
 */
export function SessionCheckout({ appointment, onChanged }: { appointment: Appointment; onChanged?: () => void }) {
  const session = useOptionalSession();
  const { language } = useLanguage();
  const [opened, setOpened] = useState(false);
  const memberScope = session?.memberships.filter((member) => member.artist_id === appointment.artist_id) ?? [];
  const canView = session != null && canAccess(session.profile?.role, 'viewFinance', memberScope);
  if (!appointment.project_id || !canView || !['tattoo_session', 'touch_up'].includes(appointment.appointment_type)) {
    return null;
  }
  if (!opened) {
    return (
      <div className="session-checkout" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" aria-expanded={false}
          aria-controls={`session-checkout-${appointment.id}`}
          onClick={() => setOpened(true)}>
          {CHECKOUT_COPY[language].toggle}
        </button>
      </div>
    );
  }
  return <SessionCheckoutDetails appointment={appointment} onChanged={onChanged} />;
}

/** Authentication and all ledger reads happen only after opening. */
function SessionCheckoutDetails({ appointment, onChanged }: { appointment: Appointment; onChanged?: () => void }) {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language } = useLanguage();
  const copy = CHECKOUT_COPY[language];
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [paymentInput, setPaymentInput] = useState('');
  const [depositInput, setDepositInput] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [depositMethod, setDepositMethod] = useState<PaymentMethod | ''>('');
  const [receiptDate, setReceiptDate] = useState('');
  const [depositDate, setDepositDate] = useState('');
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const [refresh, setRefresh] = useState(0);
  const paymentAttempt = useRef<{ key: string; scope: string } | null>(null);
  const depositAttempt = useRef<{ key: string; scope: string } | null>(null);

  const scopedMemberships = memberships.filter((member) => member.artist_id === appointment.artist_id);
  const canView = canAccess(profile?.role, 'viewFinance', scopedMemberships);
  const canManage = canAccess(profile?.role, 'manageFinance', scopedMemberships);
  const canEditPrice = canManage && !['completed', 'cancelled', 'no_show'].includes(appointment.status);
  const projectId = appointment.project_id;

  useEffect(() => {
    if (!open || !canView || !projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getVisitOutcomeContext(appointment.id),
      api.listInvoices({ projectId, limit: 100 }),
      api.getProjectFinance(projectId),
      api.getArtistSessionPricing(appointment.artist_id).catch(() => null),
    ]).then(async ([context, invoiceSummaries, projectFinance, artistPricing]) => {
      // A bounded invoice listing must fail closed instead of ignoring older rows.
      if (invoiceSummaries.length >= 100) {
        throw new Error(copy.warning.incomplete_history);
      }
      const documents = await Promise.all(invoiceSummaries
        .filter((row) => row.status !== 'void')
        .map((row) => api.getInvoice(row.id)));
      if (!context.finance) throw new Error(copy.failed);
      const storedPrice = context.finance.stored_price;
      const minutes = appointment.duration_hours != null
        ? Math.round(Number(appointment.duration_hours) * 60)
        : Math.round((Date.parse(appointment.end_at) - Date.parse(appointment.start_at)) / 60_000);
      const suggestion = suggestSessionPrice(minutes, {
        projectHourlyRate: projectFinance?.hourly_rate ?? null,
        projectCurrency: projectFinance?.currency ?? appointment.currency,
        artistPricing,
      });
      if (cancelled) return;
      setData({
        price: storedPrice,
        suggestion: suggestion?.currency === appointment.currency ? suggestion.price : null,
        invoices: documents.filter((document) => document.line_items.some((line) => line.session_id === appointment.id)),
        depositPaid: context.finance.deposit_paid,
        invoicedPaid: context.finance.invoiced_paid,
        due: context.finance.due,
        warnings: context.finance.warnings,
        payableInvoiceId: context.finance.payable_invoice_id,
      });
      const validSuggestion = suggestion?.currency === appointment.currency ? suggestion.price : null;
      setPriceInput(storedPrice == null ? String(validSuggestion ?? '') : String(storedPrice));
    }).catch((reason) => {
      if (!cancelled) {
        setData(null);
        setError(reason instanceof Error ? reason.message : copy.failed);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, open, canView, projectId, appointment.id, appointment.artist_id,
    appointment.currency, appointment.duration_hours, appointment.start_at, appointment.end_at, refresh, language]);

  const due = data?.due ?? null;
  const provisionalDue = data?.price == null && data?.suggestion != null && data.warnings.length === 0
    ? Math.max(0, Math.round((data.suggestion - data.depositPaid - data.invoicedPaid) * 100) / 100)
    : null;
  const canTakeReceipt = canManage && !busy && !loading
    && ['proposed', 'confirmed', 'completed'].includes(appointment.status);
  const showDepositEntry = canManage && ['proposed', 'confirmed', 'completed'].includes(appointment.status)
    && !['paid', 'refunded'].includes(appointment.payment_status);
  const canRecordDeposit = showDepositEntry && canTakeReceipt;
  const canRecordWithUnallocatedDeposit = data?.price != null && data.invoices.length === 0
    && data.warnings.length === 1 && data.warnings[0] === 'unallocated_deposit';
  const paymentLimit = due ?? (canRecordWithUnallocatedDeposit && data?.price != null
    ? data.price - data.depositPaid - data.invoicedPaid : 0);
  const showPaymentEntry = canManage && ['confirmed', 'completed'].includes(appointment.status)
    && Date.parse(appointment.start_at) <= Date.now() && !['paid', 'refunded'].includes(appointment.payment_status)
    && paymentLimit > 0 && (Boolean(data?.payableInvoiceId) || data?.invoices.length === 0);
  const validReceipt = parseAmount(paymentInput);
  const canRecord = showPaymentEntry && canTakeReceipt && method !== ''
    && validReceipt != null && validReceipt <= paymentLimit;

  useEffect(() => {
    setPaymentInput(due != null && due > 0 ? String(due) : '');
  }, [due]);

  async function confirmPrice() {
    const price = parseAmount(priceInput);
    if (price == null) { setError(copy.noPrice); return; }
    if (!await confirmDialog({
      title: copy.saveConfirmTitle,
      message: copy.saveConfirmMessage,
      confirmLabel: copy.savePrice,
      cancelLabel: cancelLabelFor(language),
      tone: 'primary',
    })) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.setAppointmentPrice(appointment.id, price);
      setNotice(copy.priceSaved);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  function idempotencyKey(ref: typeof paymentAttempt, scope: string): string {
    if (ref.current?.scope !== scope) ref.current = { scope, key: crypto.randomUUID() };
    return ref.current.key;
  }

  async function recordReceived(purpose: 'deposit' | 'session_balance') {
    const isDeposit = purpose === 'deposit';
    const amount = parseAmount(isDeposit ? depositInput : paymentInput);
    const receiptMethod = isDeposit ? depositMethod : method;
    const receivedDate = isDeposit ? depositDate : receiptDate;
    const occurredAt = receivedDate ? new Date(`${receivedDate}T00:00`).toISOString() : undefined;
    if (amount == null || !receiptMethod || (receivedDate && receivedDate > today) || (isDeposit ? !canRecordDeposit : !canRecord)) return;
    if (!await confirmDialog({
      title: copy.receiveConfirmTitle,
      message: copy.receiveConfirmMessage + ' ' + formatMoney(amount, appointment.currency, language),
      confirmLabel: copy.receiveConfirmButton,
      cancelLabel: cancelLabelFor(language),
      tone: 'primary',
    })) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const attempt = isDeposit ? depositAttempt : paymentAttempt;
    try {
      const receipt = await api.recordSessionReceipt({
        sessionId: appointment.id, purpose, method: receiptMethod, amount, occurredAt,
        requestId: idempotencyKey(attempt, `${appointment.id}:${purpose}:${amount}:${receiptMethod}:${occurredAt ?? ''}`),
      });
      if (!receipt.confirmed) throw new Error(copy.failed);
      attempt.current = null;
      if (isDeposit) {
        setDepositInput('');
        setDepositMethod('');
        setDepositDate('');
      } else {
        setPaymentInput('');
        setMethod('');
        setReceiptDate('');
      }
      setNotice(copy.success);
      setRefresh((value) => value + 1);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!projectId || !canView || !['tattoo_session', 'touch_up'].includes(appointment.appointment_type)) return null;

  return (
    <div className="session-checkout" style={{ marginTop: 12 }}>
      <button
        type="button"
        className="secondary"
        aria-expanded={open}
        aria-controls={`session-checkout-${appointment.id}`}
        onClick={() => setOpen((value) => !value)}
      >
        {copy.toggle}
      </button>
      {open ? (
        <div
          id={`session-checkout-${appointment.id}`}
          className="notice"
          role="region"
          aria-label={copy.title}
          style={{ marginTop: 8, minWidth: 0 }}
        >
          <strong>{copy.title}</strong>
          {loading ? <p className="meta" role="status">{copy.loading}</p> : null}
          {error ? <p className="notice warn" role="alert">{error}</p> : null}
          {notice ? <p className="notice ok" role="status">{notice}</p> : null}
          {data ? (
            <>
              {data.price == null ? (
                <p className="notice warn">{copy.missingPrice}</p>
              ) : null}
              {canEditPrice && (data.price == null || data.price > 0) ? (
                <div className="actions" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label style={{ flex: '1 1 145px', minWidth: 0 }}>
                    <span>{copy.enterPrice.replace('GBP', appointment.currency)}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={priceInput}
                      onChange={(event) => setPriceInput(event.target.value)}
                      aria-label={`${copy.enterPrice} (${appointment.currency})`}
                      disabled={busy}
                    />
                  </label>
                  <button type="button" disabled={busy || parseAmount(priceInput) == null || Number(priceInput) === data.price} onClick={() => { void confirmPrice(); }}>
                    {busy ? copy.saving : copy.savePrice}
                  </button>
                </div>
              ) : null}
              {!canEditPrice && data.price == null ? <p className="meta">{copy.terminalPrice}</p> : null}
              {data.price == null && data.suggestion != null ? (
                <p className="meta">{copy.estimated}: {formatMoney(data.suggestion, appointment.currency, language)}</p>
              ) : null}
              {provisionalDue != null ? (
                <p className="notice warn">{copy.estimateDue}: <strong>{formatMoney(provisionalDue, appointment.currency, language)}</strong></p>
              ) : null}
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '6px 12px', margin: '12px 0', alignItems: 'baseline' }}>
                <dt>{copy.price}</dt>
                <dd style={{ margin: 0 }}>{data.price == null ? '—' : formatMoney(data.price, appointment.currency, language)}</dd>
                <dt>{copy.deposit}</dt>
                <dd style={{ margin: 0 }}>−{formatMoney(data.depositPaid, appointment.currency, language)}</dd>
                <dt>{copy.paid}</dt>
                <dd style={{ margin: 0 }}>−{formatMoney(data.invoicedPaid, appointment.currency, language)}</dd>
                <dt><strong>{copy.due}</strong></dt>
                <dd style={{ margin: 0 }}><strong>{due == null ? '—' : formatMoney(due, appointment.currency, language)}</strong></dd>
              </dl>
              {data.warnings.length ? (
                <div className="notice warn" role="status">
                  {copy.unknown}
                  <ul style={{ marginBottom: 0 }}>
                    {data.warnings.map((warning: CheckoutWarning) => (
                      <li key={warning}>{copy.warning[warning]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {data.price != null && appointment.payment_status !== 'paid' && due === 0 ? (
                <p className="meta">{copy.staleStatus}</p>
              ) : null}
              {due === 0 ? <p className="notice ok">{copy.paidAll}</p> : null}
              {showPaymentEntry ? (
                <div className="actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ flex: '1 1 145px', minWidth: 0 }}>
                    <span>{copy.received.replace('GBP', appointment.currency)}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={paymentInput}
                      onChange={(event) => setPaymentInput(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span>{copy.method}</span>
                    <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)} disabled={busy}>
                      <option value="">—</option>
                      {RECEIPT_METHODS.map((value) => <option key={value} value={value}>{copy.methods[value]}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{copy.receiptDate}</span>
                    <input type="date" value={receiptDate || today} max={today} onChange={(event) => setReceiptDate(event.target.value)} disabled={busy} />
                  </label>
                  <button type="button" className="primary" disabled={!canRecord} onClick={() => { void recordReceived('session_balance'); }}>
                    {busy ? copy.recording : copy.record}
                  </button>
                </div>
              ) : null}
              {showDepositEntry ? (
                <details>
                  <summary>{copy.depositEntry}</summary>
                  <div className="actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <label>
                      <span>{copy.depositAmount} ({appointment.currency})</span>
                      <input inputMode="decimal" value={depositInput} onChange={(event) => setDepositInput(event.target.value)} disabled={busy} />
                    </label>
                    <label>
                      <span>{copy.method}</span>
                      <select value={depositMethod} onChange={(event) => setDepositMethod(event.target.value as typeof depositMethod)} disabled={busy}>
                        <option value="">—</option>
                        {RECEIPT_METHODS.map((value) => <option key={value} value={value}>{copy.methods[value]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{copy.receiptDate}</span>
                      <input type="date" value={depositDate || today} max={today} onChange={(event) => setDepositDate(event.target.value)} disabled={busy} />
                    </label>
                    <button type="button" className="primary" disabled={!canRecordDeposit || !depositMethod || parseAmount(depositInput) == null}
                      onClick={() => { void recordReceived('deposit'); }}>
                      {copy.depositEntry}
                    </button>
                  </div>
                </details>
              ) : null}
              <div className="actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {data.invoices.map((document) => (
                  <Link key={document.invoice.id} to={`/invoices/${document.invoice.id}`}>
                    {copy.invoice} {document.invoice.invoice_number}
                  </Link>
                ))}
                <Link to={`/projects/${projectId}`}>{copy.payments}</Link>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
