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

import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { formatDate, formatDateTime, relativeDue } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { can, canAccess } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { useArtistScope } from '../lib/artist-scope';
import { groupEmailThreads, type EmailThread } from '../lib/email-threads';
import { summariseToday, type TodayItem } from '../lib/today-workspace';
import { typeLabel } from './AppointmentsPage';
import type { Appointment } from '../lib/appointment-api';
import type { ConversationSummary } from '../lib/communications-api';
import type { MonzoReconciliationCandidate } from '../lib/payment-api';
import type { ActivityEntry, Enquiry, FollowUp, Project } from '../lib/types';
import { operationalLabel } from '../lib/operational-labels';

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
  clientNames: Map<string, string>;
}

export function DashboardPage() {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { t, label, language } = useLanguage();
  const role = profile?.role;
  const { selectedArtistId } = useArtistScope();
  const mayManageFinance = canAccess(role, 'manageFinance', memberships);

  const { data, loading, error, reload } = useAsync<TodayData>(async () => {
    const artistId = selectedArtistId ?? undefined;

    // Each read is asked for only where the role could hold the capability.
    // The database still decides what comes back.
    const [appointments, enquiries, projects, followUps, conversations, failedJobs, activity] = await Promise.all([
      can(role, 'viewSessions') ? api.listAppointments({ artistId }) : Promise.resolve([]),
      can(role, 'viewEnquiries') ? api.listEnquiries({ artistId }) : Promise.resolve([]),
      can(role, 'viewProjects') ? api.listProjects(undefined, artistId) : Promise.resolve([]),
      can(role, 'viewFollowUps') ? api.listFollowUps({ open: true, artistId }) : Promise.resolve([]),
      can(role, 'viewEnquiries') ? api.listConversations({ limit: 50 }) : Promise.resolve([]),
      can(role, 'viewIntegrationJobs') ? api.listFailedJobs(artistId) : Promise.resolve([]),
      can(role, 'viewActivity') ? api.listActivity({ artistId }) : Promise.resolve([]),
    ]);

    // The finance RPC is per artist. When no artist is chosen, ask for every
    // artist this operator can reach rather than showing nothing: the Payments
    // screen used to demand a selection it gave no way to make, and a landing
    // screen repeating that would be the same defect in a new place. The artist
    // list is resolved here rather than taken from the scope context so this
    // read does not restart every time that context finishes loading.
    const candidates = mayManageFinance
      ? (await Promise.all(
        (selectedArtistId
          ? [selectedArtistId]
          : (await api.listAccessibleArtists()).filter((artist) => artist.is_active).map((artist) => artist.id)
        ).map((id) => api.listMonzoReconciliationCandidates(id).catch(() => [])),
      )).flat()
      : [];

    // Email the CRM drafted or failed to send. Nothing showed these before, so
    // a lifecycle draft could sit unapproved indefinitely. Email is additive
    // here exactly as it is in the Inbox: if it cannot be read, Today still
    // renders everything else.
    const emailThreads = can(role, 'viewEnquiries')
      ? groupEmailThreads(
        await api.listEmailMessages({ artistId, limit: 200 }).catch(() => []),
      )
      : [];

    // "Who am I seeing?" is the question. A date and a duration badge is not an
    // answer, so every id that reaches a row is resolved to a name first.
    const clients = await api.listClientsByIds([
      ...appointments.map((appointment) => appointment.client_id),
      ...enquiries.map((enquiry) => enquiry.client_id),
      ...projects.map((project) => project.client_id),
      ...emailThreads.map((thread) => thread.client_id ?? ''),
    ]);

    return {
      appointments,
      enquiries,
      projects,
      followUps,
      conversations,
      emailThreads,
      candidates,
      failedJobCount: failedJobs.length,
      activity,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
    };
  }, [api, role, selectedArtistId, mayManageFinance]);

  if (loading) return <LoadingState label={t('today.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('today.allClear')} />;

  const now = new Date();
  const conversations = data.conversations.filter(
    (conversation) => !selectedArtistId || conversation.artist_id === selectedArtistId,
  );

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
    reconciliationCandidates: data.candidates,
    failedJobCount: data.failedJobCount,
    clientName: (clientId) => data.clientNames.get(clientId) ?? null,
  });

  return (
    <>
      <p className="today-context">
        {formatDate(now.toISOString(), language)} · {sessionCountLabel(language, snapshot.today.length)}
      </p>

      <Section title={t('today.needsYou')}>
        {snapshot.needsYou.length === 0 ? (
          <EmptyState compact title={t('today.allClear')} hint={t('today.allClearHint')} />
        ) : (
          <div className="list">
            {snapshot.needsYou.map((item) => (
              <NeedsYouRow key={item.key} item={item} now={now} />
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
          {data.activity.length === 0 ? (
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
function NeedsYouRow({ item, now }: { item: TodayItem; now: Date }) {
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
        : item.detail;

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
    </>
  );

  return item.href
    ? <Link to={item.href} className="row">{content}</Link>
    : <div className="row">{content}</div>;
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
