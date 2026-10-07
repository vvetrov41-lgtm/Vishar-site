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

import { useEffect, useState } from 'react';
import { useAsync } from '../components/AsyncData';
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
  appointments: Appointment[];
  enquiries: Enquiry[];
  conversations: ConversationSummary[];
  emailThreads: EmailThread[];
  clientNames: Map<string, string>;
  pulse: TodayPulse | null;
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

interface GmailDiscoveryState {
  scopeKey: string;
  rows: GmailAwaitingReply[];
}

export function DashboardPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const { selectedArtistId } = useArtistScope();
  const mayManageFinance = canAccess(role, 'manageFinance', memberships);
  const mayDismissAttention = can(role, 'manageNotifications');
  const mayViewEnquiries = can(role, 'viewEnquiries');
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const gmailScopeKey = `${profile?.id ?? 'anonymous'}:${selectedArtistId ?? 'all'}:${mayViewEnquiries ? '1' : '0'}`;
  const [gmailDiscovery, setGmailDiscovery] = useState<GmailDiscoveryState>({ scopeKey: '', rows: [] });

  // The visible Today shell has two data lanes:
  //
  // 1. Core: server pulse + schedule + the navigation records those rows need.
  //    This is the critical path. When the server pulse is enabled it may render
  //    as soon as these reads finish.
  // 2. Supplemental: browser-fallback rules, finance, integration health and
  //    recent activity. These continue in parallel but cannot hold an enabled
  //    server pulse hostage.
  //
  // If the server pulse is unavailable or switched off we still wait for the
  // supplemental lane, preserving the old fail-closed browser calculation.
  const coreState = useAsync<TodayCoreData>(async () => {
    const artistId = selectedArtistId ?? undefined;

    const [appointments, enquiries, conversations, emailMessages, pulse] = await Promise.all([
      can(role, 'viewSessions') ? api.listAppointments({ artistId, from: daysAgoIso(90) }) : Promise.resolve([]),
      mayViewEnquiries ? api.listEnquiries({ artistId }) : Promise.resolve([]),
      mayViewEnquiries ? api.listConversations({ limit: 50 }) : Promise.resolve([]),
      mayViewEnquiries ? api.listEmailMessages({ artistId, limit: 200 }).catch(() => []) : Promise.resolve([]),
      // The server pulse is additive: if it cannot be read, Today falls back to
      // the complete browser lane below.
      api.getTodayPulse(artistId).catch(() => null),
    ]);

    const emailThreads = groupEmailThreads(emailMessages);

    // Resolve only names needed by the critical path. Project/follow-up-only
    // clients are resolved in the supplemental lane and merged later.
    const clients = await api.listClientsByIds([
      ...appointments.map((appointment) => appointment.client_id),
      ...enquiries.map((enquiry) => enquiry.client_id),
      ...emailThreads.map((thread) => thread.client_id ?? ''),
    ]);

    return {
      appointments,
      enquiries,
      conversations,
      emailThreads,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
      pulse,
    };
  }, [api, role, selectedArtistId, mayViewEnquiries]);

  const supplementalState = useAsync<TodaySupplementalData>(async () => {
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
  }, [api, role, selectedArtistId, mayManageFinance]);

  // Gmail attention is CRM-owned snapshot state. This read goes directly to
  // Supabase under RLS and never contacts the Gmail Worker or Google, so Today
  // remains independent of provider latency and outages.
  useEffect(() => {
    let cancelled = false;

    if (!mayViewEnquiries) {
      setGmailDiscovery({ scopeKey: gmailScopeKey, rows: [] });
      return () => { cancelled = true; };
    }

    void api.listGmailMetadataSnapshots(selectedArtistId ?? undefined)
      .then((snapshots) => snapshots.map((entry) => ({
        artist_id: entry.artist_id,
        client_id: entry.client_id,
        client_name: null,
        subject: entry.subject,
        last_message_at: entry.last_message_at,
        direction: entry.direction,
      })))
      .catch(() => [])
      .then((rows) => {
        if (!cancelled) setGmailDiscovery({ scopeKey: gmailScopeKey, rows });
      });

    return () => { cancelled = true; };
  }, [api, gmailScopeKey, mayViewEnquiries, selectedArtistId]);

  const coreData = coreState.data;
  const enabledServerPulse = coreData?.pulse?.enabled ? coreData.pulse : null;
  const requiresBrowserFallback = Boolean(coreData && !enabledServerPulse);
  const reload = () => {
    coreState.reload();
    supplementalState.reload();
  };

  if (coreState.loading && !coreData) return <LoadingState label={t('today.loading')} />;
  if (coreState.error) return <ErrorState message={coreState.error} onRetry={reload} />;
  if (!coreData) return <EmptyState title={t('today.allClear')} />;

  // The browser engine is still the source of truth whenever the server pulse
  // is disabled/unavailable, so never render it from partial supplemental data.
  if (requiresBrowserFallback && supplementalState.loading && !supplementalState.data) {
    return <LoadingState label={t('today.loading')} />;
  }
  if (requiresBrowserFallback && supplementalState.error) {
    return <ErrorState message={supplementalState.error} onRetry={reload} />;
  }

  const supplementalData = supplementalState.data ?? EMPTY_SUPPLEMENTAL_DATA;
  const clientNames = new Map([
    ...coreData.clientNames,
    ...supplementalData.clientNames,
  ]);
  const data: TodayData = {
    ...coreData,
    ...supplementalData,
    clientNames,
  };

  const now = new Date();
  const conversations = data.conversations.filter(
    (conversation) => !selectedArtistId || conversation.artist_id === selectedArtistId,
  );
  const gmailAwaitingReply = gmailDiscovery.scopeKey === gmailScopeKey
    ? gmailDiscovery.rows
    : [];

  const snapshot = summariseToday({
    now,
    appointments: data.appointments,
    enquiries: data.enquiries,
    projects: data.projects,
    followUps: data.followUps,
    conversations,
    emailThreads: data.emailThreads.filter(
      (thread) => !selectedArtistId || thread.artist_id === selectedArtistId,
    ),
    gmailAwaitingReply,
    acknowledgements: data.acknowledgements,
    reconciliationCandidates: data.candidates,
    failedJobCount: data.failedJobCount,
    clientName: (clientId) => data.clientNames.get(clientId) ?? null,
  });
  // One engine for Today and Telegram once the server pulse is switched on.
  // The schedule below still comes from the appointments read here.
  const serverPulse = data.pulse?.enabled ? data.pulse : null;
  const needsYou = enquiryTargetsForToday(
    serverPulse ? pulseToTodayItems(serverPulse) : snapshot.needsYou,
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
        {needsYou.length === 0 ? (
          <EmptyState compact title={t('today.allClear')} hint={t('today.allClearHint')} />
        ) : (
          <div className="list">
            {needsYou.map((item) => (
              <NeedsYouRow
                key={item.key}
                item={item}
                now={now}
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
        {snapshot.today.length === 0 ? (
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
        {snapshot.ahead.length === 0 ? (
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
  dismissing,
  onDismiss,
}: {
  item: TodayItem;
  now: Date;
  canDismiss: boolean;
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

  if (!item.href) return <div className="row">{content}</div>;

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
