import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatMoney } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type { DepositRequestResult, ProjectPaymentRequest } from '../lib/payment-api';
import type { Project, ProjectFinance } from '../lib/types';

export function ProjectDepositPanel({
  project,
  finance,
  appointments,
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
  const [result, setResult] = useState<DepositRequestResult | null>(null);
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

  async function requestDeposit(appointment: Appointment) {
    setBusy(`request:${appointment.id}`);
    setError(null);
    setResult(null);
    try {
      const next = await api.requestSessionDeposit({
        sessionId: appointment.id,
        deliveryChannel: 'copy_link',
      });
      setResult(next);
      await reloadPayments();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed);
    } finally {
      setBusy(null);
    }
  }

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

  const eligibleAppointments = appointments.filter((appointment) =>
    appointment.appointment_type === 'tattoo_session'
    && !['completed', 'cancelled', 'no_show'].includes(appointment.status)
  );

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
        <p className="notice">{copy.realWorkflowNotice}</p>
      )}

      {result ? (
        <div className="notice ok" role="status">
          <div>{copy.linkReady(formatMoney(result.amount, result.currency, language))}</div>
          <div style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
            <a href={`https://vishartattoo.com${result.public_path}`} target="_blank" rel="noreferrer">
              {`https://vishartattoo.com${result.public_path}`}
            </a>
          </div>
        </div>
      ) : null}

      {!legacyPaid && eligibleAppointments.length > 0 ? (
        <div className="list" style={{ marginTop: 12 }}>
          {eligibleAppointments.map((appointment) => {
            const existing = depositRequests.find((request) =>
              request.session_id === appointment.id
              && ['pending', 'partially_paid', 'paid'].includes(request.status)
            );
            return (
              <div className="row" key={appointment.id}>
                <div className="title">{formatDateTime(appointment.start_at, language)}</div>
                <div className="meta">{copy.duration}: {durationValue(appointment.duration_hours, language)}</div>
                {existing ? (
                  <div className="meta">
                    {copy.request}: {formatMoney(existing.amount, existing.currency, language)} · {requestStatus(existing.status, language)}
                  </div>
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => { void requestDeposit(appointment); }}
                    >
                      {busy === `request:${appointment.id}` ? copy.creating : copy.createLink}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

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

function durationValue(hours: number | null, language: 'en' | 'ru'): string {
  if (hours === null) return '—';
  if (hours < 1) return language === 'ru' ? `${Math.round(hours * 60)} мин` : `${Math.round(hours * 60)} min`;
  return language === 'ru' ? `${hours} ч` : `${hours} h`;
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
    realWorkflowNotice: 'Create a real payment request from a tattoo appointment. The amount is chosen by the server from the appointment duration, not typed into this screen.',
    duration: 'Duration',
    request: 'Deposit request',
    createLink: 'Create deposit link',
    creating: 'Creating…',
    linkReady: (amount: string) => `Deposit link created for ${amount}.`,
    loading: 'Loading payment requests…',
    loadFailed: 'Could not load project payment requests.',
    requestFailed: 'Could not create the deposit request.',
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
    realWorkflowNotice: 'Создавай реальный запрос на депозит из конкретной тату-записи. Сумму выбирает CRM по длительности записи, вручную вводить её здесь не нужно.',
    duration: 'Длительность',
    request: 'Запрос на депозит',
    createLink: 'Создать ссылку на депозит',
    creating: 'Создаём…',
    linkReady: (amount: string) => `Ссылка на депозит ${amount} создана.`,
    loading: 'Загружаем платёжные запросы…',
    loadFailed: 'Не удалось загрузить платёжные запросы проекта.',
    requestFailed: 'Не удалось создать запрос на депозит.',
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
