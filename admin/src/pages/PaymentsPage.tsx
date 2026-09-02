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
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import type {
  DepositRequestResult,
  DepositTier,
  MonzoDepositSettings,
  MonzoPaymentDestination,
  MonzoReconciliationCandidate,
  MonzoReconciliationRequestSummary,
  ProjectDepositMode,
  ProjectDepositPolicy,
} from '../lib/payment-api';
import { useApi, useSession } from '../lib/session';
import { useLanguage, type Language } from '../lib/i18n';
import '../payments-mobile.css';

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

function policySummary(policy: ProjectDepositPolicy, locale: string, copy: PaymentCopy): string {
  if (policy.mode === 'fixed') {
    return `${copy.policyModeFixed} · ${money(policy.fixed_amount ?? 0, policy.currency, locale)}`;
  }
  const parts = [`${copy.policyModePercentage} · ${policy.percentage ?? 0}%`];
  if (policy.minimum_amount != null) {
    parts.push(`${copy.policyMinimum}: ${money(policy.minimum_amount, policy.currency, locale)}`);
  }
  return parts.join(' · ');
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
  const {
    artists,
    selectedArtistId: scopedArtistId,
    loading: artistScopeLoading,
    setSelectedArtistId,
  } = useArtistScope();
  // Every panel on this screen belongs to exactly one artist, so the page
  // cannot render against the scope selector's "all assigned" default. When the
  // operator can reach exactly one artist that default is unambiguous, so it is
  // resolved here instead of asking them to pick from a list of one. The scope
  // context is deliberately not mutated: this inference is local to Payments,
  // and the database still decides what the chosen artist can see.
  const selectedArtistId = scopedArtistId ?? (artists.length === 1 ? artists[0].id : null);
  const [settings, setSettings] = useState<MonzoDepositSettings>(EMPTY_SETTINGS);
  const [paymentUrl, setPaymentUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  // client_id -> full name, so a payment row can name a person instead of a
  // date. Sending money to the wrong client is not a recoverable mistake.
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [reconciliationCandidates, setReconciliationCandidates] = useState<MonzoReconciliationCandidate[]>([]);
  const [matchSelection, setMatchSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState(false);
  const [selectedGroupSessionIds, setSelectedGroupSessionIds] = useState<string[]>([]);
  const [busyCandidate, setBusyCandidate] = useState<string | null>(null);
  const [manualMatch, setManualMatch] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DepositRequestResult | null>(null);
  const [oneOffPaymentUrl, setOneOffPaymentUrl] = useState('');
  const [savingOneOff, setSavingOneOff] = useState(false);
  const [oneOffNotice, setOneOffNotice] = useState<string | null>(null);
  const [reconciliationNotice, setReconciliationNotice] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<MonzoPaymentDestination[]>([]);
  const [destinationAmount, setDestinationAmount] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [savingDestination, setSavingDestination] = useState(false);
  const [busyDestination, setBusyDestination] = useState<string | null>(null);
  const [destinationNotice, setDestinationNotice] = useState<string | null>(null);
  const [policy, setPolicy] = useState<ProjectDepositPolicy | null>(null);
  const [policyMode, setPolicyMode] = useState<ProjectDepositMode>('percentage_of_estimate');
  const [policyFixed, setPolicyFixed] = useState('');
  const [policyPercentage, setPolicyPercentage] = useState('');
  const [policyMinimum, setPolicyMinimum] = useState('');
  const [policyRounding, setPolicyRounding] = useState('1');
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [showAllPayments, setShowAllPayments] = useState(false);
  const [showAllAppointments, setShowAllAppointments] = useState(false);
  const [depositSheetSessionId, setDepositSheetSessionId] = useState<string | null>(null);

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

  const actionableCandidates = useMemo(
    () => reconciliationCandidates.filter((candidate) => !candidate.confirmed && candidate.status !== 'ignored'),
    [reconciliationCandidates]
  );
  const completedCandidates = useMemo(
    () => reconciliationCandidates.filter((candidate) => candidate.confirmed || candidate.status === 'ignored'),
    [reconciliationCandidates]
  );
  const visibleReconciliationCandidates = useMemo(
    () => [
      ...actionableCandidates,
      ...(showAllPayments ? completedCandidates : completedCandidates.slice(0, 3)),
    ],
    [actionableCandidates, completedCandidates, showAllPayments]
  );
  const visibleAppointments = useMemo(
    () => showAllAppointments ? eligibleAppointments : eligibleAppointments.slice(0, 4),
    [eligibleAppointments, showAllAppointments]
  );
  const depositSheetAppointment = useMemo(
    () => eligibleAppointments.find((appointment) => appointment.id === depositSheetSessionId) ?? null,
    [depositSheetSessionId, eligibleAppointments]
  );

  const selectedGroupAppointments = useMemo(
    () => selectedGroupSessionIds
      .map((id) => eligibleAppointments.find((appointment) => appointment.id === id))
      .filter((appointment): appointment is Appointment => Boolean(appointment)),
    [eligibleAppointments, selectedGroupSessionIds]
  );
  const groupAnchor = selectedGroupAppointments[0] ?? null;
  const groupPreviewTotal = useMemo(() => {
    if (selectedGroupAppointments.length === 0) return null;
    const amounts = selectedGroupAppointments.map((appointment) =>
      depositAmountForAppointment(appointment, settings.deposit_tiers)
    );
    if (amounts.some((amount) => amount == null)) return null;
    return (amounts as number[]).reduce((sum, amount) => sum + amount, 0);
  }, [selectedGroupAppointments, settings.deposit_tiers]);

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
      const [nextSettings, nextAppointments, nextCandidates, nextCatalogue, nextPolicy] = await Promise.all([
        api.getMonzoDepositSettings(artistId),
        api.listAppointments({ artistId, appointmentType: 'tattoo_session' }),
        canViewReconciliation ? api.listMonzoReconciliationCandidates(artistId) : Promise.resolve([]),
        canManageReconciliation
          ? api.listMonzoPaymentDestinations(artistId).then((value) => value.destinations).catch(() => [])
          : Promise.resolve([]),
        canViewReconciliation
          ? api.getProjectDepositPolicy(artistId).catch(() => null)
          : Promise.resolve(null),
      ]);
      setSettings(nextSettings);
      setPaymentUrl(nextSettings.payment_url ?? '');
      setEnabled(nextSettings.enabled);
      setAppointments(nextAppointments);
      // Depends on the appointments, so it cannot join the batch above. RLS
      // still decides which names come back; an absent one degrades to a label.
      const nextClients = await api.listClientsByIds(
        nextAppointments.map((appointment) => appointment.client_id)
      );
      setClientNames(new Map(nextClients.map((entry) => [entry.id, entry.full_name])));
      setDestinations(nextCatalogue);
      setPolicy(nextPolicy);
      if (nextPolicy?.configured) {
        setPolicyMode(nextPolicy.mode ?? 'percentage_of_estimate');
        setPolicyFixed(nextPolicy.fixed_amount != null ? String(nextPolicy.fixed_amount) : '');
        setPolicyPercentage(nextPolicy.percentage != null ? String(nextPolicy.percentage) : '');
        setPolicyMinimum(nextPolicy.minimum_amount != null ? String(nextPolicy.minimum_amount) : '');
        setPolicyRounding(nextPolicy.rounding_step != null ? String(nextPolicy.rounding_step) : '1');
      }
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
    setOneOffPaymentUrl('');
    setOneOffNotice(null);
    setReconciliationNotice(null);
    setSelectedGroupSessionIds([]);
    setDestinationNotice(null);
    setDestinationAmount('');
    setDestinationUrl('');
    setPolicyNotice(null);
    setShowAllPayments(false);
    setShowAllAppointments(false);
    setDepositSheetSessionId(null);
    if (!selectedArtistId) {
      setSettings(EMPTY_SETTINGS);
      setPaymentUrl('');
      setEnabled(false);
      setAppointments([]);
      setClientNames(new Map());
      setReconciliationCandidates([]);
      setMatchSelection({});
      setDestinations([]);
      setPolicy(null);
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

  /**
   * Catalogue administration. The amount here configures a reusable entry; it
   * is never the amount of a client payment request, which the server derives
   * from the deposit policy.
   */
  async function saveDestination(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId || !canManageReconciliation) return;
    const amount = Number(destinationAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(copy.destinationInvalidAmount);
      return;
    }
    setSavingDestination(true);
    setError(null);
    setDestinationNotice(null);
    try {
      const next = await api.upsertMonzoPaymentDestination({
        artistId: selectedArtistId,
        amount,
        paymentUrl: destinationUrl,
      });
      setDestinationNotice(
        next.replaced
          ? copy.destinationReplaced(money(next.amount, next.currency, locale))
          : copy.destinationSaved(money(next.amount, next.currency, locale))
      );
      setDestinationAmount('');
      setDestinationUrl('');
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.destinationError);
    } finally {
      setSavingDestination(false);
    }
  }

  async function archiveDestination(destination: MonzoPaymentDestination) {
    if (!selectedArtistId || !canManageReconciliation) return;
    const amountLabel = money(destination.amount, destination.currency, locale);
    const approvedRemoval = await confirmDialog({
      title: copy.removeDestinationTitle,
      message: copy.removeDestinationPrompt(amountLabel),
      confirmLabel: copy.removeDestination,
      cancelLabel: cancelLabelFor(language),
    });
    if (!approvedRemoval) return;
    setBusyDestination(destination.destination_id);
    setError(null);
    setDestinationNotice(null);
    try {
      await api.archiveMonzoPaymentDestination(destination.destination_id);
      setDestinationNotice(copy.destinationArchived(amountLabel));
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.archiveError);
    } finally {
      setBusyDestination(null);
    }
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!selectedArtistId || !canManageReconciliation) return;
    const fixed = policyMode === 'fixed' ? Number(policyFixed) : null;
    const percentage = policyMode === 'percentage_of_estimate' ? Number(policyPercentage) : null;
    if (policyMode === 'fixed' && (!Number.isFinite(fixed as number) || (fixed as number) <= 0)) {
      setError(copy.policyInvalid);
      return;
    }
    if (policyMode === 'percentage_of_estimate'
        && (!Number.isFinite(percentage as number) || (percentage as number) <= 0 || (percentage as number) > 100)) {
      setError(copy.policyInvalid);
      return;
    }
    const minimum = policyMinimum.trim() === '' ? null : Number(policyMinimum);
    const rounding = policyRounding.trim() === '' ? 1 : Number(policyRounding);
    setSavingPolicy(true);
    setError(null);
    setPolicyNotice(null);
    try {
      await api.configureProjectDepositPolicy({
        artistId: selectedArtistId,
        mode: policyMode,
        fixedAmount: fixed,
        percentage,
        minimumAmount: minimum,
        roundingStep: rounding,
      });
      setPolicyNotice(copy.policySaved);
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.policyError);
    } finally {
      setSavingPolicy(false);
    }
  }

  async function requestDeposit(sessionId: string, deliveryChannel: 'email' | 'copy_link'): Promise<boolean> {
    setBusySession(sessionId);
    setError(null);
    setResult(null);
    setOneOffPaymentUrl('');
    setOneOffNotice(null);
    try {
      const next = await api.requestSessionDeposit({ sessionId, deliveryChannel });
      setResult(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestError);
      return false;
    } finally {
      setBusySession(null);
    }
  }

  function toggleGroupAppointment(appointment: Appointment) {
    setSelectedGroupSessionIds((current) => {
      if (current.includes(appointment.id)) return current.filter((id) => id !== appointment.id);
      const anchor = eligibleAppointments.find((candidate) => candidate.id === current[0]);
      if (anchor && (anchor.project_id !== appointment.project_id || anchor.client_id !== appointment.client_id)) {
        return current;
      }
      if (current.length >= 12) return current;
      return [...current, appointment.id];
    });
  }

  async function requestGroupedDeposit(deliveryChannel: 'email' | 'copy_link') {
    if (selectedGroupSessionIds.length < 2 || selectedGroupSessionIds.length > 12) return;
    setBusyGroup(true);
    setError(null);
    setResult(null);
    setOneOffPaymentUrl('');
    setOneOffNotice(null);
    try {
      const next = await api.requestGroupedSessionDeposit({
        sessionIds: selectedGroupSessionIds,
        deliveryChannel,
      });
      setResult(next);
      setSelectedGroupSessionIds([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestError);
    } finally {
      setBusyGroup(false);
    }
  }

  async function saveOneOffDestination(event: FormEvent) {
    event.preventDefault();
    if (!result || !canManageReconciliation) return;
    setSavingOneOff(true);
    setError(null);
    setOneOffNotice(null);
    try {
      const next = await api.attachMonzoOneOffPaymentDestination({
        paymentRequestId: result.payment_request_id,
        paymentUrl: oneOffPaymentUrl,
      });
      setResult((current) => current ? { ...current, public_path: next.public_path } : current);
      setOneOffPaymentUrl('');
      setOneOffNotice(copy.oneOffSaved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.oneOffError);
    } finally {
      setSavingOneOff(false);
    }
  }

  /**
   * Agreeing with a match the server already made.
   *
   * The server pre-selects the right payment request and the interface then
   * charged four interactions to say yes: open a dropdown that is already
   * filled, Match, Confirm, and a dialog. Recording money against a client is
   * worth one confirmation, not three steps before it.
   */
  async function confirmSuggestedCandidate(candidate: MonzoReconciliationCandidate) {
    const suggested = candidate.suggested_payment_request;
    if (!selectedArtistId || !canManageReconciliation || candidate.confirmed || !suggested) return;

    const confirmed = await confirmDialog({
      title: copy.confirmPaymentTitle,
      message: copy.confirmPrompt(money(candidate.amount, candidate.currency, locale), suggested.client_name),
      confirmLabel: copy.confirmPayment,
      cancelLabel: cancelLabelFor(language),
      tone: 'primary',
    });
    if (!confirmed) return;

    setBusyCandidate(candidate.id);
    setError(null);
    setReconciliationNotice(null);
    try {
      // Two RPCs, unchanged: the match still has to exist before the ledger
      // entry can reference it. What collapses is the interaction, not the
      // database contract.
      await api.matchMonzoReconciliationCandidate({
        candidateId: candidate.id,
        paymentRequestId: suggested.payment_request_id,
      });
      const next = await api.confirmMonzoReconciliationCandidate(candidate.id);
      setReconciliationNotice(copy.confirmSuccess(paymentRequestStatusLabel(next.payment_request_status, language)));
      await reload(selectedArtistId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.confirmError);
    } finally {
      setBusyCandidate(null);
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
    const approvedIgnore = await confirmDialog({
      title: copy.ignoreTitle,
      message: copy.ignorePrompt(money(candidate.amount, candidate.currency, locale)),
      confirmLabel: copy.ignore,
      cancelLabel: cancelLabelFor(language),
    });
    if (!approvedIgnore) return;
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
    const confirmed = await confirmDialog({
      title: copy.confirmPaymentTitle,
      message: copy.confirmPrompt(money(candidate.amount, candidate.currency, locale), matched.client_name),
      confirmLabel: copy.confirmPayment,
      cancelLabel: cancelLabelFor(language),
      // Recording money against the right client is the desired outcome here,
      // not a destructive one.
      tone: 'primary',
    });
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
  // Asking for a choice is only fair if the choice is on the screen. The scope
  // selector in the header is the primary control; this repeats it inline so a
  // cold start never reaches an instruction it cannot act on.
  if (!selectedArtistId || !selectedArtist) {
    return (
      <section className="panel">
        <div className="notice">{copy.chooseArtist}</div>
        {artists.length > 0 ? (
          <div className="button-row" role="group" aria-label={copy.chooseArtist}>
            {artists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                className="secondary-button"
                onClick={() => setSelectedArtistId(artist.id)}
              >
                {artist.display_name}
              </button>
            ))}
          </div>
        ) : (
          <div className="notice">{copy.noAssignedArtists}</div>
        )}
      </section>
    );
  }

  return (
    <div className="page-stack payments-page">
      <section className="payments-overview" aria-label={language === 'ru' ? 'Сводка по депозитам' : 'Deposit summary'}>
        <div className={`payments-stat${actionableCandidates.length ? ' is-action' : ''}`}>
          <span className="payments-stat-label">{language === 'ru' ? 'Требуют действия' : 'Need action'}</span>
          <strong>{actionableCandidates.length}</strong>
        </div>
        <div className="payments-stat">
          <span className="payments-stat-label">{language === 'ru' ? 'Будущие сеансы' : 'Upcoming sessions'}</span>
          <strong>{eligibleAppointments.length}</strong>
        </div>
        <div className="payments-stat">
          <span className="payments-stat-label">{language === 'ru' ? 'Депозиты' : 'Deposits'}</span>
          <strong>{settings.enabled ? (language === 'ru' ? 'Вкл.' : 'On') : (language === 'ru' ? 'Выкл.' : 'Off')}</strong>
        </div>
      </section>

      {/* Money that has already arrived comes first: it is the only item on
          this screen with someone waiting on the other end of it. */}
      {canViewReconciliation ? (
        <section className="panel payments-work-panel">
          <div className="panel-heading">
            <div>
              <h2>{copy.reconciliationTitle}</h2>
              <p>{language === 'ru'
                ? 'Крупно показываются только платежи, которые требуют решения.'
                : 'Only payments that need a decision stay prominent.'}</p>
            </div>
          </div>
          <details className="payments-help">
            <summary>{language === 'ru' ? 'Как работает сопоставление' : 'How matching works'}</summary>
            <div className="notice">{copy.reconciliationSecurity}</div>
          </details>
          {reconciliationNotice ? <div className="notice ok" role="status">{reconciliationNotice}</div> : null}
          {loading ? <LoadingState label={copy.loadingReconciliation} /> : reconciliationCandidates.length === 0 ? (
            <div className="notice">{copy.noCandidates}</div>
          ) : (
            <>
              {actionableCandidates.length === 0 ? (
                <div className="notice ok">{language === 'ru' ? 'Все входящие платежи обработаны.' : 'All incoming payments are processed.'}</div>
              ) : null}
              <div className="list-stack payments-list">
                {visibleReconciliationCandidates.map((candidate) => {
                  const matched = candidate.matched_payment_request;
                  const selectedRequestId = matchSelection[candidate.id] ?? '';
                  const canMutate = canManageReconciliation && !candidate.confirmed && candidate.status !== 'ignored';
                  const isHistory = candidate.confirmed || candidate.status === 'ignored';
                  return (
                    <div className={`list-row payment-row${isHistory ? ' payment-row-compact' : ''}`} key={candidate.id}>
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
                          <span className="payment-status-pill ok">{copy.confirmedLedger}</span>
                        ) : candidate.status === 'ignored' ? (
                          <span className="payment-status-pill">{copy.ignoredNoChange}</span>
                        ) : null}
                      </div>

                      {/* The server already worked out which request this is.
                          Offer agreement first, and keep the manual matcher
                          behind it for the cases it could not decide. */}
                      {canMutate && !matched && candidate.suggested_payment_request && !manualMatch[candidate.id] ? (
                        <div>
                          <p className="muted">
                            {copy.suggestedSentence(
                              money(candidate.amount, candidate.currency, locale),
                              new Date(candidate.occurred_at).toLocaleDateString(locale),
                              candidate.suggested_payment_request.client_name,
                              candidate.suggested_payment_request.session_start_at
                                ? new Date(candidate.suggested_payment_request.session_start_at).toLocaleString(locale)
                                : copy.noSessionDate,
                            )}
                          </p>
                          <div className="button-row">
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void confirmSuggestedCandidate(candidate)}
                            >
                              {busyCandidate === candidate.id
                                ? copy.working
                                : copy.confirmSuggested(
                                  money(candidate.amount, candidate.currency, locale),
                                  candidate.suggested_payment_request.client_name,
                                )}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => setManualMatch((current) => ({ ...current, [candidate.id]: true }))}
                            >
                              {copy.chooseDifferent}
                            </button>
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
                      ) : canMutate ? (
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
              {completedCandidates.length > 3 ? (
                <button
                  type="button"
                  className="secondary-button payments-more"
                  onClick={() => setShowAllPayments((current) => !current)}
                >
                  {showAllPayments
                    ? (language === 'ru' ? 'Показать только последние' : 'Show recent only')
                    : (language === 'ru' ? `Все обработанные платежи (${completedCandidates.length})` : `All processed payments (${completedCandidates.length})`)}
                </button>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section className="panel payments-work-panel">
        <div className="panel-heading">
          <div>
            <h2>{copy.requestTitle}</h2>
            <p>{language === 'ru'
              ? 'По умолчанию показаны ближайшие четыре. Сумма по-прежнему рассчитывается существующими правилами CRM.'
              : 'The nearest four are shown by default. The amount still comes from the existing CRM rules.'}</p>
          </div>
        </div>
        {!settings.enabled ? (
          <div className="notice warn">{language === 'ru' ? 'Создание депозитов отключено в настройках ниже.' : 'Deposit requests are disabled in the settings below.'}</div>
        ) : null}
        {eligibleAppointments.length === 0 ? <div className="notice">{copy.noEligibleAppointments}</div> : (
          <>
            <div className="payments-session-list">
              {visibleAppointments.map((appointment) => {
                const depositAmount = depositAmountForAppointment(appointment, settings.deposit_tiers);
                return (
                  <div className="payments-session-row" key={appointment.id}>
                    <div className="payments-session-copy">
                      <strong>{clientNames.get(appointment.client_id) ?? copy.clientUnknown}</strong>
                      <div className="payments-session-meta">
                        {new Date(appointment.start_at).toLocaleString(locale)}
                        {' · '}
                        {label('sessionStatus', appointment.status)} · {label('paymentStatus', appointment.payment_status)}
                        {depositAmount == null ? '' : ` · ${money(depositAmount, settings.currency || 'GBP', locale)}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="primary-button payments-session-action"
                      disabled={busySession === appointment.id || !settings.enabled || depositAmount == null}
                      onClick={() => setDepositSheetSessionId(appointment.id)}
                    >
                      {busySession === appointment.id
                        ? copy.working
                        : depositAmount == null
                          ? (language === 'ru' ? 'Недоступно' : 'Unavailable')
                          : (language === 'ru' ? `+ Создать ${money(depositAmount, settings.currency || 'GBP', locale)}` : `+ Create ${money(depositAmount, settings.currency || 'GBP', locale)}`)}
                    </button>
                  </div>
                );
              })}
            </div>
            {eligibleAppointments.length > 4 ? (
              <button
                type="button"
                className="secondary-button payments-more"
                onClick={() => setShowAllAppointments((current) => !current)}
              >
                {showAllAppointments
                  ? (language === 'ru' ? 'Показать ближайшие 4' : 'Show nearest 4')
                  : (language === 'ru' ? `Показать все (${eligibleAppointments.length})` : `Show all (${eligibleAppointments.length})`)}
              </button>
            ) : null}
          </>
        )}
      </section>

      {depositSheetAppointment ? (() => {
        const depositAmount = depositAmountForAppointment(depositSheetAppointment, settings.deposit_tiers);
        const clientName = clientNames.get(depositSheetAppointment.client_id) ?? copy.clientUnknown;
        return (
          <div
            className="deposit-sheet-backdrop"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target && busySession !== depositSheetAppointment.id) {
                setDepositSheetSessionId(null);
              }
            }}
          >
            <div
              className="deposit-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deposit-sheet-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="deposit-sheet-head">
                <div>
                  <h2 id="deposit-sheet-title">{language === 'ru' ? 'Новый депозит' : 'New deposit'}</h2>
                  <div className="deposit-sheet-client">{clientName}</div>
                </div>
                <button
                  type="button"
                  className="deposit-sheet-close"
                  aria-label={language === 'ru' ? 'Закрыть' : 'Close'}
                  disabled={busySession === depositSheetAppointment.id}
                  onClick={() => setDepositSheetSessionId(null)}
                >
                  ×
                </button>
              </div>
              <p className="deposit-sheet-meta">
                {new Date(depositSheetAppointment.start_at).toLocaleString(locale)}
                {depositAmount == null ? '' : ` · ${money(depositAmount, settings.currency || 'GBP', locale)}`}
              </p>
              <div className="deposit-sheet-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busySession === depositSheetAppointment.id || depositAmount == null}
                  onClick={() => {
                    void requestDeposit(depositSheetAppointment.id, 'email').then((created) => {
                      if (created) setDepositSheetSessionId(null);
                    });
                  }}
                >
                  {busySession === depositSheetAppointment.id
                    ? copy.working
                    : depositAmount == null
                      ? copy.queueDepositEmail
                      : copy.queueAmountEmail(depositAmount)}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busySession === depositSheetAppointment.id || depositAmount == null}
                  onClick={() => {
                    void requestDeposit(depositSheetAppointment.id, 'copy_link').then((created) => {
                      if (created) setDepositSheetSessionId(null);
                    });
                  }}
                >
                  {depositAmount == null ? copy.createPersonalLink : copy.createAmountLink(depositAmount)}
                </button>
              </div>
            </div>
          </div>
        );
      })() : null}

      {result ? (
        <section className="panel">
          <h2>{copy.requestCreated}</h2>
          <p><strong>£{result.amount}</strong> {result.currency} · <code>{result.public_path}</code></p>
          <div className="notice">
            {result.delivery_channel === 'email' ? copy.emailQueued : copy.personalPathReady}
          </div>
          {canManageReconciliation ? (
            <form onSubmit={saveOneOffDestination} className="form-grid">
              <div className="field-wide">
                <h3>{copy.oneOffTitle}</h3>
                <p className="muted">{copy.oneOffDescription}</p>
              </div>
              <label className="field field-wide">
                <span>{copy.oneOffPaymentLink}</span>
                <input
                  type="url"
                  value={oneOffPaymentUrl}
                  onChange={(event) => setOneOffPaymentUrl(event.target.value)}
                  placeholder="https://monzo.com/pay/r/…"
                  autoComplete="off"
                  required
                />
              </label>
              <div className="field-wide">
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={savingOneOff || !oneOffPaymentUrl.trim()}
                >
                  {savingOneOff ? copy.saving : copy.saveOneOffLink}
                </button>
              </div>
              {oneOffNotice ? <div className="notice ok field-wide" role="status">{oneOffNotice}</div> : null}
            </form>
          ) : null}
        </section>
      ) : null}

      {canManageReconciliation && eligibleAppointments.length >= 2 ? (
        <section className="panel payments-special-panel">
          <details className="payments-special-action">
            <summary>
              <span className="payments-summary-copy">
                <strong>{copy.groupedDepositTitle}</strong>
                <small>{language === 'ru' ? 'Редкая операция: распределить один депозит на 2-12 сеансов' : 'Occasional action: combine 2-12 sessions into one deposit'}</small>
              </span>
            </summary>
            <div className="payments-disclosure-body">
              <p className="muted">
                {language === 'ru'
                  ? 'Выберите 2-12 сеансов одного клиента и проекта. Итоговый депозит CRM рассчитывает на сервере как сумму депозитов выбранных сеансов.'
                  : 'Select 2-12 sessions from the same client and project. CRM calculates the final deposit on the server as the sum of the selected session deposits.'}
              </p>
              <div className="notice">
                {language === 'ru'
                  ? 'Предварительная сумма ниже только для удобства. Браузер не отправляет сумму или artist ID в финансовый RPC.'
                  : 'The preview below is informational only. The browser does not send an amount or artist ID to the financial RPC.'}
              </div>
              <div className="list-stack">
                {eligibleAppointments.map((appointment) => {
                  const selected = selectedGroupSessionIds.includes(appointment.id);
                  const compatible = !groupAnchor
                    || (groupAnchor.project_id === appointment.project_id && groupAnchor.client_id === appointment.client_id);
                  const depositAmount = depositAmountForAppointment(appointment, settings.deposit_tiers);
                  return (
                    <label className="list-row" key={`group-${appointment.id}`}>
                      <div>
                        <strong>{clientNames.get(appointment.client_id) ?? copy.clientUnknown}</strong>
                        <div className="muted">
                          {new Date(appointment.start_at).toLocaleString(locale)}
                          {depositAmount == null ? '' : ` · ${money(depositAmount, settings.currency || 'GBP', locale)}`}
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!settings.enabled || depositAmount == null || (!selected && (!compatible || selectedGroupSessionIds.length >= 12))}
                        onChange={() => toggleGroupAppointment(appointment)}
                        aria-label={`${language === 'ru' ? 'Выбрать сеанс' : 'Select session'} ${clientNames.get(appointment.client_id) ?? copy.clientUnknown} ${new Date(appointment.start_at).toLocaleString(locale)}`}
                      />
                    </label>
                  );
                })}
              </div>
              <div className="notice">
                {language === 'ru' ? 'Выбрано' : 'Selected'}: {selectedGroupSessionIds.length}
                {groupPreviewTotal == null ? '' : ` · ${language === 'ru' ? 'предварительно' : 'preview'} ${money(groupPreviewTotal, settings.currency || 'GBP', locale)}`}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busyGroup || !settings.enabled || selectedGroupSessionIds.length < 2 || selectedGroupSessionIds.length > 12}
                  onClick={() => void requestGroupedDeposit('copy_link')}
                >
                  {busyGroup
                    ? copy.working
                    : language === 'ru' ? 'Создать общую ссылку' : 'Create combined link'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyGroup || !settings.enabled || selectedGroupSessionIds.length < 2 || selectedGroupSessionIds.length > 12}
                  onClick={() => void requestGroupedDeposit('email')}
                >
                  {busyGroup
                    ? copy.working
                    : language === 'ru' ? 'Отправить общий депозит' : 'Send combined deposit'}
                </button>
                {selectedGroupSessionIds.length ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyGroup}
                    onClick={() => setSelectedGroupSessionIds([])}
                  >
                    {language === 'ru' ? 'Очистить выбор' : 'Clear selection'}
                  </button>
                ) : null}
              </div>
            </div>
          </details>
        </section>
      ) : null}

      <section className="panel payments-settings-panel">
        <details className="payments-setup-inline">
          <summary>
            <span className="payments-summary-copy">
              <strong>{copy.depositsTitle}</strong>
              <small>{settings.enabled
                ? (language === 'ru' ? 'Ссылка настроена, создание депозитов включено' : 'Link configured, deposit requests enabled')
                : (language === 'ru' ? 'Создание депозитов выключено' : 'Deposit requests disabled')}</small>
            </span>
          </summary>
          <div className="payments-disclosure-body">
            <p className="muted">{copy.depositsDescription(selectedArtist.display_name)}</p>
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
          </div>
        </details>
      </section>

      {/* Configuration, not daily work. The connection, the payment link
          catalogue and the deposit policy are set once and then left alone. */}
      {canManageConnection || canManageReconciliation ? (
        <section className="panel">
          <details className="payments-setup">
            <summary>
              <span>{copy.setupTitle}</span>
            </summary>
            <p className="muted">{copy.setupDescription}</p>
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
          {canManageReconciliation ? (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{copy.catalogueTitle}</h2>
                  <p>{copy.catalogueDescription(selectedArtist.display_name)}</p>
                </div>
              </div>
              <div className="notice">{copy.catalogueSecurity}</div>
              {destinationNotice ? <div className="notice ok" role="status">{destinationNotice}</div> : null}

              {loading ? <LoadingState label={copy.loadingCatalogue} /> : destinations.length === 0 ? (
                <div className="notice">{copy.noDestinations}</div>
              ) : (
                <div className="list-stack">
                  {destinations.map((destination) => (
                    <div className="list-row" key={destination.destination_id}>
                      <div>
                        <strong>{money(destination.amount, destination.currency, locale)}</strong>
                        <div className="muted">
                          {copy.destinationConfigured} · {copy.destinationFingerprint} {destination.fingerprint}
                          {destination.issued_request_count > 0
                            ? ` · ${copy.destinationIssuedRequests(destination.issued_request_count)}`
                            : ''}
                        </div>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyDestination !== null || savingDestination}
                          onClick={() => {
                            setDestinationAmount(String(destination.amount));
                            setDestinationUrl('');
                          }}
                        >
                          {copy.replaceDestination}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busyDestination !== null || savingDestination}
                          onClick={() => void archiveDestination(destination)}
                        >
                          {busyDestination === destination.destination_id ? copy.working : copy.removeDestination}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={saveDestination} className="form-grid">
                <label className="field">
                  <span>{copy.destinationAmount}</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={destinationAmount}
                    onChange={(event) => setDestinationAmount(event.target.value)}
                    required
                  />
                </label>
                <label className="field field-wide">
                  <span>{copy.destinationUrl}</span>
                  <input
                    type="url"
                    value={destinationUrl}
                    onChange={(event) => setDestinationUrl(event.target.value)}
                    placeholder="https://monzo.com/pay/r/…"
                    autoComplete="off"
                    required
                  />
                </label>
                <div className="field-wide">
                  <button type="submit" className="primary-button" disabled={savingDestination}>
                    {savingDestination ? copy.saving : copy.addDestination}
                  </button>
                </div>
              </form>
            </section>
          ) : null}
          {canViewReconciliation ? (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{copy.policyTitle}</h2>
                  <p>{copy.policyDescription(selectedArtist.display_name)}</p>
                </div>
              </div>
              {policy?.configured ? (
                <div className="notice">{copy.policyCurrent(policySummary(policy, locale, copy))}</div>
              ) : (
                <div className="notice warn">{copy.policyNotConfigured}</div>
              )}
              {policyNotice ? <div className="notice ok" role="status">{policyNotice}</div> : null}

              {canManageReconciliation ? (
                <form onSubmit={savePolicy} className="form-grid">
                  <label className="field field-wide">
                    <span>{copy.policyMode}</span>
                    <select
                      value={policyMode}
                      onChange={(event) => setPolicyMode(event.target.value as ProjectDepositMode)}
                    >
                      <option value="percentage_of_estimate">{copy.policyModePercentage}</option>
                      <option value="fixed">{copy.policyModeFixed}</option>
                    </select>
                  </label>
                  {policyMode === 'fixed' ? (
                    <label className="field">
                      <span>{copy.policyFixedAmount}</span>
                      <input
                        type="number" min="0.01" step="0.01" inputMode="decimal"
                        value={policyFixed}
                        onChange={(event) => setPolicyFixed(event.target.value)}
                        required
                      />
                    </label>
                  ) : (
                    <label className="field">
                      <span>{copy.policyPercentage}</span>
                      <input
                        type="number" min="0.01" max="100" step="0.01" inputMode="decimal"
                        value={policyPercentage}
                        onChange={(event) => setPolicyPercentage(event.target.value)}
                        required
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>{copy.policyMinimum}</span>
                    <input
                      type="number" min="0.01" step="0.01" inputMode="decimal"
                      value={policyMinimum}
                      onChange={(event) => setPolicyMinimum(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{copy.policyRounding}</span>
                    <input
                      type="number" min="0.01" step="0.01" inputMode="decimal"
                      value={policyRounding}
                      onChange={(event) => setPolicyRounding(event.target.value)}
                    />
                  </label>
                  <div className="field-wide">
                    <button type="submit" className="primary-button" disabled={savingPolicy}>
                      {savingPolicy ? copy.saving : copy.savePolicy}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="notice">{copy.viewOnly}</div>
              )}
            </section>
          ) : null}
          </details>
        </section>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
    </div>
  );
}
