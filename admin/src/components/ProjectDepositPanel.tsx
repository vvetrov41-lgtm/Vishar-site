import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../lib/format';
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
  // The deposit request this panel just created, or an already open one that
  // still has no destination bound to it.
  const openRequestId = created?.payment_request_id ?? preview?.open_payment_request_id ?? null;

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
    if (!window.confirm(copy.manualConfirm(formatMoney(amount, request.currency, language)))) return;
    await run(
      `manual:${request.id}`,
      () => api.recordManualPayment({ paymentRequestId: request.id, amount }),
      copy.manualFailed
    );
  }

  return (
    <>
      <dl className="definition">
        <dt>{copy.projectEstimate}</dt>
        <dd>{formatMoney(preview?.estimate_total ?? finance?.estimate_total ?? null, currency, language)}</dd>
        <dt>{copy.depositPolicy}</dt>
        <dd>{policyLabel(preview, currency, language, copy)}</dd>
        <dt>{copy.calculatedDeposit}</dt>
        <dd>{calculatedAmount == null ? '—' : formatMoney(calculatedAmount, currency, language)}</dd>
        <dt>{copy.projectOverride}</dt>
        <dd>
          {preview?.override_amount == null
            ? copy.noOverride
            : formatMoney(preview.override_amount, currency, language)}
        </dd>
        <dt>{copy.paymentDestination}</dt>
        <dd>
          {calculatedAmount == null
            ? '—'
            : destinationReady
              ? copy.destinationConfigured(formatMoney(calculatedAmount, currency, language))
              : copy.destinationMissing(formatMoney(calculatedAmount, currency, language))}
        </dd>
        <dt>{copy.projectDepositStatus}</dt>
        <dd>{label('depositStatus', project.deposit_status)}</dd>
      </dl>

      <p className="notice">{copy.authoritativeNotice}</p>

      {loading ? <p className="notice">{copy.loading}</p> : null}

      {legacyPaid ? <p className="notice ok">{copy.legacyPaidNotice}</p> : null}

      {!loading && preview && !preview.policy_configured ? (
        <p className="notice warn">{copy.noPolicy}</p>
      ) : null}
      {!loading && preview?.policy_configured && !preview.calculable ? (
        <p className="notice warn">{copy.notCalculable}</p>
      ) : null}

      {!loading && !legacyPaid && calculatedAmount != null ? (
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={busy !== null || hasOpenRequest}
            onClick={() => { void createDepositRequest(); }}
          >
            {busy === 'request' ? copy.saving : copy.createRequest}
          </button>
        </div>
      ) : null}

      {hasOpenRequest && !created ? (
        <p className="notice">{copy.alreadyOpen}</p>
      ) : null}

      {created ? (
        <div className="notice ok" role="status">
          <div>{copy.requestCreated(formatMoney(created.amount, created.currency, language))}</div>
          <code style={{ wordBreak: 'break-all' }}>{created.public_path}</code>
        </div>
      ) : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}

      {!loading && calculatedAmount != null && !destinationReady ? (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: '1rem', marginBottom: 8 }}>
            {copy.destinationTitle(formatMoney(calculatedAmount, currency, language))}
          </h3>
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
        </div>
      ) : null}

      {!loading && preview?.policy_configured ? (
        <details style={{ marginTop: 14 }}>
          <summary>{copy.overrideTitle}</summary>
          <p className="notice">{copy.overrideHelp}</p>
          <label htmlFor={`deposit-override-${project.id}`}>{copy.overrideAmount}</label>
          <input
            id={`deposit-override-${project.id}`}
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={overrideInput}
            onChange={(event) => setOverrideInput(event.target.value)}
          />
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
              {busy === 'override' ? copy.saving : copy.saveOverride}
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
              {copy.clearOverride}
            </button>
          </div>
        </details>
      ) : null}

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
                          onClick={() => {
                            if (!window.confirm(copy.cancelConfirm)) return;
                            setCreated(null);
                            void run(
                              `cancel:${request.id}`,
                              () => api.cancelPaymentRequest(request.id),
                              copy.cancelFailed
                            );
                          }}
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
    en: { pending: 'pending', partially_paid: 'part paid', paid: 'paid', cancelled: 'cancelled', expired: 'expired' },
    ru: { pending: 'ожидает оплаты', partially_paid: 'частично оплачен', paid: 'оплачен', cancelled: 'отменён', expired: 'истёк' },
  } as const;
  return labels[language][status];
}

const COPY = {
  en: {
    projectEstimate: 'Project estimate',
    depositPolicy: 'Deposit policy',
    calculatedDeposit: 'Calculated deposit',
    projectOverride: 'Project override',
    paymentDestination: 'Payment destination',
    projectDepositStatus: 'Project deposit status',
    noOverride: 'none',
    noPolicyShort: 'not configured',
    policyFixed: (amount: string) => `fixed ${amount}`,
    policyPercentage: (percentage: number) => `${percentage}% of project estimate`,
    destinationConfigured: (amount: string) => `Reusable ${amount} link configured`,
    destinationMissing: (amount: string) => `No reusable ${amount} link`,
    authoritativeNotice: 'The server calculates this deposit from the project estimate, the artist deposit policy and any authorised override. The figures above are a preview; the amount is recalculated on the server when the request is created, and is immutable afterwards.',
    noPolicy: 'This artist has no project deposit policy yet. Configure one under Payments before requesting a project deposit.',
    notCalculable: 'This project deposit cannot be calculated yet. A percentage policy needs a positive project estimate.',
    loading: 'Loading payment requests…',
    loadFailed: 'Could not load project payment requests.',
    legacyPaidNotice: 'This project already has a paid deposit recorded. Check it before requesting another one.',
    createRequest: 'Create deposit request',
    alreadyOpen: 'This project already has an open or paid deposit request. Cancel the unpaid request first if the amount has to change.',
    requestCreated: (amount: string) => `Deposit request for ${amount} created. Send this path to the client:`,
    requestReady: 'The reusable payment link for this amount is in place, so the path is ready to send.',
    requestNeedsDestination: 'The request was created, but this amount has no payment destination yet. Add a reusable link or a one-off link below before sending the path.',
    requestFailed: 'Could not create the deposit request.',
    destinationTitle: (amount: string) => `Payment destination for ${amount}`,
    destinationHelp: 'A reusable link can serve every future request for this exact amount. A one-off link applies to this request only. Adding either never changes the amount and never marks anything paid.',
    reusableLink: 'Reusable Monzo payment link for this amount',
    addReusable: (amount: string) => `Add reusable ${amount} link`,
    reusableFailed: 'Could not save that reusable payment link.',
    oneOffLink: 'One-off Monzo payment link for this request',
    useOneOff: 'Use one-off link',
    oneOffFailed: 'Could not attach that one-off payment link.',
    overrideTitle: 'Override the calculated deposit',
    overrideHelp: 'An override replaces the policy suggestion for future requests only. It never reprices a deposit request that has already been sent to the client.',
    overrideAmount: 'Override amount',
    saveOverride: 'Save override',
    clearOverride: 'Clear override',
    invalidOverride: 'Enter a positive override amount.',
    overrideFailed: 'Could not save the project deposit override.',
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
    projectEstimate: 'Смета проекта',
    depositPolicy: 'Правило депозита',
    calculatedDeposit: 'Рассчитанный депозит',
    projectOverride: 'Ручная сумма по проекту',
    paymentDestination: 'Платёжное назначение',
    projectDepositStatus: 'Статус депозита проекта',
    noOverride: 'не задана',
    noPolicyShort: 'не настроено',
    policyFixed: (amount: string) => `фиксированный ${amount}`,
    policyPercentage: (percentage: number) => `${percentage}% от сметы проекта`,
    destinationConfigured: (amount: string) => `Многоразовая ссылка на ${amount} настроена`,
    destinationMissing: (amount: string) => `Нет многоразовой ссылки на ${amount}`,
    authoritativeNotice: 'Сервер рассчитывает депозит по смете проекта, правилу депозита мастера и разрешённой ручной сумме. Значения выше — предварительный расчёт; при создании запроса сумма пересчитывается на сервере и после этого не меняется.',
    noPolicy: 'Для этого мастера ещё не настроено правило депозита проекта. Настройте его в разделе «Платежи» перед запросом депозита.',
    notCalculable: 'Депозит проекта пока нельзя рассчитать. Для процентного правила нужна положительная смета проекта.',
    loading: 'Загружаем платёжные запросы…',
    loadFailed: 'Не удалось загрузить платёжные запросы проекта.',
    legacyPaidNotice: 'Для этого проекта депозит уже зафиксирован как оплаченный. Проверьте это перед созданием нового запроса.',
    createRequest: 'Создать запрос депозита',
    alreadyOpen: 'У проекта уже есть открытый или оплаченный запрос депозита. Если сумма должна измениться, сначала отмените неоплаченный запрос.',
    requestCreated: (amount: string) => `Запрос депозита на ${amount} создан. Отправьте клиенту этот путь:`,
    requestReady: 'Многоразовая ссылка на эту сумму настроена, путь готов к отправке.',
    requestNeedsDestination: 'Запрос создан, но для этой суммы ещё нет платёжного назначения. Добавьте ниже многоразовую или одноразовую ссылку перед отправкой пути.',
    requestFailed: 'Не удалось создать запрос депозита.',
    destinationTitle: (amount: string) => `Платёжное назначение для ${amount}`,
    destinationHelp: 'Многоразовая ссылка обслуживает все будущие запросы на эту же сумму. Одноразовая ссылка действует только для этого запроса. Ни то, ни другое не меняет сумму и не отмечает платёж оплаченным.',
    reusableLink: 'Многоразовая ссылка Monzo для этой суммы',
    addReusable: (amount: string) => `Добавить многоразовую ссылку на ${amount}`,
    reusableFailed: 'Не удалось сохранить многоразовую ссылку.',
    oneOffLink: 'Одноразовая ссылка Monzo для этого запроса',
    useOneOff: 'Использовать одноразовую ссылку',
    oneOffFailed: 'Не удалось привязать одноразовую ссылку.',
    overrideTitle: 'Задать сумму депозита вручную',
    overrideHelp: 'Ручная сумма заменяет расчёт по правилу только для будущих запросов. Она никогда не меняет уже отправленный клиенту запрос.',
    overrideAmount: 'Ручная сумма',
    saveOverride: 'Сохранить сумму',
    clearOverride: 'Убрать ручную сумму',
    invalidOverride: 'Введите положительную сумму.',
    overrideFailed: 'Не удалось сохранить ручную сумму депозита.',
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
