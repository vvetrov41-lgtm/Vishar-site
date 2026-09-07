// One enquiry, read in the time it takes to pick up the phone.
//
// This page used to be nine cards deep. The reference number was in the first,
// the client's phone number in the fourth, the tattoo itself in the sixth, and
// between them sat three sections that said "No notes yet". On a phone, working
// out who this was and what to do about it meant scrolling past everything that
// was not the answer.
//
// What changed:
//
//   - a summary card carries the whole recognisable enquiry - reference,
//     status, who, how to reach them, what they want, when they are booked in;
//   - one "Next action" section holds the workflow, with the action the current
//     state is actually waiting on marked as the one to press. Status changes,
//     reassignment and closing stay, behind a disclosure, because they are
//     administration rather than the job;
//   - a tattoo session is booked straight from here. The project is created by
//     the database when the session is, so nobody has to know that Project is a
//     required internal entity;
//   - the sections that are usually empty collapse to a heading and a count;
//   - the reference images stay open, because they are what the artist came for.

import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { CollapsedSection } from '../components/CollapsedSection';
import { DetailBackLink, RecordArtistContext } from '../components/DetailContext';
import { EnquiryConsultationPanel } from '../components/EnquiryConsultationPanel';
import { EnquiryContactConflict } from '../components/EnquiryContactConflict';
import { EnquiryEditPanel } from '../components/EnquiryEditPanel';
import { EnquiryReferenceActions } from '../components/EnquiryReferenceActions';
import { BookingPanel } from '../components/BookingPanel';
import { EnquiryWhatsAppPanel } from '../components/EnquiryWhatsAppPanel';
import { groupEmailThreads, threadNeedsOperator, type EmailThread } from '../lib/email-threads';
import { CollapsibleActivityLog } from '../components/CollapsibleActivityLog';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { SignedImage } from '../components/SignedImage';
import { Link, useRouter } from '../lib/router';
import { can } from '../lib/permissions';
import { enquiryWorkflowActions } from '../lib/enquiryWorkflow';
import { nextEnquiryAction, type EnquiryNextAction } from '../lib/enquiry-next-action';
import { formatDateTime, localiseKnownValue, localiseSystemSubject, relativeDue } from '../lib/format';
import { formatPhoneForDisplay } from '../lib/phone';
import { useLanguage } from '../lib/i18n';
import type { Appointment } from '../lib/appointment-api';
import type { ClientConversation } from '../lib/communications-api';
import type {
  ActivityEntry, Client, Enquiry, EnquiryFile, FollowUp, InternalNote, Profile, StatusTransition,
} from '../lib/types';

interface DetailData {
  enquiry: Enquiry | null;
  client: Client | null;
  files: EnquiryFile[];
  notes: InternalNote[];
  followUps: FollowUp[];
  activity: ActivityEntry[];
  transitions: StatusTransition[];
  colleagues: Pick<Profile, 'id' | 'display_name' | 'role'>[];
  /** Newest email thread on this enquiry, or null when there is none. */
  emailThread: EmailThread | null;
  /** Appointments booked against this enquiry, soonest first. */
  appointments: Appointment[];
  /** Where a reply would actually go. Newest conversation first. */
  conversations: ClientConversation[];
}

const LIVE_APPOINTMENT = new Set(['draft', 'proposed', 'confirmed']);

function upcoming(appointments: Appointment[], now: Date): Appointment | null {
  return appointments.find(
    (appointment) => LIVE_APPOINTMENT.has(appointment.status)
      && new Date(appointment.end_at).getTime() >= now.getTime()
  ) ?? null;
}

export function EnquiryDetailPage({ enquiryId }: { enquiryId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { navigate } = useRouter();
  const { t, label, language } = useLanguage();
  const role = profile?.role;

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState('');

  const { data, loading, error, reload } = useAsync<DetailData>(async () => {
    const enquiry = await api.getEnquiry(enquiryId);
    if (!enquiry) {
      return {
        enquiry: null, client: null, files: [], notes: [], followUps: [], activity: [],
        transitions: [], colleagues: [], emailThread: null, appointments: [], conversations: [],
      };
    }

    const [client, files, notes, followUps, activity, transitions, colleagues, clientAppointments] = await Promise.all([
      api.getClient(enquiry.client_id),
      can(role, 'viewEnquiryFiles') ? api.listEnquiryFiles(enquiryId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ enquiryId }) : Promise.resolve([]),
      api.listFollowUps({ enquiryId }),
      can(role, 'viewActivity') ? api.listActivity({ enquiryId }) : Promise.resolve([]),
      can(role, 'transitionEnquiry') ? api.listStatusTransitions() : Promise.resolve([]),
      can(role, 'assignEnquiry') ? api.listAssignableProfiles() : Promise.resolve([]),
      can(role, 'viewSessions')
        ? api.listAppointments({ clientId: enquiry.client_id })
        : Promise.resolve([] as Appointment[]),
    ]);

    // Additive, like everywhere else email and messaging appear: a Gmail or
    // inbox problem must not stop the enquiry from rendering.
    const emailThread = groupEmailThreads(
      await api.listEmailMessages({ enquiryId, limit: 50 }).catch(() => []),
    )[0] ?? null;
    const conversations = can(role, 'viewEnquiries')
      ? await api.listConversationsForClient(enquiry.client_id).catch(() => [] as ClientConversation[])
      : [];

    return {
      enquiry, client, files, notes, followUps, activity, transitions, colleagues, emailThread,
      appointments: clientAppointments.filter((appointment) => appointment.enquiry_id === enquiryId),
      conversations,
    };
  }, [api, enquiryId, role]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('enquiry.actionFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label={t('enquiry.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.enquiry) {
    return <EmptyState title={t('enquiry.notFound')} hint={t('enquiry.notFoundHint')} />;
  }

  const {
    enquiry, client, files, notes, followUps, activity, transitions, colleagues,
    emailThread, appointments, conversations,
  } = data;
  const { transitionOptions, canConvert } = enquiryWorkflowActions(transitions, enquiry.status, role);
  const canAssign = can(role, 'assignEnquiry');
  // Booking is a workflow action, so it belongs with the other workflow
  // actions rather than inside "Edit enquiry", whose editEnquiry gate it used
  // to inherit on top of its own manageSessions one.
  const canBook = can(role, 'manageSessions');
  const readyFiles = files.filter((file) => file.upload_state === 'ready');
  const nextAppointment = upcoming(appointments, new Date());
  const assignee = colleagues.find((colleague) => colleague.id === enquiry.assigned_to);
  const conversation = conversations[0] ?? null;
  const replyHref = conversation
    ? `/inbox/${conversation.id}`
    : emailThread ? `/inbox/email/${emailThread.key}` : '/inbox';

  const recommended: EnquiryNextAction = nextEnquiryAction({
    status: enquiry.status,
    intakeComplete: enquiry.intake_state === 'complete',
    hasUpcomingAppointment: nextAppointment !== null,
  });

  const hasAdminActions = transitionOptions.length > 0 || canAssign || canConvert;

  return (
    <>
      <DetailBackLink to="/enquiries" sectionLabel={t('nav.enquiries')} />
      <RecordArtistContext artistId={enquiry.artist_id} />

      {/* Everything needed to recognise this enquiry, in one card. */}
      <section className="card enquiry-summary">
        <div className="enquiry-summary-headline">
          <h2 className="enquiry-summary-reference">{enquiry.reference_number}</h2>
          <span className="badge">{label('enquiryStatus', enquiry.status)}</span>
          {enquiry.intake_state !== 'complete' ? (
            <span className="badge warn">
              {t('common.intake', { state: label('intakeState', enquiry.intake_state) })}
            </span>
          ) : null}
          {enquiry.status === 'deposit_requested' || enquiry.status === 'deposit_paid' ? (
            <span className="badge">
              {t('enquiry.depositBadge', { state: label('enquiryStatus', enquiry.status) })}
            </span>
          ) : null}
        </div>

        <dl className="definition">
          <dt>{t('enquiry.name')}</dt>
          <dd>{client ? client.full_name : t('enquiry.clientUnavailable')}</dd>
          <dt>{t('enquiry.phone')}</dt>
          <dd>{formatPhoneForDisplay(client?.phone ?? null) ?? '—'}</dd>
          <dt>{t('enquiry.instagram')}</dt>
          <dd>{client?.instagram ?? '—'}</dd>
          <dt>{t('enquiry.prefers')}</dt>
          <dd>{localiseKnownValue(client?.preferred_contact ?? null, language)}</dd>
          <dt>{t('enquiry.assignedTo')}</dt>
          <dd>{assignee?.display_name ?? t('common.unassigned')}</dd>
          <dt>{t('enquiry.type')}</dt>
          <dd>{enquiry.project_type ?? '—'}</dd>
          <dt>{t('enquiry.received')}</dt>
          <dd>{formatDateTime(enquiry.created_at, language)}</dd>
          {nextAppointment ? (
            <>
              <dt>{t('enquiry.nextAppointment')}</dt>
              <dd>
                {formatDateTime(nextAppointment.start_at, language)}
                {' · '}
                {label('sessionStatus', nextAppointment.status)}
              </dd>
            </>
          ) : null}
        </dl>

        {enquiry.idea ? <p className="enquiry-summary-idea">{enquiry.idea}</p> : null}
        <p className="meta" style={{ marginBottom: 0 }}>
          {t('enquiry.nextActionIs', { action: t(`enquiry.next.${recommended}`) })}
        </p>
      </section>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      {enquiry.client_identifier_conflict ? (
        <div className="notice warn" role="alert">{t('enquiry.identifierConflict')}</div>
      ) : null}

      {client ? (
        <EnquiryContactConflict enquiry={enquiry} client={client} api={api} onSaved={reload} />
      ) : null}

      {/* The work, in the order the state says it is waiting for it. */}
      <Section title={t('enquiry.nextAction')}>
        <div className="actions">
          <Link
            to={replyHref}
            className={recommended === 'reply' || recommended === 'chase' ? 'action-link primary' : 'action-link'}
          >
            {t('enquiry.replyToClient')}
          </Link>
        </div>

        {canBook ? <EnquiryConsultationPanel enquiry={enquiry} onChanged={reload} /> : null}

        {canBook && client ? (
          <details className="booking-disclosure" open={recommended === 'bookSession'}>
            <summary>{t('booking.title')}</summary>
            {/* No "create the project first" step. schedule_appointment makes
                the enquiry's project in the same transaction as the session,
                so this is the whole flow. */}
            <BookingPanel
              artistId={enquiry.artist_id}
              clientId={client.id}
              clientName={client.full_name}
              enquiryId={enquiry.id}
              onBooked={() => reload()}
            />
          </details>
        ) : null}

        {hasAdminActions ? (
          <details className="enquiry-admin">
            <summary>{t('enquiry.adminActions')}</summary>

            {transitionOptions.length > 0 ? (
              <div>
                <h3 style={{ margin: '12px 0 8px', fontSize: '0.9rem' }}>{t('enquiry.moveOn')}</h3>
                <div className="actions" style={{ marginTop: 0 }}>
                  {transitionOptions.map((transition) => (
                    <button
                      key={transition.to_status}
                      type="button"
                      disabled={busy}
                      onClick={() => { void run(() => api.transitionEnquiry(enquiry.id, transition.to_status)); }}
                    >
                      {label('enquiryStatus', transition.to_status)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {canAssign ? (
              <div style={{ marginTop: 16 }}>
                <label htmlFor="assignee">{t('enquiry.assignedTo')}</label>
                <select
                  id="assignee"
                  aria-label={t('enquiry.assignee')}
                  value={enquiry.assigned_to ?? ''}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value || null;
                    void run(() => api.assignEnquiry(enquiry.id, value));
                  }}
                >
                  <option value="">{t('common.unassigned')}</option>
                  {colleagues.map((colleague) => (
                    <option key={colleague.id} value={colleague.id}>
                      {/* Never the id: a raw UUID in a person picker is
                          unreadable and tells the operator nothing. */}
                      {colleague.display_name ?? t('common.unnamedColleague')}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {canConvert ? (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ margin: '0 0 6px', fontSize: '0.9rem' }}>{t('enquiry.convertTitle')}</h3>
                <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0 0 10px' }}>
                  {t('enquiry.convertHint')}
                </p>
                <button
                  type="button"
                  disabled={busy || enquiry.intake_state !== 'complete'}
                  onClick={() => {
                    void run(async () => {
                      const result = await api.convertEnquiry(
                        enquiry.id,
                        `${enquiry.project_type ?? t('enquiry.defaultProjectTitle')} — ${enquiry.submitted_full_name ?? client?.full_name ?? enquiry.reference_number}`
                      );
                      const projectId = (result as { project_id?: string })?.project_id;
                      if (projectId) navigate(`/projects/${projectId}`);
                    });
                  }}
                >
                  {t('enquiry.convertButton')}
                </button>
              </div>
            ) : null}
          </details>
        ) : null}
      </Section>

      {/* The tattoo. This is the decision the artist is here to make, so it
          stays open and stays above the administration. */}
      <Section title={t('enquiry.project')}>
        <dl className="definition">
          <dt>{t('enquiry.placement')}</dt><dd>{enquiry.placement ?? '—'}</dd>
          <dt>{t('enquiry.size')}</dt><dd>{enquiry.approximate_size ?? '—'}</dd>
          <dt>{t('enquiry.coverUp')}</dt><dd>{localiseKnownValue(enquiry.cover_up, language)}</dd>
          <dt>{t('enquiry.timing')}</dt><dd>{enquiry.preferred_timing ?? '—'}</dd>
        </dl>
        <p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{enquiry.idea ?? '—'}</p>
        <EnquiryEditPanel enquiry={enquiry} role={role} api={api} language={language} onSaved={reload} />
      </Section>

      {can(role, 'viewEnquiryFiles') ? (
        <Section title={t('enquiry.referenceImages')}>
          {readyFiles.length === 0 ? (
            <EmptyState title={t('enquiry.noReferenceImages')} />
          ) : (
            <div className="thumbs">
              {readyFiles.map((file) => (
                <SignedImage
                  key={file.id}
                  file={file}
                  removeDisabled={busy}
                  onRemove={can(role, 'removeEnquiryFiles')
                    ? () => { void run(() => api.removeEnquiryReference(file)); }
                    : undefined}
                />
              ))}
            </div>
          )}
          <EnquiryReferenceActions enquiryId={enquiry.id} files={files} role={role} api={api} language={language} onChanged={reload} />
          <p className="notice" style={{ marginTop: 12 }}>{t('enquiry.imageNotice')}</p>
        </Section>
      ) : null}

      {/* Cross-link, not a second copy. The Inbox is where email is worked;
          the enquiry only says that email exists and points at it. */}
      {emailThread ? (
        <Section title={t('enquiry.email')}>
          <p className="meta">{emailThread.subject}</p>
          <div className="actions">
            <Link to={`/inbox/email/${emailThread.key}`} className="badge">
              {t('enquiry.openEmailConversation')}
            </Link>
            {threadNeedsOperator(emailThread) ? (
              <span className="badge warn">
                {emailThread.state === 'send_failed'
                  ? t('enquiry.emailSendFailed')
                  : t('enquiry.emailDraftToApprove')}
              </span>
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* WhatsApp setup belongs in Integrations. What belongs here is the
          thread, and one line saying whether there is one. */}
      {client ? (
        <CollapsedSection title="WhatsApp" count={conversations.filter((row) => row.channel === 'whatsapp').length}>
          <EnquiryWhatsAppPanel
            api={api}
            enquiryId={enquiry.id}
            clientId={client.id}
            artistId={enquiry.artist_id}
            phone={client.phone}
            role={role}
            language={language}
          />
        </CollapsedSection>
      ) : null}

      <CollapsedSection title={t('enquiry.currentClient')} count={client ? 1 : 0}>
        {client ? (
          <>
            <dl className="definition">
              <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
              <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
            </dl>
            <div className="actions">
              <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openClient')}</Link>
            </div>
          </>
        ) : (
          <EmptyState title={t('enquiry.clientUnavailable')} />
        )}

        <details className="submitted-snapshot">
          <summary>{t('enquiry.contactSubmitted')}</summary>
          <dl className="definition">
            <dt>{t('enquiry.name')}</dt><dd>{enquiry.submitted_full_name ?? '—'}</dd>
            <dt>{t('enquiry.email')}</dt><dd>{enquiry.submitted_email ?? '—'}</dd>
            <dt>{t('enquiry.phone')}</dt><dd>{formatPhoneForDisplay(enquiry.submitted_phone) ?? '—'}</dd>
            <dt>{t('enquiry.instagram')}</dt><dd>{enquiry.submitted_instagram ?? '—'}</dd>
            <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(enquiry.submitted_preferred_contact, language)}</dd>
            <dt>{t('enquiry.travellingFrom')}</dt><dd>{enquiry.submitted_travelling_from ?? '—'}</dd>
          </dl>
        </details>
      </CollapsedSection>

      {can(role, 'viewFollowUps') ? (
        <CollapsedSection title={t('enquiry.followUps')} count={followUps.length}>
          {followUps.length === 0 ? (
            <EmptyState title={t('enquiry.noFollowUps')} compact />
          ) : (
            <div className="list">
              {followUps.map((followUp) => {
                const due = relativeDue(followUp.due_at, new Date(), language);
                return (
                  <div key={followUp.id} className="row">
                    <div className="title">{localiseSystemSubject(followUp.subject, language)}</div>
                    <div className="meta">
                      <span className={due.overdue ? 'badge danger' : 'badge'}>{due.label}</span>{' '}
                      <span className="badge">{label('followUpStatus', followUp.status)}</span>
                      {can(role, 'manageFollowUps') && followUp.status === 'open' ? (
                        <div className="actions">
                          <button
                            type="button" disabled={busy}
                            onClick={() => { void run(() => api.completeFollowUp(followUp.id)); }}
                          >
                            {t('enquiry.markDone')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {can(role, 'manageFollowUps') ? (
            <div className="actions">
              <button
                type="button" disabled={busy}
                onClick={() => {
                  const dueAt = new Date(Date.now() + 3 * 86400000).toISOString();
                  void run(() => api.createFollowUp(t('enquiry.chaseSubject'), dueAt, { enquiryId: enquiry.id }));
                }}
              >
                {t('enquiry.addThreeDayFollowUp')}
              </button>
            </div>
          ) : null}
        </CollapsedSection>
      ) : null}

      {can(role, 'viewNotes') ? (
        <CollapsedSection title={t('enquiry.internalNotes')} count={notes.length}>
          {can(role, 'createNotes') ? (
            <>
              <label htmlFor="note-body">{t('enquiry.addNote')}</label>
              <textarea
                id="note-body" value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
                placeholder={t('enquiry.notePlaceholder')}
              />
              <div className="actions">
                <button
                  type="button" disabled={busy || noteBody.trim().length === 0}
                  onClick={() => {
                    void run(async () => {
                      await api.createNote(noteBody.trim(), { enquiryId: enquiry.id });
                      setNoteBody('');
                    });
                  }}
                >
                  {t('enquiry.saveNote')}
                </button>
              </div>
            </>
          ) : null}

          {notes.length === 0 ? (
            <EmptyState title={t('enquiry.noNotes')} compact />
          ) : (
            <ul className="timeline" style={{ marginTop: 12 }}>
              {notes.map((note) => (
                <li key={note.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                  <div className="when">{formatDateTime(note.created_at, language)}</div>
                </li>
              ))}
            </ul>
          )}
        </CollapsedSection>
      ) : null}

      {can(role, 'viewActivity') ? (
        <CollapsedSection title={t('enquiry.activity')} count={activity.length}>
          <CollapsibleActivityLog activity={activity} />
        </CollapsedSection>
      ) : null}
    </>
  );
}
