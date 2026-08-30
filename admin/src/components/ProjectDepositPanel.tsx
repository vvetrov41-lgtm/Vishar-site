import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../lib/format';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import type { Appointment } from '../lib/appointment-api';
import type {
  ProjectDepositPreview,
  ProjectDepositRequestResult,
  ProjectPaymentRequest,
} from '../lib/payment-api';
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
  const [preview, setPreview] = useState<ProjectDepositPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<ProjectDepositRequestResult | null>(null);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [overrideInput, setOverrideInput] = useState('');
  const [reusableUrl, setReusableUrl] = useState('');
  const [oneOffUrl, setOneOffUrl] = useState('');

  const depositRequests = useMemo(
    () => requests.filter((request) => request.purpose === 'deposit'),
    [requests]
  );
  const legacyPaid = project.deposit_status === 'paid' && (finance?.deposit_amount ?? 0) > 0;
  const currency = preview?.currency ?? project.currency;
  const calculatedAmount = preview?.calculable ? preview.amount ?? null : null;
  const destinationReady = preview?.reusable_destination_configured === true;
  const hasOpenRequest = Boolean(preview?.open_payment_request_id);
  const amountLocked = hasOpenRequest || legacyPaid;
  const openRequestId = created?.payment_request_id ?? preview?.open_payment_request_id ?? null;
  const formattedAmount =
    calculatedAmount == null ? null : formatMoney(calculatedAmount, currency, language);
  const suggestedAmount =
    preview?.suggested_amount == null
      ? null
      : formatMoney(preview.suggested_amount, currency, language);

  async function reload() {
    setLoading(true);
    try {
      const [nextRequests, nextPreview] = await Promise.all([
        api.listProjectPaymentRequests(project.id),
        api.previewProjectDeposit(project.id).catch(() => null),
      ]);
      setRequests(nextRequests);
      setPreview(nextPreview);
      setOverrideInput(
        nextPreview?.override_amount != null ? String(nextPreview.override_amount) : ''
      );
      setManualAmounts((current) => {
        const updated = { ...current };
        for (const request of nextRequests) {
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
    void reload();
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await reload();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(null);
    }
  }

  async function createDepositRequest() {
    setBusy('request');
    setError(null);
    setNotice(null);
    try {
      const result = await api.requestProjectDeposit({
        projectId: project.id,
        deliveryChannel: 'copy_link',
      });
      setCreated(result);
      setNotice(result.destination_ready ? copy.requestReady : copy.requestNeedsDestination);
      await reload();
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
    const approved = await confirmDialog({
      title: copy.manualConfirmTitle,
      message: copy.manualConfirm(formatMoney(amount, request.currency, language)),
      confirmLabel: copy.manualConfirmAction,
      cancelLabel: cancelLabelFor(language),
    });
    if (!approved) return;
    await run(
      `manual:${request.id}`,
      () => api.recordManualPayment({ paymentRequestId: request.id, amount }),
      copy.manualFailed
    );
  }

  return (
    <>
      <div className="notice">
        <strong>{copy.workflowTitle}</strong>
        <div style={{ marginTop: 6 }}>{copy.workflowSteps}</div>
      </div>

      {loading ? <p className="notice">{copy.loading}</p> : null}
      {legacyPaid ? <p className="notice ok">{copy.legacyPaidNotice}</p> : null}

      {!loading && preview && !preview.policy_configured ? (
        <p className="notice warn">{copy.noPolicy}</p>
      ) : null}
      {!loading && preview?.policy_configured && !preview.calculable ? (
        <p className="notice warn">{copy.notCalculable}</p>
      ) : null}

      {!loading && preview?.policy_configured && preview.calculable ? (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: '1rem', marginBottom: 6 }}>{copy.stepAmount}</h3>
          <div className="card" style={{ marginBottom: 10 }}>
            <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{copy.currentAmount}</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: 3 }}>
              {formattedAmount ?? '—'}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: '0.82rem', marginTop: 5 }}>
              {preview.override_amount == null
                ? copy.usingRecommended(suggestedAmount ?? formattedAmount ?? '—')
                : copy.usingOverride}
            </div>
          </div>

          {amountLocked ? (
            <p className="notice warn">{copy.amountLocked}</p>
          ) : (
            <>
              <label htmlFor={`deposit-override-${project.id}`}>{copy.changeAmount}</label>
              <input
                id={`deposit-override-${project.id}`}
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder={preview.suggested_amount != null ? String(preview.suggested_amount) : ''}
                value={overrideInput}
                onChange={(event) => setOverrideInput(event.target.value)}
              />
              <p className="notice">{copy.amountHelp}</p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy !== null || overrideInput.trim() === ''}
                  onClick={() => {
                    const amount = Number(overrideInput);
                    if (!Number.isFinite(amount) || amount <= 0) {
                      setError(copy.invalidOverride);
                      return;
                    }
                    void run(
                      'override',
                      () => api.setProjectDepositOverride({ projectId: project.id, amount }),
                      copy.overrideFailed
                    );
                  }}
                >
                  {busy === 'override' ? copy.saving : copy.saveAmount}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || preview.override_amount == null}
                  onClick={() => {
                    void run(
                      'override-clear',
                      () => api.setProjectDepositOverride({ projectId: project.id, amount: null }),
                      copy.overrideFailed
                    );
                  }}
                >
                  {copy.useRecommended}
                </button>
              </div>
            </>
          )}

          {!legacyPaid ? (
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: '1rem', marginBottom: 6 }}>{copy.stepLink}</h3>
              {hasOpenRequest ? (
                <p className="notice">{copy.alreadyOpen}</p>
              ) : (
                <>
                  <p className="notice">{copy.linkHelp(formattedAmount ?? '—')}</p>
                  <div className="actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null || calculatedAmount == null}
                      onClick={() => { void createDepositRequest(); }}
                    >
                      {busy === 'request'
                        ? copy.saving
                        : copy.createRequest(formattedAmount ?? '—')}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {created ? (
        <div className="notice ok" role="status" style={{ marginTop: 12 }}>
          <div>{copy.requestCreated(formatMoney(created.amount, created.currency, language))}</div>
          <code style={{ wordBreak: 'break-all' }}>{created.public_path}</code>
        </div>
      ) : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}

      {!loading && depositRequests.length > 0 ? (
        <div style={{ marginTop: 18 }}>
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
                    {request.net_paid === 0 ? (
                      <div className="actions">
                        <button
                          type="button"
                          className="danger"
                          disabled={busy !== null}
                          onClick={async () => {
                            const approvedCancel = await confirmDialog({
                              title: copy.cancelConfirmTitle,
                              message: copy.cancelConfirm,
                              confirmLabel: copy.cancelConfirmAction,
                              cancelLabel: cancelLabelFor(language),
                            });
                            if (!approvedCancel) return;
                            setCreated(null);
                            void run(
                              `cancel:${request.id}`,
                              () => api.cancelPaymentRequest(request.id),
                              copy.cancelFailed
                            );
                          }}
                        >
                          {busy === `cancel:${request.id}` ? copy.saving : copy.cancelRequest}
                        </button>
                      </div>
                    ) : null}

                    <details style={{ marginTop: 10 }}>
                      <summary>{copy.manualTitle}</summary>
                      <p className="notice">{copy.manualHelp}</p>
                      <label htmlFor={`manual-payment-${request.id}`}>{copy.manualAmount}</label>
                      <input
                        id={`manual-payment-${request.id}`}
                        type="number"
                        min="0.01"
                        max={request.outstanding_amount}
                        step="0.01"
                        inputMode="decimal"
                        value={manualAmounts[request.id] ?? ''}
                        onChange={(event) => setManualAmounts((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))}
                      />
                      <div className="actions">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => { void recordManual(request); }}
                        >
                          {busy === `manual:${request.id}` ? copy.saving : copy.recordManual}
                        </button>
                      </div>
                    </details>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && calculatedAmount != null && !destinationReady ? (
        <details style={{ marginTop: 18 }}>
          <summary>{copy.destinationAdvanced}</summary>
          <p className="notice warn">
            {copy.destinationMissing(formatMoney(calculatedAmount, currency, language))}
          </p>
          <p className="notice">{copy.destinationHelp}</p>

          <label htmlFor={`reusable-url-${project.id}`}>{copy.reusableLink}</label>
          <input
            id={`reusable-url-${project.id}`}
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://monzo.com/pay/r/…"
            value={reusableUrl}
            onChange={(event) => setReusableUrl(event.target.value)}
          />
          <div className="actions">
            <button
              type="button"
              disabled={busy !== null || !reusableUrl.trim() || !preview?.artist_id}
              onClick={() => {
                const artistId = preview?.artist_id;
                if (!artistId) return;
                void run(
                  'reusable',
                  async () => {
                    await api.upsertMonzoPaymentDestination({
                      artistId,
                      amount: calculatedAmount,
                      paymentUrl: reusableUrl.trim(),
                    });
                    setReusableUrl('');
                  },
                  copy.reusableFailed
                );
              }}
            >
              {busy === 'reusable'
                ? copy.saving
                : copy.addReusable(formatMoney(calculatedAmount, currency, language))}
            </button>
          </div>

          {openRequestId ? (
            <>
              <label htmlFor={`one-off-url-${project.id}`} style={{ marginTop: 12 }}>
                {copy.oneOffLink}
              </label>
              <input
                id={`one-off-url-${project.id}`}
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://monzo.com/pay/r/…"
                value={oneOffUrl}
                onChange={(event) => setOneOffUrl(event.target.value)}
              />
              <div className="actions">
                <button
                  type="button"
                  disabled={busy !== null || !oneOffUrl.trim()}
                  onClick={() => {
                    void run(
                      'one-off',
                      async () => {
                        await api.attachMonzoOneOffPaymentDestination({
                          paymentRequestId: openRequestId,
                          paymentUrl: oneOffUrl.trim(),
                        });
                        setOneOffUrl('');
                      },
                      copy.oneOffFailed
                    );
                  }}
                >
                  {busy === 'one-off' ? copy.saving : copy.useOneOff}
                </button>
              </div>
            </>
          ) : null}
        </details>
      ) : null}

      {!loading ? (
        <details style={{ marginTop: 18 }}>
          <summary>{copy.technicalDetails}</summary>
          <dl className="definition">
            <dt>{copy.projectEstimate}</dt>
            <dd>{formatMoney(preview?.estimate_total ?? finance?.estimate_total ?? null, currency, language)}</dd>
            <dt>{copy.depositPolicy}</dt>
            <dd>{policyLabel(preview, currency, language, copy)}</dd>
            <dt>{copy.projectDepositStatus}</dt>
            <dd>{label('depositStatus', project.deposit_status)}</dd>
            <dt>{copy.paymentDestination}</dt>
            <dd>
              {calculatedAmount == null
                ? '—'
                : destinationReady
                  ? copy.destinationConfigured(formatMoney(calculatedAmount, currency, language))
                  : copy.destinationMissing(formatMoney(calculatedAmount, currency, language))}
            </dd>
          </dl>
          <p className="notice">{copy.authoritativeNotice}</p>
        </details>
      ) : null}

      {error ? <div className="notice warn" role="alert">{error}</div> : null}
    </>
  );
}

type PanelCopy = (typeof COPY)[keyof typeof COPY];

function policyLabel(
  preview: ProjectDepositPreview | null,
  currency: string,
  language: 'en' | 'ru',
  copy: PanelCopy
): string {
  if (!preview || !preview.policy_configured) return copy.noPolicyShort;
  if (preview.mode === 'fixed') {
    return copy.policyFixed(formatMoney(preview.fixed_amount ?? null, currency, language));
  }
  return copy.policyPercentage(preview.percentage ?? 0);
}

function requestStatus(status: ProjectPaymentRequest['status'], language: 'en' | 'ru'): string {
  const labels = {
    en: {
      pending: 'waiting for payment',
      partially_paid: 'part paid',
      paid: 'paid',
      cancelled: 'cancelled',
      expired: 'expired',
    },
    ru: {
      pending: 'ожидает оплаты',
      partially_paid: 'частично оплачен',
      paid: 'оплачен',
      cancelled: 'отменён',
      expired: 'истёк',
    },
  } as const;
  return labels[language][status];
}

const COPY = {
  en: {
    workflowTitle: 'Deposit in three steps',
    workflowSteps: '1. Check the amount. 2. Create the payment link. 3. Send it to the client. When Monzo reports the payment, CRM reconciles it against that request.',
    stepAmount: '1. Deposit amount',
    currentAmount: 'Current deposit amount',
    usingRecommended: (amount: string) => `Using the recommended amount: ${amount}.`,
    usingOverride: 'Using a manual amount for this project.',
    changeAmount: 'Use a different amount',
    amountHelp: 'Enter a value only when this project needs a different deposit. Otherwise keep the recommended amount.',
    amountLocked: 'This amount is already fixed by an open or paid payment request. To change it, cancel the unpaid request below first, then set the new amount and create a new link.',
    saveAmount: 'Use this amount',
    useRecommended: 'Use recommended amount',
    stepLink: '2. Payment link',
    linkHelp: (amount: string) => `The next button creates a payment request for exactly ${amount}. After that, the amount is locked for this request.`,
    createRequest: (amount: string) => `Create deposit link for ${amount}`,
    projectEstimate: 'Project estimate',
    depositPolicy: 'Deposit policy',
    paymentDestination: 'Payment destination',
    projectDepositStatus: 'Project deposit status',
    noPolicyShort: 'not configured',
    policyFixed: (amount: string) => `fixed ${amount}`,
    policyPercentage: (percentage: number) => `${percentage}% of project estimate`,
    destinationConfigured: (amount: string) => `Reusable ${amount} link configured`,
    destinationMissing: (amount: string) => `No Monzo payment link is configured for ${amount}.`,
    authoritativeNotice: 'The server recalculates and validates the amount when the payment request is created. An issued request keeps its original amount.',
    noPolicy: 'This artist has no project deposit policy yet. Configure one under Payments before requesting a project deposit.',
    notCalculable: 'This project deposit cannot be calculated yet. A percentage policy needs a positive project estimate.',
    loading: 'Loading deposit…',
    loadFailed: 'Could not load project payment requests.',
    legacyPaidNotice: 'Deposit received. This project is already marked as paid.',
    alreadyOpen: 'A payment request already exists. Use it as-is, or cancel it below before changing the deposit amount.',
    requestCreated: (amount: string) => `Payment request for ${amount} created. Send this path to the client:`,
    requestReady: 'The payment path is ready to send.',
    requestNeedsDestination: 'The request was created, but there is no Monzo destination for this amount yet. Open “Payment link setup” below before sending it.',
    requestFailed: 'Could not create the deposit request.',
    requestsTitle: 'Existing deposit requests',
    received: 'Received',
    outstanding: 'Outstanding',
    cancelRequest: 'Cancel this request',
    cancelConfirm: 'Cancel this unpaid payment request? You can then set a different deposit amount and create a new link.',
    cancelConfirmTitle: 'Cancel payment request?',
    cancelConfirmAction: 'Cancel request',
    cancelFailed: 'Could not cancel the payment request.',
    manualTitle: 'Payment received outside automatic matching',
    manualHelp: 'Use this only when you have independently verified the money. Normal Monzo payments should be reconciled automatically.',
    manualAmount: 'Amount received',
    recordManual: 'Record manual payment',
    invalidManual: 'Enter a positive amount no greater than the outstanding balance.',
    manualConfirm: (amount: string) => `Record ${amount} as money already received outside automatic reconciliation?`,
    manualConfirmTitle: 'Record money received?',
    manualConfirmAction: 'Record payment',
    manualFailed: 'Could not record the manual payment.',
    destinationAdvanced: 'Payment link setup',
    destinationHelp: 'Normally this is configured once for an amount. A reusable link serves future requests for the same amount; a one-off link applies only to the current request.',
    reusableLink: 'Reusable Monzo payment link for this amount',
    addReusable: (amount: string) => `Save reusable ${amount} link`,
    reusableFailed: 'Could not save that reusable payment link.',
    oneOffLink: 'One-off Monzo payment link for this request',
    useOneOff: 'Use one-off link',
    oneOffFailed: 'Could not attach that one-off payment link.',
    technicalDetails: 'Calculation details',
    invalidOverride: 'Enter a positive deposit amount.',
    overrideFailed: 'Could not save the project deposit amount.',
    saving: 'Saving…',
  },
  ru: {
    workflowTitle: 'Депозит в три шага',
    workflowSteps: '1. Проверь сумму. 2. Создай ссылку на оплату. 3. Отправь её клиенту. Когда Monzo сообщит об оплате, CRM сопоставит деньги именно с этим запросом.',
    stepAmount: '1. Сумма депозита',
    currentAmount: 'Текущая сумма депозита',
    usingRecommended: (amount: string) => `Используется рекомендованная сумма: ${amount}.`,
    usingOverride: 'Для этого проекта установлена своя сумма.',
    changeAmount: 'Другая сумма депозита',
    amountHelp: 'Вводи сумму только если для этого проекта нужен другой депозит. Иначе оставь рекомендованную сумму.',
    amountLocked: 'Сумма уже зафиксирована активным или оплаченным запросом. Чтобы изменить её, сначала отмени неоплаченный запрос ниже, затем укажи новую сумму и создай новую ссылку.',
    saveAmount: 'Использовать эту сумму',
    useRecommended: 'Вернуть рекомендованную сумму',
    stepLink: '2. Ссылка на оплату',
    linkHelp: (amount: string) => `Следующая кнопка создаст запрос ровно на ${amount}. После создания сумма этого запроса уже не меняется.`,
    createRequest: (amount: string) => `Создать ссылку на депозит ${amount}`,
    projectEstimate: 'Смета проекта',
    depositPolicy: 'Правило депозита',
    paymentDestination: 'Платёжная ссылка',
    projectDepositStatus: 'Статус депозита проекта',
    noPolicyShort: 'не настроено',
    policyFixed: (amount: string) => `фиксированный ${amount}`,
    policyPercentage: (percentage: number) => `${percentage}% от сметы проекта`,
    destinationConfigured: (amount: string) => `Ссылка на ${amount} настроена`,
    destinationMissing: (amount: string) => `Для ${amount} ещё не настроена ссылка Monzo.`,
    authoritativeNotice: 'При создании платёжного запроса сервер повторно рассчитывает и проверяет сумму. Уже созданный запрос всегда сохраняет исходную сумму.',
    noPolicy: 'Для этого мастера ещё не настроено правило депозита проекта. Настрой его в разделе «Платежи» перед запросом депозита.',
    notCalculable: 'Депозит проекта пока нельзя рассчитать. Для процентного правила нужна положительная смета проекта.',
    loading: 'Загружаем депозит…',
    loadFailed: 'Не удалось загрузить платёжные запросы проекта.',
    legacyPaidNotice: 'Депозит получен. Проект уже отмечен как оплаченный.',
    alreadyOpen: 'Платёжный запрос уже создан. Используй его как есть или отмени ниже, если нужно поменять сумму депозита.',
    requestCreated: (amount: string) => `Запрос на ${amount} создан. Отправь клиенту эту ссылку:`,
    requestReady: 'Ссылка готова к отправке клиенту.',
    requestNeedsDestination: 'Запрос создан, но для этой суммы ещё нет ссылки Monzo. Открой ниже «Настройка платёжной ссылки» перед отправкой клиенту.',
    requestFailed: 'Не удалось создать запрос депозита.',
    requestsTitle: 'Запросы на депозит',
    received: 'Получено',
    outstanding: 'Осталось',
    cancelRequest: 'Отменить этот запрос',
    cancelConfirm: 'Отменить этот неоплаченный запрос? После этого можно поставить другую сумму и создать новую ссылку.',
    cancelConfirmTitle: 'Отменить запрос на оплату?',
    cancelConfirmAction: 'Отменить запрос',
    cancelFailed: 'Не удалось отменить платёжный запрос.',
    manualTitle: 'Деньги получены вне автоматического сопоставления',
    manualHelp: 'Используй это только если ты сам проверил поступление денег. Обычные платежи Monzo CRM должна сопоставлять автоматически.',
    manualAmount: 'Полученная сумма',
    recordManual: 'Зафиксировать ручную оплату',
    invalidManual: 'Введи положительную сумму не больше оставшегося баланса.',
    manualConfirm: (amount: string) => `Зафиксировать ${amount} как деньги, уже полученные вне автоматической сверки?`,
    manualConfirmTitle: 'Зафиксировать поступление?',
    manualConfirmAction: 'Зафиксировать',
    manualFailed: 'Не удалось зафиксировать ручную оплату.',
    destinationAdvanced: 'Настройка платёжной ссылки',
    destinationHelp: 'Обычно это настраивается один раз для конкретной суммы. Многоразовая ссылка работает для будущих запросов на ту же сумму, одноразовая только для текущего запроса.',
    reusableLink: 'Многоразовая ссылка Monzo для этой суммы',
    addReusable: (amount: string) => `Сохранить ссылку на ${amount}`,
    reusableFailed: 'Не удалось сохранить многоразовую ссылку.',
    oneOffLink: 'Одноразовая ссылка Monzo для этого запроса',
    useOneOff: 'Использовать одноразовую ссылку',
    oneOffFailed: 'Не удалось привязать одноразовую ссылку.',
    technicalDetails: 'Как рассчитана сумма',
    invalidOverride: 'Введи положительную сумму депозита.',
    overrideFailed: 'Не удалось сохранить сумму депозита проекта.',
    saving: 'Сохраняем…',
  },
} as const;
