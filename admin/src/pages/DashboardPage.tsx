// Today — the daily triage screen.
//
// This was a dashboard of enquiry counters. A counter tells the operator a
// number and then makes them go somewhere else to act on it, which is the
// opposite of what the first screen of the day is for. The question being
// answered here is "what needs me today?", so the screen is a list of things
// that need them, then what is actually happening today, then what is coming.
//
// Every row names a person and opens the place the work is done. Nothing above
// the schedule is a counter, a form or an instruction.

import { useEffect, useRef, useState } from 'react';
import { useTodayResource } from '../lib/today-resource';
import { todayNavigationStart, todayRequest, todayTiming } from '../lib/today-performance';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatDate, formatDateTime, relativeDue } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can, canAccess } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import { groupEmailThreads, type EmailThread } from '../lib/email-threads';
import { summariseToday, type GmailAwaitingReply, type TodayItem } from '../lib/today-workspace';
import { pulseToTodayItems, type TodayPulse } from '../lib/today-pulse';
import { typeLabel } from './AppointmentsPage';
import { daysAgoIso } from '../lib/appointment-api';
import type { Appointment } from '../lib/appointment-api';
import type { ConversationSummary } from '../lib/communications-api';
import type { MonzoReconciliationCandidate } from '../lib/payment-api';
import type { ActivityEntry, Enquiry, FollowUp, Project } from '../lib/types';
import type { AttentionAcknowledgement, AttentionItemRef } from '../lib/attention-api';
import { operationalLabel } from '../lib/operational-labels';
import { enquiryTargetsForToday } from '../lib/today-navigation';

interface TodayData {
  appointments: Appointment[];
  enquiries: Enquiry[];
  projects: Project[];
  followUps: FollowUp[];
  conversations: ConversationSummary[];
  emailThreads: EmailThread[];
  candidates: MonzoReconciliationCandidate[];
  failedJobCount: number;
  activity: ActivityEntry[];
  acknowledgements: AttentionAcknowledgement[];
  clientNames: Map<string, string>;
  /** The server pulse, when it answered. Rendered only while it is enabled. */
  pulse: TodayPulse | null;
}

interface TodayCoreData {
  enquiries: Enquiry[];
  conversations: ConversationSummary[];
  emailThreads: EmailThread[];
  clientNames: Map<string, string>;
}

interface TodaySupplementalData {
  projects: Project[];
  followUps: FollowUp[];
  candidates: MonzoReconciliationCandidate[];
  failedJobCount: number;
  activity: ActivityEntry[];
  acknowledgements: AttentionAcknowledgement[];
  clientNames: Map<string, string>;
}

const EMPTY_SUPPLEMENTAL_DATA: TodaySupplementalData = {
  projects: [],
  followUps: [],
  candidates: [],
  failedJobCount: 0,
  activity: [],
  acknowledgements: [],
  clientNames: new Map(),
};

export function DashboardPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const { selectedArtistId, loading: scopeLoading } = useArtistScope();
  const mayManageFinance = canAccess(role, 'manageFinance', memberships);
  const mayDismissAttention = can(role, 'manageNotifications');
  const mayViewEnquiries = can(role, 'viewEnquiries');
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Every cache key includes the authenticated profile, capabilities, artist
  // and calendar day. Customer data stays in memory, never browser storage.
  const scopeKey = JSON.stringify([profile?.id, role, memberships, selectedArtistId, new Date().toDateString()]);
  const readyKey = scopeLoading ? null : scopeKey;
  const mountedAt = useRef(todayNavigationStart());
  const contentMeasured = useRef(false);
  useEffect(() => {
    mountedAt.current = todayNavigationStart();
    contentMeasured.current = false;
    todayTiming('mounted', performance.now() - mountedAt.current);
    todayTiming('skeleton', performance.now() - mountedAt.current);
  }, [scopeKey]);

  // Pulse already contains client names. It must not wait for navigation,
  // email grouping, the schedule, or a second name-resolution request.
  const pulseState = useTodayResource<TodayPulse | null>(api, readyKey, 'pulse', () =>
    api.getTodayPulse(selectedArtistId ?? undefined).catch(() => null), 1000);
  const scheduleState = useTodayResource<{ appointments: Appointment[]; clientNames: Map<string, string> }>(
    api, readyKey, 'schedule', async () => {
      const appointments = can(role, 'viewSessions')
        ? await todayRequest('appointments', () => api.listAppointments({ artistId: selectedArtistId ?? undefined, from: daysAgoIso(90) })) : [];
      const clients = await todayRequest('names', () => api.listClientsByIds(appointments.map((row) => row.client_id)));
      return { appointments, clientNames: new Map(clients.map((row) => [row.id, row.full_name])) };
    }, 1000);

  // These records enrich reply links and power the browser fallback. Their
  // errors cannot hide an enabled server pulse or a completed schedule.
  const coreState = useTodayResource<TodayCoreData>(api, readyKey, 'navigation', async () => {
    const artistId = selectedArtistId ?? undefined;
    const [enquiries, conversations, emailMessages] = await Promise.all([
      mayViewEnquiries ? todayRequest('enquiries', () => api.listEnquiries({ artistId })) : Promise.resolve([]),
      mayViewEnquiries ? todayRequest('conversations', () => api.listConversations({ limit: 50 })) : Promise.resolve([]),
      mayViewEnquiries ? todayRequest('email', () => api.listEmailMessages({ artistId, limit: 200 })).catch(() => []) : Promise.resolve([]),
    ]);

    const emailThreads = groupEmailThreads(emailMessages);

    // Resolve only names needed by the critical path. Project/follow-up-only
    // clients are resolved in the supplemental lane and merged later.
    const clients = await todayRequest('names', () => api.listClientsByIds([
      ...enquiries.map((enquiry) => enquiry.client_id),
      ...emailThreads.map((thread) => thread.client_id ?? ''),
    ]));

    return {
      enquiries,
      conversations,
      emailThreads,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
    };
  });

  const supplementalState = useTodayResource<TodaySupplementalData>(api, readyKey, 'supplemental', async () => {
    const artistId = selectedArtistId ?? undefined;

    const candidatesPromise: Promise<MonzoReconciliationCandidate[]> = mayManageFinance
      ? (async () => {
        const artistIds = selectedArtistId
          ? [selectedArtistId]
          : (await api.listAccessibleArtists()).filter((artist) => artist.is_active).map((artist) => artist.id);
        return (await Promise.all(
          artistIds.map((id) => api.listMonzoReconciliationCandidates(id).catch(() => [])),
        )).flat();
      })()
      : Promise.resolve([]);

    const [projects, followUps, failedJobs, activity, acknowledgements, candidates] = await Promise.all([
      can(role, 'viewProjects') ? api.listProjects(undefined, artistId) : Promise.resolve([]),
      can(role, 'viewFollowUps') ? api.listFollowUps({ open: true, artistId }) : Promise.resolve([]),
      can(role, 'viewIntegrationJobs') ? api.listFailedJobs(artistId) : Promise.resolve([]),
      can(role, 'viewActivity') ? api.listActivity({ artistId }) : Promise.resolve([]),
      can(role, 'viewNotifications')
        ? api.listAttentionAcknowledgements(artistId).catch(() => [])
        : Promise.resolve([]),
      candidatesPromise,
    ]);

    const clients = await api.listClientsByIds([
      ...projects.map((project) => project.client_id),
      ...followUps.map((followUp) => followUp.client_id ?? ''),
    ]);

    return {
      projects,
      followUps,
      candidates,
      failedJobCount: failedJobs.length,
      activity,
      acknowledgements,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
    };
  });

  const gmailState = useTodayResource<GmailAwaitingReply[]>(api, readyKey, 'gmail', async () => {
    if (!mayViewEnquiries) return [];
    return api.listGmailMetadataSnapshots(selectedArtistId ?? undefined)
      .then((snapshots) => snapshots.map((entry) => ({
        artist_id: entry.artist_id, client_id: entry.client_id, client_name: null,
        subject: entry.subject, last_message_at: entry.last_message_at, direction: entry.direction,
      }))).catch(() => []);
  });

  const serverPulse = pulseState.data?.enabled ? pulseState.data : null;
  const fallbackReady = !scopeLoading && !pulseState.loading && !serverPulse
    && coreState.data !== null && scheduleState.data !== null && supplementalState.data !== null;
  const meaningful = Boolean(serverPulse || scheduleState.data || fallbackReady);
  useEffect(() => {
    if (!meaningful || contentMeasured.current) return;
    const frame = requestAnimationFrame(() => {
      contentMeasured.current = true;
      todayTiming('content', performance.now() - mountedAt.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [meaningful, scopeKey]);
  const reload = () => {
    pulseState.reload(); scheduleState.reload(); coreState.reload();
    supplementalState.reload(); gmailState.reload();
  };
  const coreData = coreState.data;
  const supplementalData = supplementalState.data ?? EMPTY_SUPPLEMENTAL_DATA;
  const data: TodayData = {
    appointments: scheduleState.data?.appointments ?? [],
    enquiries: coreData?.enquiries ?? [],
    conversations: coreData?.conversations ?? [],
    emailThreads: coreData?.emailThreads ?? [],
    ...supplementalData,
    clientNames: new Map([
      ...(coreData?.clientNames ?? []), ...supplementalData.clientNames,
      ...(scheduleState.data?.clientNames ?? []),
    ]),
    pulse: pulseState.data,
  };

  const now = new Date();
  const conversations = data.conversations.filter(
    (conversation) => !selectedArtistId || conversation.artist_id === selectedArtistId,
  );
  const gmailAwaitingReply = gmailState.data ?? [];

  const snapshot = summariseToday({
    now,
    appointments: data.appointments,
    enquiries: data.enquiries,
    projects: serverPulse ? [] : data.projects,
    followUps: serverPulse ? [] : data.followUps,
    conversations: serverPulse ? [] : conversations,
    emailThreads: (serverPulse ? [] : data.emailThreads).filter(
      (thread) => !selectedArtistId || thread.artist_id === selectedArtistId,
    ),
    gmailAwaitingReply: serverPulse ? [] : gmailAwaitingReply,
    acknowledgements: data.acknowledgements,
    reconciliationCandidates: data.candidates,
    failedJobCount: data.failedJobCount,
    clientName: (clientId) => data.clientNames.get(clientId) ?? null,
  });
  // One engine for Today and Telegram once the server pulse is switched on.
  // The schedule below still comes from the appointments read here.
  const needsYou = enquiryTargetsForToday(
    serverPulse ? pulseToTodayItems(serverPulse) : fallbackReady ? snapshot.needsYou : [],
    data.enquiries,
    conversations,
    data.emailThreads,
  );

  async function dismissAttention(item: AttentionItemRef, key: string) {
    setDismissing(key);
    setActionError(null);
    try {
      await api.acknowledgeAttentionItem(item);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('today.dismissFailed'));
    } finally {
      setDismissing(null);
    }
  }

  return (
    <>
      <p className="today-context">
        {formatDate(now.toISOString(), language)} · {sessionCountLabel(language, snapshot.today.length)}
      </p>

      <Section title={t('today.needsYou')}>
        {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}
        {serverPulse ? <PulseSummary pulse={serverPulse} /> : null}
        {serverPulse && coreState.error ? <ErrorState message={coreState.error} onRetry={coreState.reload} /> : null}
        {!serverPulse && !fallbackReady ? (
          coreState.error || supplementalState.error || pulseState.error ?
            <ErrorState message={coreState.error ?? supplementalState.error ?? pulseState.error!} onRetry={reload} /> :
            <LoadingState label={t('today.loading')} />
        ) : needsYou.length === 0 ? (
          <EmptyState compact title={t('today.allClear')} hint={t('today.allClearHint')} />
        ) : (
          <div className="list">
            {needsYou.map((item) => (
              <NeedsYouRow
                key={item.key}
                item={item}
                now={now}
                navigationPending={!coreData && ['reply', 'email_send_failed', 'email_draft_to_approve'].includes(item.kind)}
                canDismiss={mayDismissAttention}
                dismissing={dismissing === item.key}
                onDismiss={(target) => { void dismissAttention(target, item.key); }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t('today.schedule')}
        action={<Link to="/appointments" className="badge today-link">{t('today.openCalendar')}</Link>}
      >
        {!scheduleState.data ? (
          scheduleState.error ? <ErrorState message={scheduleState.error} onRetry={scheduleState.reload} /> :
            <LoadingState label={t('today.loading')} />
        ) : snapshot.today.length === 0 ? (
          <EmptyState compact title={t('today.noSchedule')} hint={t('today.noScheduleHint')} />
        ) : (
          <div className="list">
            {snapshot.today.map((appointment) => (
              <Link key={appointment.id} to={`/appointments/${appointment.id}`} className="row">
                <div className="title">
                  {data.clientNames.get(appointment.client_id) ?? t('today.noSubject')}
                </div>
                <div className="meta">
                  {formatDateTime(appointment.start_at, language)}{' · '}
                  <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
                  <span className={appointment.status === 'confirmed' ? 'badge ok' : 'badge warn'}>
                    {label('sessionStatus', appointment.status)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('today.ahead')}>
        {!scheduleState.data ? (
          scheduleState.error ? <ErrorState message={scheduleState.error} onRetry={scheduleState.reload} /> :
            <LoadingState label={t('today.loading')} />
        ) : snapshot.ahead.length === 0 ? (
          <EmptyState compact title={t('today.noAhead')} />
        ) : (
          <div className="list">
            {snapshot.ahead.map((appointment) => (
              <Link key={appointment.id} to={`/appointments/${appointment.id}`} className="row">
                <div className="title">
                  {data.clientNames.get(appointment.client_id) ?? t('today.noSubject')}
                </div>
                <div className="meta">
                  {formatDateTime(appointment.start_at, language)}{' · '}
                  <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {can(role, 'viewActivity') ? (
        <Section title={t('dashboard.recentActivity')}>
          {supplementalState.loading && !supplementalState.data ? (
            <LoadingState label={t('today.loading')} />
          ) : supplementalState.error ? (
            <ErrorState message={supplementalState.error} onRetry={supplementalState.reload} />
          ) : data.activity.length === 0 ? (
            <EmptyState compact title={t('dashboard.noActivity')} />
          ) : (
            <ul className="timeline">
              {data.activity.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  <div title={entry.event_type}>
                    {operationalLabel(language, 'event', entry.event_type)}
                  </div>
                  <div className="when">
                    {formatDateTime(entry.occurred_at, language)} · {label('actor', entry.actor_kind)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}

/**
 * One thing that needs the operator. The person is the row title; what is
 * wanted and when is the line beneath it. Tapping the row opens where the work
 * is done, never a list the operator then has to search.
 */
function NeedsYouRow({
  item,
  now,
  canDismiss,
  navigationPending,
  dismissing,
  onDismiss,
}: {
  item: TodayItem;
  now: Date;
  canDismiss: boolean;
  navigationPending?: boolean;
  dismissing: boolean;
  onDismiss: (target: AttentionItemRef) => void;
}) {
  const { t, label, language } = useLanguage();

  const kindLabel = t(`today.item.${item.kind}`);
  // A row about a person is titled with the person. A row about the system - a
  // batch of failed integration jobs - has no person to name, so it is titled
  // with what happened rather than with an apology for a missing name.
  const title = item.subject ?? kindLabel;

  const when = item.kind === 'overdue_follow_up' && item.at
    ? relativeDue(item.at, now, language).label
    : item.at
      ? formatDateTime(item.at, language)
      : null;

  const detail = item.kind === 'deposit_outstanding' && item.detail
    ? label('depositStatus', item.detail)
    : item.kind === 'integration_failure' && item.detail
      ? t('today.failedJobs', { count: item.detail })
      : item.kind === 'reply' && item.detail
        ? channelLabel(item.detail)
        : item.kind === 'conflict' && item.detail
          ? t(`today.conflict.${item.detail}`)
          : item.kind === 'unmatched_inbound' && item.detail
            ? t('today.unknownSenders', { count: item.detail })
            : item.kind === 'client_follow_up_due' || item.kind === 'client_cold'
              ? null
              : item.detail;
  // An AI next action is shown as what it is: a suggestion, labelled, never
  // the reason the row exists.
  const suggestion = item.aiSuggestion
    ? t('today.aiSuggestion', { action: t(`today.aiAction.${item.aiSuggestion.action_type}`) })
    : null;

  const content = (
    <>
      <div className="title">{title}</div>
      <div className="meta">
        {item.subject ? (
          <><span className={item.urgent ? 'badge warn' : 'badge'}>{kindLabel}</span>{' '}</>
        ) : null}
        {detail ? <><span className="badge">{detail}</span>{' '}</> : null}
        {when}
      </div>
      {suggestion ? <div className="meta today-ai-suggestion">{suggestion}</div> : null}
    </>
  );

  if (!item.href || navigationPending) return <div className="row" aria-busy={navigationPending}>{content}</div>;

  return (
    <div className="row today-attention-row">
      <Link to={item.href} className="today-attention-main">{content}</Link>
      {canDismiss && item.acknowledgement ? (
        <button
          type="button"
          className="badge today-dismiss"
          disabled={dismissing}
          onClick={() => onDismiss(item.acknowledgement!)}
        >
          {t('today.dismiss')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * "What changed since yesterday" and the two speed numbers, from the server
 * pulse. A source that could not be read is said out loud rather than shown
 * as nothing having happened.
 */
function PulseSummary({ pulse }: { pulse: TodayPulse }) {
  const { t } = useLanguage();
  if (pulse.artists.length === 0) return null;
  const sum = (pick: (a: TodayPulse['artists'][number]) => number) =>
    pulse.artists.reduce((total, artist) => total + (Number(pick(artist)) || 0), 0);
  const medians = pulse.artists
    .map((artist) => artist.median_first_reply_hours)
    .filter((value): value is number => typeof value === 'number');
  const staleGmail = pulse.artists.some((artist) => artist.sources?.gmail_snapshot === 'stale');
  return (
    <div className="today-pulse-summary">
      <p className="meta">
        {t('today.sinceYesterday', {
          enquiries: sum((a) => a.changes.new_enquiries),
          messages: sum((a) => a.changes.inbound_messages),
          sessions: sum((a) => a.changes.sessions_booked),
          payments: sum((a) => a.changes.payments_received),
        })}
        {medians.length ? <>{' · '}{t('today.medianFirstReply', { hours: Math.max(...medians) })}</> : null}
      </p>
      {staleGmail ? <p className="notice warn">{t('today.gmailStale')}</p> : null}
    </div>
  );
}

/** Channel names are product names; they are the same in both languages. */
function channelLabel(channel: string): string {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  return channel;
}

function sessionCountLabel(language: Language, count: number): string {
  if (language === 'en') return `${count} ${count === 1 ? 'session' : 'sessions'} today`;

  const lastTwo = count % 100;
  const last = count % 10;
  const noun = lastTwo >= 11 && lastTwo <= 14
    ? 'сеансов'
    : last === 1
      ? 'сеанс'
      : last >= 2 && last <= 4
        ? 'сеанса'
        : 'сеансов';
  return `сегодня ${count} ${noun}`;
}
