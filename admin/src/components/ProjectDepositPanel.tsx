import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { ProjectPaymentRequest } from '../lib/payment-api';
import type { Project, ProjectFinance } from '../lib/types';

export function ProjectDepositPanel({
  project,
  finance,
  onChanged,
}: {
  project: Project;
  finance: ProjectFinance | null;
  appointments: Appointment[];
  onChanged: () => void;
}) {
  const api = useApi();
  const { language, label } = useLanguage();
  const copy = COPY[language];
  const [requests, setRequests] = useState<ProjectPaymentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});

  const depositRequests = useMemo(
    () => requests.filter((request) => request.purpose === 'deposit'),
    [requests]
  );
  const legacyPaid = project.deposit_status === 'paid' && (finance?.deposit_amount ?? 0) > 0;

  async function reloadPayments() {
    setLoading(true);
    try {
      const next = await api.listProjectPaymentRequests(project.id);
      setRequests(next);
      setManualAmounts((current) => {
        const updated = { ...current };
        for (const request of next) {
          if (updated[request.id] === undefined && request.outstanding_amount > 0) {
            updated[request.id] = String(request.outstanding_amount);
          }
        }
        return updated;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadPayments();
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function recordManual(request: ProjectPaymentRequest) {
    const amount = Number(manualAmounts[request.id]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > request.outstanding_amount) {
      setError(copy.invalidManual);
      return;
    }
    if (!window.confirm(copy.manualConfirm(formatMoney(amount, request.currency, language)))) return;

    setBusy(`manual:${request.id}`);
    setError(null);
    try {
      await api.recordManualPayment({ paymentRequestId: request.id, amount });
      await reloadPayments();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.manualFailed);
    } finally {
      setBusy(null);
    }
  }

  async function cancelRequest(request: ProjectPaymentRequest) {
    if (!window.confirm(copy.cancelConfirm)) return;
    setBusy(`cancel:${request.id}`);
    setError(null);
    try {
      await api.cancelPaymentRequest(request.id);
      await reloadPayments();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.cancelFailed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <dl className="definition">
        <dt>{copy.projectDeposit}</dt>
        <dd>{formatMoney(finance?.deposit_amount ?? null, project.currency, language)}</dd>
        <dt>{copy.projectDepositStatus}</dt>
        <dd>{label('depositStatus', project.deposit_status)}</dd>
      </dl>

      {legacyPaid ? (
        <p className="notice ok">{copy.legacyPaidNotice}</p>
      ) : (
        <p className="notice warn">{copy.depositLinksDormant}</p>
      )}

      {loading ? <p className="notice">{copy.loading}</p> : null}
      {!loading && depositRequests.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: '1rem', marginBottom: 8 }}>{copy.requestsTitle}</h3>
          <div className="list">
            {depositRequests.map((request) => (
              <div className="row" key={request.id}>
                <div className="title">
                  {formatMoney(request.amount, request.currency, language)} · {requestStatus(request.status, language)}
                </div>
                <div className="meta">
                  {copy.received}: {formatMoney(request.net_paid, request.currency, language)} · {copy.outstanding}: {formatMoney(request.outstanding_amount, request.currency, language)}
                </div>
                {request.outstanding_amount > 0 && ['pending', 'partially_paid'].includes(request.status) ? (
                  <>
                    <label htmlFor={`manual-payment-${request.id}`} style={{ marginTop: 10 }}>{copy.manualAmount}</label>
                    <input
                      id={`manual-payment-${request.id}`}
                      type="number"
                      min="0.01"
                      max={request.outstanding_amount}
                      step="0.01"
                      inputMode="decimal"
                      value={manualAmounts[request.id] ?? ''}
                      onChange={(event) => setManualAmounts((current) => ({ ...current, [request.id]: event.target.value }))}
                    />
                    <div className="actions">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => { void recordManual(request); }}
                      >
                        {busy === `manual:${request.id}` ? copy.saving : copy.recordManual}
                      </button>
                      {request.net_paid === 0 ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy !== null}
                          onClick={() => { void cancelRequest(request); }}
                        >
                          {copy.cancelRequest}
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <div className="notice warn" role="alert">{error}</div> : null}
    </>
  );
}

function requestStatus(status: ProjectPaymentRequest['status'], language: 'en' | 'ru'): string {
  const labels = {
    en: { pending: 'pending', partially_paid: 'part paid', paid: 'paid', cancelled: 'cancelled', expired: 'expired' },
    ru: { pending: 'ожидает оплаты', partially_paid: 'частично оплачен', paid: 'оплачен', cancelled: 'отменён', expired: 'истёк' },
  } as const;
  return labels[language][status];
}

const COPY = {
  en: {
    projectDeposit: 'Project deposit',
    projectDepositStatus: 'Project deposit status',
    legacyPaidNotice: 'This project already has a paid deposit recorded. New deposit requests are hidden to avoid charging the client twice.',
    depositLinksDormant: 'Deposit-link creation is temporarily unavailable until the public bank-transfer redirect runtime is activated. Existing requests can still be reviewed, cancelled, or reconciled manually.',
    loading: 'Loading payment requests…',
    loadFailed: 'Could not load project payment requests.',
    requestsTitle: 'Payment requests',
    received: 'Received',
    outstanding: 'Outstanding',
    manualAmount: 'Manual payment received',
    recordManual: 'Record manual payment',
    saving: 'Saving…',
    invalidManual: 'Enter a positive amount no greater than the outstanding balance.',
    manualConfirm: (amount: string) => `Record ${amount} as money already received outside automatic reconciliation?`,
    manualFailed: 'Could not record the manual payment.',
    cancelRequest: 'Cancel request',
    cancelConfirm: 'Cancel this unpaid payment request?',
    cancelFailed: 'Could not cancel the payment request.',
  },
  ru: {
    projectDeposit: 'Депозит проекта',
    projectDepositStatus: 'Статус депозита проекта',
    legacyPaidNotice: 'Для этого проекта депозит уже зафиксирован как оплаченный. Новые запросы скрыты, чтобы случайно не запросить деньги повторно.',
    depositLinksDormant: 'Создание ссылок на депозит временно недоступно, пока не активирован публичный runtime банковского редиректа. Существующие запросы можно просматривать, отменять и сверять вручную.',
    loading: 'Загружаем платёжные запросы…',
    loadFailed: 'Не удалось загрузить платёжные запросы проекта.',
    requestsTitle: 'Платёжные запросы',
    received: 'Получено',
    outstanding: 'Осталось',
    manualAmount: 'Получено вручную',
    recordManual: 'Зафиксировать ручную оплату',
    saving: 'Сохраняем…',
    invalidManual: 'Введи положительную сумму не больше оставшегося баланса.',
    manualConfirm: (amount: string) => `Зафиксировать ${amount} как деньги, уже полученные вне автоматической сверки?`,
    manualFailed: 'Не удалось зафиксировать ручную оплату.',
    cancelRequest: 'Отменить запрос',
    cancelConfirm: 'Отменить этот неоплаченный платёжный запрос?',
    cancelFailed: 'Не удалось отменить платёжный запрос.',
  },
} as const;
