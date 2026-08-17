import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LoadingState } from '../components/StateViews';
import type { Appointment } from '../lib/appointment-api';
import { useArtistScope } from '../lib/artist-scope';
import {
  canManageMonzoConnection,
  monzoConnectorAlias,
  monzoSetupUrl,
  readMonzoConnectorOrigin,
} from '../lib/monzo-connector';
import { paymentCopy, type PaymentCopy } from '../lib/payment-copy';
import type {
  DepositRequestResult,
  DepositTier,
  MonzoDepositSettings,
  MonzoReconciliationCandidate,
  MonzoReconciliationRequestSummary,
} from '../lib/payment-api';
import { useApi, useSession } from '../lib/session';
import { useLanguage, type Language } from '../lib/i18n';

const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
const MONZO_CONNECTOR_ORIGIN = readMonzoConnectorOrigin(browserEnv, import.meta.env.DEV);

const DEFAULT_DEPOSIT_TIERS: DepositTier[] = [
  { max_minutes: 60, amount: 50, currency: 'GBP' },
  { max_minutes: 180, amount: 100, currency: 'GBP' },
  { max_minutes: 300, amount: 150, currency: 'GBP' },
  { max_minutes: null, amount: 250, currency: 'GBP' },
];

const EMPTY_SETTINGS: MonzoDepositSettings = {
  configured: false,
  enabled: false,
  payment_url: null,
  deposit_amount: 250,
  deposit_policy: 'duration_tiered_v1',
  deposit_tiers: DEFAULT_DEPOSIT_TIERS,
  currency: 'GBP',
  default_delivery_channel: 'email',
  email_status: 'provider_not_connected',
  sms_status: 'not_configured',
  monzo_api_status: 'not_connected',
};

function depositAmountForAppointment(appointment: Appointment, tiers: DepositTier[]): number | null {
  const start = new Date(appointment.start_at).getTime();
  const end = new Date(appointment.end_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const durationMinutes = Math.ceil((end - start) / 60_000);
  const tier = tiers.find((candidate) => candidate.max_minutes == null || durationMinutes <= candidate.max_minutes);
  return tier?.amount ?? null;
}

function money(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function requestSummaryLabel(
  request: MonzoReconciliationRequestSummary,
  locale: string,
  copy: PaymentCopy,
): string {
  const session = request.session_start_at
    ? new Date(request.session_start_at).toLocaleString(locale)
    : copy.noSessionDate;
  return `${request.client_name} · ${session} · ${money(request.outstanding_amount, request.currency, locale)} ${copy.outstanding}`;
}

function candidateStatusLabel(
  candidate: MonzoReconciliationCandidate,
  language: Language,
  copy: PaymentCopy,
): string {
  if (candidate.confirmed) return copy.statusConfirmed;
  if (candidate.status === 'candidate') return copy.statusSuggested;
  if (candidate.status === 'matched') return copy.statusMatched;
  if (candidate.status === 'ignored') return copy.statusIgnored;
  if (candidate.status === 'ambiguous') return language === 'ru' ? 'Неоднозначное совпадение' : 'Ambiguous match';
  return language === 'ru' ? 'Не сопоставлен' : 'Unmatched';
}

function paymentRequestStatusLabel(status: string | undefined, language: Language): string | null {
  if (!status) return null;
  const ru: Record<string, string> = {
    pending: 'ожидает оплаты',
    partially_paid: 'частично оплачен',
    paid: 'оплачен',
    cancelled: 'отменён',
    expired: 'истёк',
  };
  const en: Record<string, string> = {
    pending: 'pending',
    partially_paid: 'partially paid',
    paid: 'paid',
    cancelled: 'cancelled',
    expired: 'expired',
  };
  return (language === 'ru' ? ru : en)[status] ?? status.replace(/_/g, ' ');
}

export function PaymentsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language, locale, label } = useLanguage();
  const copy = useMemo(() => paymentCopy(language), [language]);
  const { artists, selectedArtistId, loading: artistScopeLoading } = useArtistScope();
  const [settings, setSettings] = useState<MonzoDepositSettings>(EMPTY_SETTINGS);
  const [paymentUrl, setPaymentUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [reconciliationCandidates, setReconciliationCandidates] = useState<MonzoReconciliationCandidate[]>([]);
  const [matchSelection, setMatchSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [busyCandidate, setBusyCandidate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DepositRequestResult | null>(null);
  const [reconciliationNotice, setReconciliationNotice] = useState<string | null>(null);

  const selectedArtist = useMemo(
    () => artists.find((artist) => artist.id === selectedArtistId) ?? null,
    [artists, selectedArtistId]
  );
  const selectedMembership = useMemo(
    () => memberships.find((membership) => membership.artist_id === selectedArtistId && membership.is_active) ?? null,
    [memberships, selectedArtistId]
  );
  const canViewReconciliation = profile?.role === 'owner' || Boolean(selectedMembership?.can_view_finance);
  const canManageReconciliation = profile?.role === 'owner' || Boolean(selectedMembership?.can_manage_finance);
  const selectedMonzoAlias = monzoConnectorAlias(selectedArtist?.slug);
  const canManageConnection = canManageMonzoConnection(profile?.role);
  const monzoNotice = useMemo(() => {
    if (!selectedMonzoAlias || !selectedArtist) return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get('artist') !== selectedMonzoAlias) return null;
    const result = params.get('monzo');
    if (result === 'authorized') return copy.connectionAuthorized(selectedArtist.display_name);
    if (result === 'connected') return copy.connectionConnected(selectedArtist.display_name);
    if (result === 'disconnected') return copy.connectionDisconnected(selectedArtist.display_name);
    return null;
  }, [selectedMonzoAlias, selectedArtist, copy]);

  const eligibleAppointments = useMemo(() => {
    const now = Date.now();
    return appointments.filter((appointment) =>
      appointment.appointment_type === 'tattoo_session'
      && Boolean(appointment.project_id)
      && !['completed', 'cancelled', 'no_show'].includes(appointment.status)
      && new Date(appointment.end_at).getTime() >= now
    );
  }, [appointments]);

  function setCandidateDefaults(candidates: MonzoReconciliationCandidate[]) {
    const next: Record<string, string> = {};
    for (const candidate of candidates) {
      const preferred = candidate.matched_payment_request?.payment_request_id
        ?? candidate.suggested_payment_request?.payment_request_id
        ?? candidate.match_options[0]?.payment_request_id
        ?? '';
      next[candidate.id] = preferred;
    }
    setMatchSelection(next);
  }

  async function reload(artistId: string) {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextAppointments, nextCandidates] = await Promise.all([
        api.getMonzoDepositSettings(artistId),
        api.listAppointments({ artistId, appointmentType: 'tattoo_session' }),
        canViewReconciliation ? api.listMonzoReconciliationCandidates(artistId) : Promise.resolve([]),
      ]);
      setSettings(nextSettings);
      setPaymentUrl(nextSettings.payment_url ?? '');
      setEnabled(nextSettings.enabled);
      setAppointments(nextAppointments);
      setReconciliationCandidates(nextCandidates);
      setCandidateDefaults(nextCandidates);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.loadError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setResult(null);
    setReconciliationNotice(null);
    if (!selectedArtistId) {
      setSettings(EMPTY_SETTINGS);
      setPaymentUrl('');
      setEnabled(false);
      setAppointments([]);
      setReconciliationCandidates([]);
      setMatchSelection({});
      return;
    }
    void reload(selectedArtistId);
  }, [selectedArtistId, canViewReconciliation, language]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId) return;
    setSaving(true);
    setError(null);
    try {
      await api.configureMonzoDeposit({ artistId: selectedArtistId, paymentUrl, enabled });
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function requestDeposit(sessionId: string, deliveryChannel: 'email' | 'copy_link') {
    setBusySession(sessionId);
    setError(null);
    setResult(null);
    try {
      const next = await api.requestSessionDeposit({ sessionId, deliveryChannel });
      setResult(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestError);
    } finally {
      setBusySession(null);
    }
  }

  async function matchCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation) return;
    const paymentRequestId = matchSelection[candidate.id];
    if (!paymentRequestId) {
      setError(copy.chooseRequestError);
      return;
    }
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      await api.matchMonzoReconciliationCandidate({ candidateId: candidate.id, paymentRequestId });
      setReconciliationNotice(copy.matchSuccess);
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.matchError);
    } finally {
      setBusyCandidate(null);
    }
  }

  async function ignoreCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation || candidate.confirmed) return;
    if (!window.confirm(copy.ignorePrompt(money(candidate.amount, candidate.currency, locale)))) return;
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      await api.ignoreMonzoReconciliationCandidate(candidate.id);
      setReconciliationNotice(copy.ignoreSuccess);
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.ignoreError);
    } finally {
      setBusyCandidate(null);
    }
  }

  async function confirmCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation || candidate.confirmed || !candidate.matched_payment_request) return;
    const matched = candidate.matched_payment_request;
    const confirmed = window.confirm(
      copy.confirmPrompt(money(candidate.amount, candidate.currency, locale), matched.client_name)
    );
    if (!confirmed) return;
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      const next = await api.confirmMonzoReconciliationCandidate(candidate.id);
      setReconciliationNotice(copy.confirmSuccess(paymentRequestStatusLabel(next.payment_request_status, language)));
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.confirmError);
    } finally {
      setBusyCandidate(null);
    }
  }

  if (artistScopeLoading) return <LoadingState label={copy.loadingPayments} />;
  if (!selectedArtistId || !selectedArtist) {
    return <section className="panel"><div className="notice">{copy.chooseArtist}</div></section>;
  }

  return (
    <div className="page-stack">
      {canManageConnection ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{copy.connectionTitle}</h2>
              <p>{copy.connectionDescription(selectedArtist.display_name)}</p>
            </div>
          </div>

          {monzoNotice ? <div className="notice ok" role="status">{monzoNotice}</div> : null}
          {!MONZO_CONNECTOR_ORIGIN ? (
            <div className="notice">{copy.connectionDisabled}</div>
          ) : selectedMonzoAlias ? (
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => window.location.assign(
                  monzoSetupUrl(MONZO_CONNECTOR_ORIGIN, selectedMonzoAlias)
                )}
              >
                {copy.manageConnection}
              </button>
            </div>
          ) : (
            <div className="notice">{copy.noConnectorRoute}</div>
          )}
          <div className="notice">{copy.connectionSecurity}</div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.depositsTitle}</h2>
            <p>{copy.depositsDescription(selectedArtist.display_name)}</p>
          </div>
        </div>

        {loading ? <LoadingState label={copy.loadingSettings} /> : (
          <form onSubmit={saveSettings} className="form-grid">
            <label className="field field-wide">
              <span>{copy.reusablePaymentLink}</span>
              <input
                type="url"
                value={paymentUrl}
                onChange={(event) => setPaymentUrl(event.target.value)}
                placeholder="https://monzo.com/pay/r/…"
                autoComplete="off"
                required
              />
            </label>
            <label className="field checkbox-field">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              <span>{copy.enableArtist}</span>
            </label>
            <div className="notice field-wide">{copy.depositPolicyNotice}</div>
            <div className="field-wide">
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? copy.saving : copy.saveSettings}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.requestTitle}</h2>
            <p>{copy.requestDescription}</p>
          </div>
        </div>
        {eligibleAppointments.length === 0 ? <div className="notice">{copy.noEligibleAppointments}</div> : (
          <div className="list-stack">
            {eligibleAppointments.map((appointment) => {
              const depositAmount = depositAmountForAppointment(appointment, settings.deposit_tiers);
              return (
                <div className="list-row" key={appointment.id}>
                  <div>
                    <strong>{new Date(appointment.start_at).toLocaleString(locale)}</strong>
                    <div className="muted">
                      {label('sessionStatus', appointment.status)} · {label('paymentStatus', appointment.payment_status)}
                      {depositAmount == null ? '' : ` · £${depositAmount} ${copy.depositSuffix}`}
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busySession === appointment.id || !settings.enabled || depositAmount == null}
                      onClick={() => void requestDeposit(appointment.id, 'copy_link')}
                    >
                      {depositAmount == null ? copy.createPersonalLink : copy.createAmountLink(depositAmount)}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busySession === appointment.id || !settings.enabled || depositAmount == null}
                      onClick={() => void requestDeposit(appointment.id, 'email')}
                    >
                      {depositAmount == null ? copy.queueDepositEmail : copy.queueAmountEmail(depositAmount)}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {canViewReconciliation ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{copy.reconciliationTitle}</h2>
              <p>{copy.reconciliationDescription}</p>
            </div>
          </div>
          <div className="notice">{copy.reconciliationSecurity}</div>
          {reconciliationNotice ? <div className="notice ok" role="status">{reconciliationNotice}</div> : null}
          {loading ? <LoadingState label={copy.loadingReconciliation} /> : reconciliationCandidates.length === 0 ? (
            <div className="notice">{copy.noCandidates}</div>
          ) : (
            <div className="list-stack">
              {reconciliationCandidates.map((candidate) => {
                const matched = candidate.matched_payment_request;
                const selectedRequestId = matchSelection[candidate.id] ?? '';
                const canMutate = canManageReconciliation && !candidate.confirmed && candidate.status !== 'ignored';
                return (
                  <div className="list-row" key={candidate.id}>
                    <div>
                      <strong>
                        {money(candidate.amount, candidate.currency, locale)} · {candidateStatusLabel(candidate, language, copy)}
                      </strong>
                      <div className="muted">{copy.received} {new Date(candidate.occurred_at).toLocaleString(locale)}</div>
                      {matched ? (
                        <div className="muted">{copy.matched}: {requestSummaryLabel(matched, locale, copy)}</div>
                      ) : candidate.suggested_payment_request ? (
                        <div className="muted">{copy.suggested}: {requestSummaryLabel(candidate.suggested_payment_request, locale, copy)}</div>
                      ) : null}
                      {candidate.confirmed ? (
                        <div className="notice ok">{copy.confirmedLedger}</div>
                      ) : candidate.status === 'ignored' ? (
                        <div className="notice">{copy.ignoredNoChange}</div>
                      ) : null}
                    </div>

                    {canMutate ? (
                      <div className="form-grid">
                        <label className="field field-wide">
                          <span>{copy.depositRequest}</span>
                          <select
                            value={selectedRequestId}
                            onChange={(event) => setMatchSelection((current) => ({
                              ...current,
                              [candidate.id]: event.target.value,
                            }))}
                          >
                            <option value="">{copy.chooseEligibleRequest}</option>
                            {candidate.match_options.map((option) => (
                              <option key={option.payment_request_id} value={option.payment_request_id}>
                                {requestSummaryLabel(option, locale, copy)}{option.is_suggested ? ` · ${copy.suggestedSuffix}` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        {candidate.match_options.length === 0 ? (
                          <div className="notice field-wide">{copy.noExactOutstandingAmount}</div>
                        ) : null}
                        <div className="button-row field-wide">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busyCandidate === candidate.id || !selectedRequestId}
                            onClick={() => void matchCandidate(candidate)}
                          >
                            {busyCandidate === candidate.id ? copy.working : matched ? copy.changeMatch : copy.match}
                          </button>
                          {matched ? (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void confirmCandidate(candidate)}
                            >
                              {copy.confirmPayment}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busyCandidate === candidate.id}
                            onClick={() => void ignoreCandidate(candidate)}
                          >
                            {copy.ignore}
                          </button>
                        </div>
                      </div>
                    ) : !canManageReconciliation && !candidate.confirmed && candidate.status !== 'ignored' ? (
                      <div className="notice">{copy.viewOnly}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {result ? (
        <section className="panel">
          <h2>{copy.requestCreated}</h2>
          <p><strong>£{result.amount}</strong> {result.currency} · <code>{result.public_path}</code></p>
          <div className="notice">
            {result.delivery_channel === 'email' ? copy.emailQueued : copy.personalPathReady}
          </div>
        </section>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
    </div>
  );
}
