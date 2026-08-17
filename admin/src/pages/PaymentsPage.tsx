import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { LoadingState } from '../components/StateViews';
import type { Appointment } from '../lib/appointment-api';
import { useArtistScope } from '../lib/artist-scope';
import {
  canManageMonzoConnection,
  monzoConnectionResultNotice,
  monzoConnectorAlias,
  monzoSetupUrl,
  readMonzoConnectorOrigin,
} from '../lib/monzo-connector';
import type {
  DepositRequestResult,
  DepositTier,
  MonzoDepositSettings,
  MonzoReconciliationCandidate,
  MonzoReconciliationRequestSummary,
} from '../lib/payment-api';
import { useApi, useSession } from '../lib/session';

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

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
}

function requestSummaryLabel(request: MonzoReconciliationRequestSummary): string {
  const session = request.session_start_at
    ? new Date(request.session_start_at).toLocaleString('en-GB')
    : 'No session date';
  return `${request.client_name} · ${session} · ${money(request.outstanding_amount, request.currency)} outstanding`;
}

function candidateStatusLabel(candidate: MonzoReconciliationCandidate): string {
  if (candidate.confirmed) return 'Confirmed';
  if (candidate.status === 'candidate') return 'Suggested match';
  return candidate.status.charAt(0).toUpperCase() + candidate.status.slice(1);
}

export function PaymentsPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
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
  const monzoNotice = useMemo(
    () => selectedMonzoAlias
      ? monzoConnectionResultNotice(window.location.search, selectedMonzoAlias)
      : null,
    [selectedMonzoAlias]
  );

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
      setError(cause instanceof Error ? cause.message : 'Could not load payment settings.');
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
  }, [selectedArtistId, canViewReconciliation]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId) return;
    setSaving(true);
    setError(null);
    try {
      await api.configureMonzoDeposit({ artistId: selectedArtistId, paymentUrl, enabled });
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save payment settings.');
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
      setError(cause instanceof Error ? cause.message : 'Could not create the deposit request.');
    } finally {
      setBusySession(null);
    }
  }

  async function matchCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation) return;
    const paymentRequestId = matchSelection[candidate.id];
    if (!paymentRequestId) {
      setError('Choose an eligible deposit request first.');
      return;
    }
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      await api.matchMonzoReconciliationCandidate({ candidateId: candidate.id, paymentRequestId });
      setReconciliationNotice('Payment matched. Nothing has been marked paid yet. Confirm payment separately after checking the match.');
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not match that payment.');
    } finally {
      setBusyCandidate(null);
    }
  }

  async function ignoreCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation || candidate.confirmed) return;
    if (!window.confirm(`Ignore this ${money(candidate.amount, candidate.currency)} Monzo payment candidate? No payment status will change.`)) return;
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      await api.ignoreMonzoReconciliationCandidate(candidate.id);
      setReconciliationNotice('Payment candidate ignored. No ledger or payment status was changed.');
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not ignore that payment.');
    } finally {
      setBusyCandidate(null);
    }
  }

  async function confirmCandidate(candidate: MonzoReconciliationCandidate) {
    if (!selectedArtistId || !canManageReconciliation || candidate.confirmed || !candidate.matched_payment_request) return;
    const matched = candidate.matched_payment_request;
    const confirmed = window.confirm(
      `Confirm ${money(candidate.amount, candidate.currency)} as received for ${matched.client_name}? This writes an immutable payment ledger entry and may mark the deposit paid.`
    );
    if (!confirmed) return;
    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      const next = await api.confirmMonzoReconciliationCandidate(candidate.id);
      setReconciliationNotice(
        `Payment confirmed${next.payment_request_status ? ` · request is now ${next.payment_request_status}` : ''}.`
      );
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm that payment.');
    } finally {
      setBusyCandidate(null);
    }
  }

  if (artistScopeLoading) return <LoadingState label="Loading payments…" />;
  if (!selectedArtistId || !selectedArtist) {
    return <section className="panel"><div className="notice">Choose one artist to manage payments.</div></section>;
  }

  return (
    <div className="page-stack">
      {canManageConnection ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Monzo account connection</h2>
              <p>{selectedArtist.display_name}: protected bank-account connection for payment reconciliation.</p>
            </div>
          </div>

          {monzoNotice ? <div className="notice ok" role="status">{monzoNotice}</div> : null}
          {!MONZO_CONNECTOR_ORIGIN ? (
            <div className="notice">
              Monzo account connection is disabled in this environment. Existing deposit settings remain unchanged.
            </div>
          ) : selectedMonzoAlias ? (
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => window.location.assign(
                  monzoSetupUrl(MONZO_CONNECTOR_ORIGIN, selectedMonzoAlias)
                )}
              >
                Manage Monzo connection
              </button>
            </div>
          ) : (
            <div className="notice">This artist does not have a Monzo connector route.</div>
          )}
          <div className="notice">
            Connection opens as top-level navigation through the Access-protected Monzo connector. The CRM browser never receives Monzo access tokens, refresh tokens, webhook keys or bank account IDs.
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Deposits</h2>
            <p>{selectedArtist.display_name}: duration-based Monzo Easy Bank Transfer deposits.</p>
          </div>
        </div>

        {loading ? <LoadingState label="Loading payment settings…" /> : (
          <form onSubmit={saveSettings} className="form-grid">
            <label className="field field-wide">
              <span>Reusable Monzo payment link</span>
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
              <span>Enable for this artist</span>
            </label>
            <div className="notice field-wide">
              Deposits: up to 1 hour £50, up to 3 hours £100, up to 5 hours £150, over 5 hours / full day £250. The server calculates the amount from the appointment duration. Email: provider not connected. SMS: not configured. Monzo API: connection managed separately above.
            </div>
            <div className="field-wide">
              <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Request a deposit</h2>
            <p>The CRM calculates the deposit server-side and creates one opaque personal path. Opening it never marks the deposit as paid.</p>
          </div>
        </div>
        {eligibleAppointments.length === 0 ? <div className="notice">No eligible future tattoo appointments.</div> : (
          <div className="list-stack">
            {eligibleAppointments.map((appointment) => {
              const depositAmount = depositAmountForAppointment(appointment, settings.deposit_tiers);
              return (
                <div className="list-row" key={appointment.id}>
                  <div>
                    <strong>{new Date(appointment.start_at).toLocaleString('en-GB')}</strong>
                    <div className="muted">
                      {appointment.status} · {appointment.payment_status}
                      {depositAmount == null ? '' : ` · £${depositAmount} deposit`}
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busySession === appointment.id || !settings.enabled || depositAmount == null}
                      onClick={() => void requestDeposit(appointment.id, 'copy_link')}
                    >{depositAmount == null ? 'Create personal link' : `Create £${depositAmount} link`}</button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busySession === appointment.id || !settings.enabled || depositAmount == null}
                      onClick={() => void requestDeposit(appointment.id, 'email')}
                    >{depositAmount == null ? 'Queue deposit email' : `Queue £${depositAmount} email`}</button>
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
              <h2>Monzo reconciliation</h2>
              <p>Review independently verified incoming bank transfers before they affect the payment ledger.</p>
            </div>
          </div>
          <div className="notice">
            A Monzo webhook is only a hint. The server re-fetches the transaction from Monzo before it can appear here. Match does not mark anything paid. Confirm payment is a separate human action.
          </div>
          {reconciliationNotice ? <div className="notice ok" role="status">{reconciliationNotice}</div> : null}
          {loading ? <LoadingState label="Loading Monzo reconciliation…" /> : reconciliationCandidates.length === 0 ? (
            <div className="notice">No Monzo reconciliation candidates.</div>
          ) : (
            <div className="list-stack">
              {reconciliationCandidates.map((candidate) => {
                const matched = candidate.matched_payment_request;
                const selectedRequestId = matchSelection[candidate.id] ?? '';
                const canMutate = canManageReconciliation && !candidate.confirmed && candidate.status !== 'ignored';
                return (
                  <div className="list-row" key={candidate.id}>
                    <div>
                      <strong>{money(candidate.amount, candidate.currency)} · {candidateStatusLabel(candidate)}</strong>
                      <div className="muted">Received {new Date(candidate.occurred_at).toLocaleString('en-GB')}</div>
                      {matched ? (
                        <div className="muted">Matched: {requestSummaryLabel(matched)}</div>
                      ) : candidate.suggested_payment_request ? (
                        <div className="muted">Suggested: {requestSummaryLabel(candidate.suggested_payment_request)}</div>
                      ) : null}
                      {candidate.confirmed ? (
                        <div className="notice ok">Confirmed in the immutable payment ledger.</div>
                      ) : candidate.status === 'ignored' ? (
                        <div className="notice">Ignored. No payment status was changed.</div>
                      ) : null}
                    </div>

                    {canMutate ? (
                      <div className="form-grid">
                        <label className="field field-wide">
                          <span>Deposit request</span>
                          <select
                            value={selectedRequestId}
                            onChange={(event) => setMatchSelection((current) => ({
                              ...current,
                              [candidate.id]: event.target.value,
                            }))}
                          >
                            <option value="">Choose an eligible deposit request</option>
                            {candidate.match_options.map((option) => (
                              <option key={option.payment_request_id} value={option.payment_request_id}>
                                {requestSummaryLabel(option)}{option.is_suggested ? ' · suggested' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        {candidate.match_options.length === 0 ? (
                          <div className="notice field-wide">No eligible deposit request has this exact outstanding amount.</div>
                        ) : null}
                        <div className="button-row field-wide">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busyCandidate === candidate.id || !selectedRequestId}
                            onClick={() => void matchCandidate(candidate)}
                          >
                            {busyCandidate === candidate.id ? 'Working…' : matched ? 'Change match' : 'Match'}
                          </button>
                          {matched ? (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void confirmCandidate(candidate)}
                            >
                              Confirm payment
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busyCandidate === candidate.id}
                            onClick={() => void ignoreCandidate(candidate)}
                          >
                            Ignore
                          </button>
                        </div>
                      </div>
                    ) : !canManageReconciliation && !candidate.confirmed && candidate.status !== 'ignored' ? (
                      <div className="notice">View only. Finance management permission is required to match, confirm or ignore.</div>
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
          <h2>Deposit request created</h2>
          <p><strong>£{result.amount}</strong> {result.currency} · <code>{result.public_path}</code></p>
          <div className="notice">
            {result.delivery_channel === 'email'
              ? 'Email is queued, but it will not send until an email provider is deliberately connected.'
              : 'The personal path is ready in CRM. A public Worker route still has to be deliberately deployed before this path can be sent to clients.'}
          </div>
        </section>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
    </div>
  );
}
