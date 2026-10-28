import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { canAccess } from '../lib/permissions';
import { Link } from '../lib/router';
import { calculateSessionCheckout, type CheckoutWarning } from '../lib/session-checkout';
import { suggestSessionPrice } from '../lib/session-pricing';
import { useApi, useOptionalSession, useSession } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { InvoiceDocument } from '../lib/invoice-api';
import type { ProjectPaymentRequest } from '../lib/payment-api';

interface CheckoutData {
  price: number | null;
  suggestion: number | null;
  requests: ProjectPaymentRequest[];
  invoices: InvoiceDocument[];
  legacyUnallocatedDeposit: boolean;
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
export function SessionCheckout({ appointment }: { appointment: Appointment }) {
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
  return <SessionCheckoutDetails appointment={appointment} />;
}

/** Authentication and all ledger reads happen only after opening. */
function SessionCheckoutDetails({ appointment }: { appointment: Appointment }) {
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
  const [refresh, setRefresh] = useState(0);
  const paymentAttempt = useRef<{ key: string; scope: string } | null>(null);
  const invoiceCreation = useRef<{ key: string; scope: string } | null>(null);

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
      api.listSessionFinance(projectId),
      api.listProjectPaymentRequests(projectId),
      api.listInvoices({ projectId, limit: 100 }),
      api.getProjectFinance(projectId),
      api.getArtistSessionPricing(appointment.artist_id).catch(() => null),
    ]).then(async ([prices, requests, invoiceSummaries, projectFinance, artistPricing]) => {
      // A bounded invoice listing must fail closed instead of ignoring older rows.
      if (invoiceSummaries.length >= 100) {
        throw new Error(copy.warning.incomplete_history);
      }
      const documents = await Promise.all(invoiceSummaries
        .filter((row) => row.status !== 'void')
        .map((row) => api.getInvoice(row.id)));
      const storedPrice = prices.find((price) => price.session_id === appointment.id)?.price ?? null;
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
        requests,
        invoices: documents,
        legacyUnallocatedDeposit: projectFinance?.deposit_status === 'paid'
          && (projectFinance.deposit_amount ?? 0) > 0
          && !requests.some((request) => request.purpose === 'deposit' && request.net_paid > 0),
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

  const balance = useMemo(() => {
    if (!data) return null;
    const calculated = calculateSessionCheckout(appointment.id, appointment.currency, data.price, data.requests, data.invoices);
    if (!data.legacyUnallocatedDeposit) return calculated;
    return {
      ...calculated,
      due: null,
      payableInvoice: null,
      warnings: [...new Set([...calculated.warnings, 'unallocated_deposit' as const])],
    };
  }, [appointment.id, appointment.currency, data]);

  const due = balance?.due ?? null;
  const provisionalDue = data?.price == null && data?.suggestion != null && balance?.warnings.length === 0
    ? Math.max(0, Math.round((data.suggestion - balance.depositPaid - balance.invoicedPaid) * 100) / 100)
    : null;
  const validReceipt = parseAmount(paymentInput);
  const canRecord = canManage && !busy && due != null && due > 0
    && validReceipt != null && validReceipt <= due
    && (balance?.payableInvoice != null || balance?.sessionInvoices.length === 0);

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

  async function recordReceived() {
    const amount = parseAmount(paymentInput);
    if (!balance || !projectId || amount == null || !canRecord) {
      setError(copy.invalid);
      return;
    }
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
    try {
      const invoiceId = balance.payableInvoice?.invoice.id;
      if (invoiceId) {
        await api.recordInvoicePayment({
          invoiceId,
          amount,
          idempotencyKey: idempotencyKey(paymentAttempt, `${invoiceId}:${amount}`),
        });
      } else if (balance.sessionInvoices.length === 0) {
        // The invoice is exclusively for the post-deposit balance. If any step
        // fails, reload existing invoices rather than silently creating another.
        const created = await api.createInvoice({
          projectId,
          idempotencyKey: idempotencyKey(invoiceCreation, `${appointment.id}:${balance.due}`),
          notes: 'Balance for one tattoo session. Deposit recorded separately.',
        });
        await api.setInvoiceLineItem({
          invoiceId: created.invoice_id,
          sessionId: appointment.id,
          description: 'Tattoo session balance after allocated deposit',
          quantity: 1,
          unitAmount: balance.due ?? 0,
        });
        await api.issueInvoice(created.invoice_id);
        await api.recordInvoicePayment({
          invoiceId: created.invoice_id,
          amount,
          idempotencyKey: idempotencyKey(paymentAttempt, `${created.invoice_id}:${amount}`),
        });
      } else {
        throw new Error(copy.unknown);
      }
      paymentAttempt.current = null;
      invoiceCreation.current = null;
      setNotice(copy.success);
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.failed);
      // A partially created invoice is visible on the next read for recovery.
      setRefresh((value) => value + 1);
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
          {data && balance ? (
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
                <dd style={{ margin: 0 }}>−{formatMoney(balance.depositPaid, appointment.currency, language)}</dd>
                <dt>{copy.paid}</dt>
                <dd style={{ margin: 0 }}>−{formatMoney(balance.invoicedPaid, appointment.currency, language)}</dd>
                <dt><strong>{copy.due}</strong></dt>
                <dd style={{ margin: 0 }}><strong>{due == null ? '—' : formatMoney(due, appointment.currency, language)}</strong></dd>
              </dl>
              {balance.warnings.length ? (
                <div className="notice warn" role="status">
                  {copy.unknown}
                  <ul style={{ marginBottom: 0 }}>
                    {balance.warnings.map((warning: CheckoutWarning) => (
                      <li key={warning}>{copy.warning[warning]}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {data.price != null && appointment.payment_status !== 'paid' && due === 0 ? (
                <p className="meta">{copy.staleStatus}</p>
              ) : null}
              {due === 0 ? <p className="notice ok">{copy.paidAll}</p> : null}
              {canManage && due != null && due > 0 ? (
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
                  <button type="button" className="primary" disabled={!canRecord} onClick={() => { void recordReceived(); }}>
                    {busy ? copy.recording : copy.record}
                  </button>
                </div>
              ) : null}
              <div className="actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {balance.sessionInvoices.map((document) => (
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
