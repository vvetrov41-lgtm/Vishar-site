// The client workspace.
//
// This is the screen the CRM exists for. An operator opening a client is asking
// a fixed set of questions — who is this, what do they want, what stage are we
// at, when did we last speak, has the deposit been paid, what is booked, what do
// I do next — and the answers used to be spread across four other screens
// because the database keeps them in four other tables.
//
// The page still reads exactly the records the operator is allowed to read; the
// joins happen here rather than in the operator's head. `summariseClientWorkspace`
// owns the reasoning and is tested separately, so what this file does is fetch,
// order and render.

import { ArtistRelationship } from '../components/ArtistRelationship';
import { ClientEditPanel } from '../components/ClientEditPanel';
import { useAsync } from '../components/AsyncData';
import { DetailBackLink } from '../components/DetailContext';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { can } from '../lib/permissions';
import {
  summariseClientWorkspace,
  conversationAwaitsReply,
  type ClientWorkspaceSnapshot,
} from '../lib/client-workspace';
import { formatDate, formatDateTime, localiseKnownValue, relativeDue } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import { formatPhoneForDisplay } from '../lib/phone';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import { typeLabel } from './AppointmentsPage';
import type { Appointment } from '../lib/appointment-api';
import type { ClientConversation, ConversationMessage } from '../lib/communications-api';
import type { Client, Enquiry, FollowUp, InternalNote, Project } from '../lib/types';

interface ClientData {
  client: Client | null;
  enquiries: Enquiry[];
  projects: Project[];
  notes: InternalNote[];
  appointments: Appointment[];
  followUps: FollowUp[];
  conversations: ClientConversation[];
  latestMessages: ConversationMessage[];
}

const CHANNEL_LABELS: Record<'en' | 'ru', Record<ClientConversation['channel'], string>> = {
  en: { whatsapp: 'WhatsApp', instagram: 'Instagram' },
  ru: { whatsapp: 'WhatsApp', instagram: 'Instagram' },
};

export function ClientDetailPage({ clientId }: { clientId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { t, language } = useLanguage();
  const role = profile?.role;

  const { data, loading, error, reload } = useAsync<ClientData>(async () => {
    const client = await api.getClient(clientId);
    if (!client) {
      return {
        client: null,
        enquiries: [],
        projects: [],
        notes: [],
        appointments: [],
        followUps: [],
        conversations: [],
        latestMessages: [],
      };
    }

    // Each read is asked for only when the role could plausibly be allowed it.
    // The database still decides: a permitted request can legitimately return
    // nothing, and that is not an error.
    const [enquiries, projects, notes, appointments, followUps, conversations] = await Promise.all([
      api.listEnquiries({ clientId }),
      api.listProjects(clientId),
      can(role, 'viewNotes') ? api.listNotes({ clientId }) : Promise.resolve([]),
      can(role, 'viewSessions') ? api.listAppointments({ clientId }) : Promise.resolve([]),
      can(role, 'viewFollowUps') ? api.listFollowUps({ clientId }) : Promise.resolve([]),
      can(role, 'viewEnquiries') ? api.listConversationsForClient(clientId) : Promise.resolve([]),
    ]);

    // Only the most recent thread is expanded. "What did we last say?" is
    // answered by a handful of messages, not by pulling every conversation.
    const newest = [...conversations]
      .sort((left, right) => timeOf(right.last_message_at) - timeOf(left.last_message_at))[0] ?? null;
    const latestMessages = newest ? await api.listMessages(newest.id) : [];

    return { client, enquiries, projects, notes, appointments, followUps, conversations, latestMessages };
  }, [api, clientId, role]);

  if (loading) return <LoadingState label={t('client.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.client) return <EmptyState title={t('client.notFound')} />;

  const { client, enquiries, projects, notes, appointments, followUps, conversations, latestMessages } = data;
  const snapshot = summariseClientWorkspace({
    clientId,
    enquiries,
    projects,
    appointments,
    followUps,
    conversations,
    now: new Date(),
  });

  const artistIds = Array.from(new Set([
    ...enquiries.map((enquiry) => enquiry.artist_id),
    ...projects.map((project) => project.artist_id),
  ]));

  return (
    <>
      <DetailBackLink to="/clients" sectionLabel={t('nav.clients')} />

      <ClientStatusHeader
        client={client}
        snapshot={snapshot}
        artistIds={artistIds}
      />

      <NextActionCard snapshot={snapshot} />

      <WorkSection enquiries={enquiries} projects={projects} snapshot={snapshot} />

      {can(role, 'viewSessions') ? (
        <BookingsSection appointments={appointments} />
      ) : null}

      {can(role, 'viewEnquiries') ? (
        <MessagesSection conversations={conversations} messages={latestMessages} />
      ) : null}

      {can(role, 'viewFollowUps') ? (
        <FollowUpsSection followUps={snapshot.openFollowUps} clientId={clientId} />
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title={t('client.notes')}>
          {notes.length === 0 ? <EmptyState compact title={t('client.noNotes')} /> : (
            <ul className="timeline">
              {notes.map((note) => (
                <li key={note.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                  <div className="when">{formatDateTime(note.created_at, language)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {/* The nine-row identity block used to occupy the top of this page. It is
          reference material, not the operational question, so it sits last and
          closed. */}
      <section className="card">
        <details className="submitted-snapshot" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
          <summary>{t('clientWorkspace.details')}</summary>
          <dl className="definition">
            <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
            <dt>{t('enquiry.phone')}</dt><dd>{formatPhoneForDisplay(client.phone) ?? '—'}</dd>
            <dt>{t('enquiry.instagram')}</dt><dd>{client.instagram ?? '—'}</dd>
            <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(client.preferred_contact, language)}</dd>
            <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
            <dt>{t('artistScope.label')}</dt>
            <dd><ArtistRelationship artistIds={artistIds} showEmpty /></dd>
            <dt>{t('client.firstSeen')}</dt><dd>{formatDate(client.created_at, language)}</dd>
          </dl>
          <ClientEditPanel client={client} role={role} api={api} language={language} onSaved={reload} />
          <p className="notice" style={{ marginTop: 12 }}>{t('client.mergeNotice')}</p>
        </details>
      </section>
    </>
  );
}

/**
 * Identity and state in one block: who they are, then the four facts that decide
 * what happens next. Every value is a link to the record it came from.
 */
function ClientStatusHeader({
  client,
  snapshot,
  artistIds,
}: {
  client: Client;
  snapshot: ClientWorkspaceSnapshot;
  artistIds: string[];
}) {
  const { t, label, language } = useLanguage();
  const phone = formatPhoneForDisplay(client.phone);
  const next = snapshot.nextAppointment;
  const deposit = snapshot.depositProject;
  const conversation = snapshot.latestConversation;
  const overdue = snapshot.overdueFollowUps.length;
  const open = snapshot.openFollowUps.length;

  return (
    <section className="card client-workspace-header" aria-label={t('clientWorkspace.rightNow')}>
      <h2 className="client-workspace-name">{client.full_name}</h2>
      <p className="client-workspace-contact">
        {[phone, client.email, client.instagram].filter(Boolean).join(' · ') || '—'}
      </p>
      <div className="client-workspace-artists">
        <ArtistRelationship artistIds={artistIds} showEmpty />
      </div>

      <dl className="client-workspace-state">
        <div>
          <dt>{t('clientWorkspace.nextBooking')}</dt>
          <dd>
            {next ? (
              <Link to={`/appointments/${next.id}`} className="client-workspace-fact">
                {formatDateTime(next.start_at, language)} · {typeLabel(next.appointment_type, language)}
                {' '}
                <span className={next.status === 'confirmed' ? 'badge ok' : 'badge warn'}>
                  {label('sessionStatus', next.status)}
                </span>
              </Link>
            ) : (
              <span className="client-workspace-fact muted">{t('clientWorkspace.noBooking')}</span>
            )}
          </dd>
        </div>

        <div>
          <dt>{t('clientWorkspace.deposit')}</dt>
          <dd>
            {deposit ? (
              <Link to={`/projects/${deposit.id}`} className="client-workspace-fact">
                <span className={depositTone(deposit.deposit_status)}>
                  {label('depositStatus', deposit.deposit_status)}
                </span>
                {' '}{deposit.title}
              </Link>
            ) : (
              <span className="client-workspace-fact muted">{t('clientWorkspace.noDeposit')}</span>
            )}
          </dd>
        </div>

        <div>
          <dt>{t('clientWorkspace.lastMessage')}</dt>
          <dd>
            {conversation ? (
              <Link to={`/inbox/${conversation.id}`} className="client-workspace-fact">
                {formatDateTime(conversation.last_message_at, language)}
                {' '}
                <span className="badge">{CHANNEL_LABELS[language][conversation.channel]}</span>
                {snapshot.awaitingReply ? (
                  <> <span className="badge warn">{t('clientWorkspace.awaitingReply')}</span></>
                ) : null}
              </Link>
            ) : (
              <span className="client-workspace-fact muted">{t('clientWorkspace.noMessages')}</span>
            )}
          </dd>
        </div>

        <div>
          <dt>{t('clientWorkspace.followUps')}</dt>
          <dd>
            <span className="client-workspace-fact">
              {open === 0 ? (
                <span className="muted">{t('clientWorkspace.followUpsNone')}</span>
              ) : (
                <>
                  {overdue > 0 ? (
                    <span className="badge danger">
                      {t('clientWorkspace.followUpsOverdue', { count: overdue })}
                    </span>
                  ) : null}
                  {overdue > 0 ? ' ' : null}
                  <span className="badge">{t('clientWorkspace.followUpsOpen', { count: open })}</span>
                </>
              )}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * One recommended action. Not a row of equal-weight buttons: the point is that
 * the CRM has already read the state and has an opinion about what comes next.
 */
function NextActionCard({ snapshot }: { snapshot: ClientWorkspaceSnapshot }) {
  const { t } = useLanguage();
  const { kind, href } = snapshot.nextAction;

  return (
    <section className="card client-next-action">
      <h2>{t('clientWorkspace.nextAction')}</h2>
      <p className="client-next-action-why">{t(`clientWorkspace.action.${kind}Why`)}</p>
      {href ? (
        <div className="actions">
          <Link to={href} className="action-link primary">
            {t(`clientWorkspace.action.${kind}`)}
          </Link>
        </div>
      ) : (
        <p className="client-next-action-idle">{t('clientWorkspace.action.none')}</p>
      )}
    </section>
  );
}

/**
 * Enquiries and projects merged into one list of "things this client wants".
 * The operator does not distinguish them; the database does.
 */
function WorkSection({
  enquiries,
  projects,
  snapshot,
}: {
  enquiries: Enquiry[];
  projects: Project[];
  snapshot: ClientWorkspaceSnapshot;
}) {
  const { t, label, language } = useLanguage();

  type WorkRow = {
    key: string;
    href: string;
    title: string;
    kind: string;
    artistId: string;
    status: string;
    tone: string;
    when: string;
    extra: string | null;
  };

  const projectRows: WorkRow[] = projects.map((project) => ({
    key: `project-${project.id}`,
    href: `/projects/${project.id}`,
    title: project.title,
    kind: t('clientWorkspace.project'),
    artistId: project.artist_id,
    status: label('projectStatus', project.status),
    tone: project.status === 'active' ? 'badge ok' : 'badge',
    when: project.updated_at,
    extra: `${t('common.deposit')}: ${label('depositStatus', project.deposit_status)}`,
  }));

  // An enquiry that already became a project is history, not work: the project
  // row carries it. Showing both would double-count the same job.
  const convertedEnquiryIds = new Set(
    projects.map((project) => project.enquiry_id).filter((value): value is string => Boolean(value))
  );
  const enquiryRows: WorkRow[] = enquiries
    .filter((enquiry) => !convertedEnquiryIds.has(enquiry.id))
    .map((enquiry) => ({
      key: `enquiry-${enquiry.id}`,
      href: `/enquiries/${enquiry.id}`,
      title: enquiry.project_type || enquiry.reference_number,
      kind: t('clientWorkspace.enquiry'),
      artistId: enquiry.artist_id,
      status: label('enquiryStatus', enquiry.status),
      tone: 'badge',
      when: enquiry.created_at,
      extra: enquiry.project_type ? enquiry.reference_number : null,
    }));

  const rows = [...projectRows, ...enquiryRows].sort(
    (left, right) => timeOf(right.when) - timeOf(left.when)
  );

  return (
    <Section title={t('clientWorkspace.work')}>
      {rows.length === 0 ? (
        <EmptyState compact title={t('clientWorkspace.noWork')} hint={t('clientWorkspace.noWorkHint')} />
      ) : (
        <div className="list">
          {rows.map((row) => (
            <Link key={row.key} to={row.href} className="row">
              <div className="title">{row.title}</div>
              <div className="meta">
                <ArtistRelationship artistIds={[row.artistId]} />{' '}
                <span className="badge">{row.kind}</span>{' '}
                <span className={row.tone}>{row.status}</span>{' '}
                {row.extra ? <><span className="badge">{row.extra}</span>{' '}</> : null}
                {formatDate(row.when, language)}
              </div>
            </Link>
          ))}
        </div>
      )}
      {snapshot.unconfirmedAppointments.length > 0 ? (
        <p className="notice warn" role="status" style={{ marginTop: 12 }}>
          {t('clientWorkspace.action.confirm_appointmentWhy')}
        </p>
      ) : null}
    </Section>
  );
}

function BookingsSection({ appointments }: { appointments: Appointment[] }) {
  const { t, label, language } = useLanguage();
  const now = Date.now();

  const upcoming = appointments
    .filter((appointment) => appointment.cancelled_at === null && timeOf(appointment.start_at) >= now)
    .sort((left, right) => timeOf(left.start_at) - timeOf(right.start_at));
  const past = appointments
    .filter((appointment) => appointment.cancelled_at !== null || timeOf(appointment.start_at) < now)
    .sort((left, right) => timeOf(right.start_at) - timeOf(left.start_at))
    .slice(0, 5);

  return (
    <Section
      title={t('clientWorkspace.bookings')}
      action={<Link to="/appointments" className="badge client-workspace-link">{t('clientWorkspace.viewAllBookings')}</Link>}
    >
      {appointments.length === 0 ? (
        <EmptyState
          compact
          title={t('clientWorkspace.noBookings')}
          hint={t('clientWorkspace.noBookingsHint')}
        />
      ) : (
        <>
          <h3>{t('clientWorkspace.upcoming')}</h3>
          {upcoming.length === 0 ? (
            <EmptyState compact title={t('clientWorkspace.noBooking')} />
          ) : (
            <div className="list">
              {upcoming.map((appointment) => (
                <AppointmentRow key={appointment.id} appointment={appointment} />
              ))}
            </div>
          )}

          {past.length > 0 ? (
            <>
              <h3 style={{ marginTop: 14 }}>{t('clientWorkspace.past')}</h3>
              <div className="list">
                {past.map((appointment) => (
                  <AppointmentRow key={appointment.id} appointment={appointment} />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </Section>
  );

  function AppointmentRow({ appointment }: { appointment: Appointment }) {
    const cancelled = appointment.cancelled_at !== null;
    return (
      <Link to={`/appointments/${appointment.id}`} className="row">
        <div className="title">{formatDateTime(appointment.start_at, language)}</div>
        <div className="meta">
          <span className="badge">{typeLabel(appointment.appointment_type, language)}</span>{' '}
          <span className={cancelled ? 'badge danger' : appointment.status === 'confirmed' ? 'badge ok' : 'badge warn'}>
            {label('sessionStatus', appointment.status)}
          </span>{' '}
          {appointment.duration_hours !== null ? (
            <span className="badge">{appointment.duration_hours} {t('common.hoursShort')}</span>
          ) : null}
        </div>
      </Link>
    );
  }
}

/**
 * The most recent thread, inline. "When did we last speak and what was said?"
 * is a question about content, not about a link to another screen.
 */
function MessagesSection({
  conversations,
  messages,
}: {
  conversations: ClientConversation[];
  messages: ConversationMessage[];
}) {
  const { t, language } = useLanguage();
  const newest = [...conversations]
    .sort((left, right) => timeOf(right.last_message_at) - timeOf(left.last_message_at))[0] ?? null;

  if (!newest) {
    return (
      <Section title={t('clientWorkspace.messages')}>
        <EmptyState
          compact
          title={t('clientWorkspace.noMessages')}
          hint={t('clientWorkspace.noMessagesHint')}
        />
      </Section>
    );
  }

  const recent = messages.slice(-4);

  return (
    <Section
      title={t('clientWorkspace.messages')}
      action={
        <Link to={`/inbox/${newest.id}`} className="badge client-workspace-link">
          {t('clientWorkspace.openConversation')}
        </Link>
      }
    >
      <p className="meta">
        <span className="badge">{CHANNEL_LABELS[language][newest.channel]}</span>{' '}
        {conversationAwaitsReply(newest) ? (
          <span className="badge warn">{t('clientWorkspace.awaitingReply')}</span>
        ) : null}
      </p>
      {recent.length === 0 ? (
        <EmptyState compact title={t('clientWorkspace.noMessages')} />
      ) : (
        <ul className="timeline">
          {recent.map((message) => (
            <li key={message.id}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{message.body ?? '—'}</div>
              <div className="when">
                {message.direction === 'inbound' ? t('clientWorkspace.them') : t('clientWorkspace.you')}
                {' · '}
                {formatDateTime(message.created_at, language)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {conversations.length > 1 ? (
        <p className="meta" style={{ marginTop: 10 }}>
          {t('clientWorkspace.moreConversations', { count: conversations.length - 1 })}
        </p>
      ) : null}
    </Section>
  );
}

function FollowUpsSection({ followUps, clientId }: { followUps: FollowUp[]; clientId: string }) {
  const { t, language } = useLanguage();
  const now = new Date();

  return (
    <Section title={t('clientWorkspace.followUps')}>
      {followUps.length === 0 ? (
        <EmptyState compact title={t('clientWorkspace.followUpsNone')} />
      ) : (
        <div className="list">
          {followUps.map((followUp) => {
            const due = relativeDue(followUp.due_at, now, language);
            const href = followUp.enquiry_id
              ? `/enquiries/${followUp.enquiry_id}`
              : followUp.project_id
                ? `/projects/${followUp.project_id}`
                : `/clients/${clientId}`;
            return (
              <Link key={followUp.id} to={href} className="row">
                <div className="title">{followUp.subject}</div>
                <div className="meta">
                  <span className={due.overdue ? 'badge danger' : 'badge'}>{due.label}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function depositTone(status: Project['deposit_status']): string {
  if (status === 'paid') return 'badge ok';
  if (status === 'requested') return 'badge warn';
  if (status === 'refunded' || status === 'forfeited') return 'badge danger';
  return 'badge';
}

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
