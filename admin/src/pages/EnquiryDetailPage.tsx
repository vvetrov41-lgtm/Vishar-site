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
//   - a summary card carries the whole recognisable enquiry - client name,
//     status, how to reach them, what they want and when they are booked in.
//     The client's own words are the only description: the AI summary that
//     sat here was removed on 2026-10-04 after it misplaced tattoos and
//     invented facts, so reading it never saved reading the original;
//   - one "Next action" section holds the workflow, with the action the current
//     state is actually waiting on marked as the one to press. Status changes,
//     reassignment and closing stay, behind a disclosure, because they are
//     administration rather than the job;
//   - a tattoo session is booked straight from here. The project is created by
//     the database when the session is, so nobody has to know that Project is a
//     required internal entity;
//   - the sections that are usually empty collapse to a heading and a count;
//   - the reference images stay open, because they are what the artist came for.

import { confirmEnquiryTransition } from '../lib/enquiry-transition-confirm';
import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { CollapsedSection } from '../components/CollapsedSection';
import { DetailHeader } from '../components/DetailContext';
import { EnquiryConsultationPanel } from '../components/EnquiryConsultationPanel';
import { EnquiryContactConflict } from '../components/EnquiryContactConflict';
import { EnquiryArchiveAction, EnquiryEditPanel } from '../components/EnquiryEditPanel';
import { EnquiryReferenceActions } from '../components/EnquiryReferenceActions';
import { BookingPanel } from '../components/BookingPanel';
import { EnquiryWhatsAppPanel } from '../components/EnquiryWhatsAppPanel';
import { EnquiryReplyEvidence } from '../components/EnquiryReplyEvidence';
import { EnquiryTranslation } from '../components/EnquiryTranslation';
import { ClientBrief } from '../components/ClientBrief';
import { EnquiryProjectDetails, isStructuredProjectDetails } from '../components/EnquiryProjectDetails';
import { EnquiryStructuredEditPanel } from '../components/EnquiryStructuredEditPanel';
import { groupEmailThreads, threadNeedsOperator, type EmailThread } from '../lib/email-threads';
import { ActivityFeed } from '../components/ActivityFeed';
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
import { enquiryHeadline } from '../lib/enquiry-summary';
import type {
  Client, Enquiry, EnquiryFile, FollowUp, InternalNote, Profile, StatusTransition,
} from '../lib/types';

interface DetailData {
  enquiry: Enquiry | null;
  client: Client | null;
  files: EnquiryFile[];
  notes: InternalNote[];
  followUps: FollowUp[];
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
        enquiry: null, client: null, files: [], notes: [], followUps: [],
        transitions: [], colleagues: [], emailThread: null, appointments: [], conversations: [],
      };
    }

    const [client, files, notes, followUps, transitions, colleagues, clientAppointments] = await Promise.all([
      api.getClient(enquiry.client_id),
      can(role, 'viewEnquiryFiles') ? api.listEnquiryFiles(enquiryId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ enquiryId }) : Promise.resolve([]),
      api.listFollowUps({ enquiryId }),
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
      enquiry, client, files, notes, followUps, transitions, colleagues, emailThread,
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

  // A workflow action reloads this same enquiry. Keep its existing DOM mounted
  // during that refresh so the browser keeps the operator's scroll position and
  // open disclosures. A genuinely different enquiry still gets a full loader.
  if (loading && data?.enquiry?.id !== enquiryId) return <LoadingState label={t('enquiry.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.enquiry) {
    return <EmptyState title={t('enquiry.notFound')} hint={t('enquiry.notFoundHint')} />;
  }

  const {
    enquiry, client, files, notes, followUps, transitions, colleagues,
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
  const conversation = conversations[0] ?? null;
  // With no thread yet, an empty Inbox would be a dead end; the reply options
  // below start the conversation on the client's own channel instead.
  const replyHref = conversation
    ? `/inbox/${conversation.id}`
    : emailThread ? `/inbox/email/${emailThread.key}` : null;

  const recommended: EnquiryNextAction = nextEnquiryAction({
    status: enquiry.status,
    intakeComplete: enquiry.intake_state === 'complete',
    hasUpcomingAppointment: nextAppointment !== null,
  });

  const whatsappCount = conversations.filter((row) => row.channel === 'whatsapp').length;
  const instagramConversations = conversations.filter((row) => row.channel === 'instagram');
  const canDelete = can(role, 'editEnquiry');
  const hasAdminActions = transitionOptions.length > 0 || canAssign || canConvert || canDelete;
  const phone = client?.phone ?? enquiry.submitted_phone ?? null;
  const email = client?.email ?? enquiry.submitted_email ?? null;
  const instagramHandle = (client?.instagram ?? enquiry.submitted_instagram ?? '').replace(/^@/, '').trim();
  const clientDisplayName = client?.full_name
    ?? enquiry.submitted_full_name
    ?? t('enquiry.clientUnavailable');
  const clientBriefLabel = language === 'ru' ? 'Описание клиента' : 'Client brief';

  return (
    <>
      <DetailHeader to="/enquiries" sectionLabel={t('nav.enquiries')} artistId={enquiry.artist_id} />

      {/* The person is the recognisable object. The enquiry number remains
          available underneath as a secondary technical identifier. */}
      <section className="card enquiry-summary">
        <div className="enquiry-summary-headline">
          <div style={{ minWidth: 0, flex: '1 1 180px' }}>
            <h2 className="enquiry-summary-reference" style={{ fontSize: '1.18rem' }}>
              {clientDisplayName}
            </h2>
            <div className="meta" style={{ marginTop: 2 }}>
              <span>{enquiry.reference_number}</span>
              {client ? (
                <>
                  {' · '}
                  <Link to={`/clients/${client.id}`}>{t('enquiry.openClient')}</Link>
                </>
              ) : null}
            </div>
          </div>
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
          {/* One tap to call, write or open the profile. */}
          <dt>{t('enquiry.phone')}</dt>
          <dd>{phone ? <a href={`tel:${phone.replace(/[^\d+]/g, '')}`}>{formatPhoneForDisplay(phone)}</a> : '—'}</dd>
          <dt>{t('enquiry.instagram')}</dt>
          <dd>
            {instagramHandle
              ? <a href={`https://instagram.com/${encodeURIComponent(instagramHandle)}`} target="_blank" rel="noreferrer">@{instagramHandle}</a>
              : '—'}
          </dd>
          <dt>{t('enquiry.email')}</dt>
          <dd>{email ? <a href={`mailto:${email}`}>{email}</a> : '—'}</dd>
          <dt>{t('enquiry.travellingFrom')}</dt>
          <dd>{client?.travelling_from ?? enquiry.submitted_travelling_from ?? '—'}</dd>
          <dt>{t('enquiry.prefers')}</dt>
          <dd>{localiseKnownValue(client?.preferred_contact ?? enquiry.submitted_preferred_contact ?? null, language)}</dd>
          <dt>{t('enquiry.type')}</dt>
          <dd>{enquiryHeadline(enquiry) ?? '—'}</dd>
          {enquiry.discovery_source || enquiry.discovery_source_detail ? (
            <>
              <dt>{t('enquiry.discoverySource')}</dt>
              <dd>
                {[
                  enquiry.discovery_source ? localiseKnownValue(enquiry.discovery_source, language) : null,
                  enquiry.discovery_source_detail,
                ].filter(Boolean).join(' · ')}
              </dd>
            </>
          ) : null}
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

      </section>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      {enquiry.client_identifier_conflict ? (
        <div className="notice warn" role="alert">{t('enquiry.identifierConflict')}</div>
      ) : null}

      {/* The contact rows above read the client card, falling back to the
          form. Where the form and the card disagree, this is the one place
          both values appear; there is no separate copy of the submission. */}
      {client ? (
        <EnquiryContactConflict enquiry={enquiry} client={client} api={api} onSaved={reload} />
      ) : null}

      <Section title={t('enquiry.nextAction')}>
        <p className="meta" style={{ margin: '0 0 10px' }}>
          {t('enquiry.nextActionIs', { action: t(`enquiry.next.${recommended}`) })}
        </p>
        {replyHref ? (
          <div className="actions" style={{ marginTop: 0 }}>
            <Link
              to={replyHref}
              className={recommended === 'reply' || recommended === 'chase' ? 'action-link primary' : 'action-link'}
            >
              {t('enquiry.replyToClient')}
            </Link>
          </div>
        ) : (
          <ReplyFallback
            language={language}
            primary={recommended === 'reply' || recommended === 'chase'}
            preferred={client?.preferred_contact ?? enquiry.submitted_preferred_contact ?? null}
            email={client?.email ?? enquiry.submitted_email ?? null}
            phone={client?.phone ?? null}
            instagram={client?.instagram ?? enquiry.submitted_instagram ?? null}
            hasWhatsAppPanel={Boolean(client)}
          />
        )}

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

        <EnquiryReplyEvidence enquiryId={enquiry.id} role={role} api={api} language={language} />

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
                      onClick={() => {
                        void (async () => {
                          if (!(await confirmEnquiryTransition(transition.to_status, language))) return;
                          await run(() => api.transitionEnquiry(enquiry.id, transition.to_status));
                        })();
                      }}
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
                        `${(enquiryHeadline(enquiry) ?? t('enquiry.defaultProjectTitle')).slice(0, 120)} — ${enquiry.submitted_full_name ?? client?.full_name ?? enquiry.reference_number}`
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

            <EnquiryArchiveAction enquiry={enquiry} role={role} api={api} language={language} />
          </details>
        ) : null}
      </Section>

      {/* The original submission appears once, here, under the structured
          tattoo facts from the form; a long one opens on request. */}
      <Section title={t('enquiry.project')}>
        {/* Booking form v2 answers replace the derived one-line summaries;
            legacy enquiries keep the original four facts. */}
        {isStructuredProjectDetails(enquiry.project_details) ? (
          <>
            <EnquiryProjectDetails details={enquiry.project_details} language={language} />
            <dl className="definition">
              <dt>{t('enquiry.timing')}</dt><dd>{enquiry.preferred_timing ?? '—'}</dd>
            </dl>
          </>
        ) : (
          <dl className="definition">
            <dt>{t('enquiry.placement')}</dt><dd>{enquiry.placement ?? '—'}</dd>
            <dt>{t('enquiry.size')}</dt><dd>{enquiry.approximate_size ?? '—'}</dd>
            <dt>{t('enquiry.coverUp')}</dt><dd>{localiseKnownValue(enquiry.cover_up, language)}</dd>
            <dt>{t('enquiry.timing')}</dt><dd>{enquiry.preferred_timing ?? '—'}</dd>
          </dl>
        )}
        <div style={{ marginTop: 12 }}>
          <div className="meta" style={{ fontWeight: 600 }}>{clientBriefLabel}</div>
          <ClientBrief text={enquiry.idea} language={language} />
          {enquiry.idea ? <EnquiryTranslation enquiryId={enquiry.id} api={api} language={language} /> : null}
        </div>
        {/* Booking form v2 enquiries are edited through their structure so the
            card, lists and GPT reads cannot disagree; legacy enquiries keep
            the free-text form. */}
        {isStructuredProjectDetails(enquiry.project_details) ? (
          <>
            <EnquiryStructuredEditPanel
              key={JSON.stringify(enquiry.project_details) + (enquiry.preferred_timing ?? '')}
              enquiry={enquiry}
              details={enquiry.project_details}
              role={role}
              api={api}
              language={language}
              onSaved={reload}
            />
            <EnquiryEditPanel enquiry={enquiry} role={role} api={api} language={language} onSaved={reload} mode="idea" />
          </>
        ) : (
          <EnquiryEditPanel enquiry={enquiry} role={role} api={api} language={language} onSaved={reload} />
        )}
      </Section>

      {can(role, 'viewEnquiryFiles') ? (
        <Section title={t('enquiry.referenceImages')}>
          {readyFiles.length === 0 ? (
            <EmptyState title={t('enquiry.noReferenceImages')} />
          ) : (
            // v2 intake images carry a role; legacy and staff uploads do not
            // and stay in one unlabelled group, exactly as before.
            imageGroups(readyFiles).map((group) => (
              <div key={group.key} data-testid={`enquiry-images-${group.key}`}>
                {group.titleKey ? (
                  <div className="meta" style={{ fontWeight: 600, margin: '8px 0 4px' }}>
                    {t(group.titleKey)} ({group.files.length})
                  </div>
                ) : null}
                <div className="thumbs">
                  {group.files.map((file) => (
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
              </div>
            ))
          )}
          {/* No standing notice about expiring links: a thumbnail that fails
              to load or open says so itself, with the same advice. */}
          <EnquiryReferenceActions enquiryId={enquiry.id} files={files} role={role} api={api} language={language} onChanged={reload} />
        </Section>
      ) : null}

      {/* Every channel in one place: one row each, pointing at where the
          conversation is worked. The Inbox owns the threads; WhatsApp setup
          belongs in Integrations. */}
      {emailThread || client || instagramConversations.length > 0 ? (
        <Section title={t('enquiry.conversations')}>
          <div className="enquiry-channels">
            {emailThread || client?.email ? (
              <div className="enquiry-channel">
                <div className="enquiry-channel-head">
                  <span className="enquiry-channel-name">{t('enquiry.email')}</span>
                  <Link to={`/inbox/email/${emailThread?.key ?? `client-${enquiry.client_id}`}`} className="badge">
                    {t('enquiry.openEmailConversation')}
                  </Link>
                </div>
                {emailThread ? <p className="meta" style={{ margin: '4px 0 0' }}>{emailThread.subject}</p> : null}
                {emailThread && threadNeedsOperator(emailThread) ? (
                  <span className="badge warn" style={{ marginTop: 6 }}>
                    {emailThread.state === 'send_failed'
                      ? t('enquiry.emailSendFailed')
                      : t('enquiry.emailDraftToApprove')}
                  </span>
                ) : null}
              </div>
            ) : null}

            {instagramConversations.map((row) => (
              <div key={row.id} className="enquiry-channel">
                <div className="enquiry-channel-head">
                  <span className="enquiry-channel-name">Instagram</span>
                  <Link to={`/inbox/${row.id}`} className="badge">{t('enquiry.openConversation')}</Link>
                </div>
              </div>
            ))}

            {client ? (
              <details id="enquiry-whatsapp" className="enquiry-channel disclosure">
                <summary>
                  <span className="enquiry-channel-name">WhatsApp</span>
                  <span className="collapsed-section-count">{whatsappCount}</span>
                </summary>
                <div style={{ marginTop: 10 }}>
                  <EnquiryWhatsAppPanel
                    api={api}
                    enquiryId={enquiry.id}
                    clientId={client.id}
                    artistId={enquiry.artist_id}
                    phone={client.phone}
                    role={role}
                    language={language}
                  />
                </div>
              </details>
            ) : null}
          </div>
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title={t('enquiry.activity')}>
          <ActivityFeed
            filter={{ enquiryId: enquiry.id }}
            emptyTitle={t('enquiry.noActivity')}
            initiallyCollapsed
          />
        </Section>
      ) : null}

      {/* Usually empty, so each is one line with a count at the very end. */}
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
    </>
  );
}

function ReplyFallback({
  language,
  primary,
  preferred,
  email,
  phone,
  instagram,
  hasWhatsAppPanel,
}: {
  language: 'en' | 'ru';
  primary: boolean;
  preferred: string | null;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  hasWhatsAppPanel: boolean;
}) {
  const ru = language === 'ru';
  const handle = instagram ? instagram.replace(/^@/, '').trim() : '';
  const options: { key: string; node: (className: string) => JSX.Element }[] = [];
  if (hasWhatsAppPanel && phone) {
    options.push({
      key: 'WhatsApp',
      node: (className) => (
        <a
          className={className}
          href="#enquiry-whatsapp"
          onClick={(event) => {
            event.preventDefault();
            const section = document.getElementById('enquiry-whatsapp') as HTMLDetailsElement | null;
            if (section) {
              section.open = true;
              section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }}
        >
          {ru ? 'Написать в WhatsApp' : 'Message on WhatsApp'}
        </a>
      ),
    });
  }
  if (email) {
    options.push({ key: 'Email', node: (className) => <a className={className} href={`mailto:${email}`}>{ru ? 'Написать на email' : 'Email the client'}</a> });
  }
  if (handle) {
    options.push({
      key: 'Instagram',
      node: (className) => <a className={className} href={`https://instagram.com/${encodeURIComponent(handle)}`} target="_blank" rel="noreferrer">{`Instagram @${handle}`}</a>,
    });
  }
  options.sort((left, right) => Number(right.key === preferred) - Number(left.key === preferred));
  return (
    <div className="reply-fallback">
      <p className="meta" style={{ margin: '0 0 8px' }}>
        {ru ? 'Переписки с клиентом пока нет. Начни её здесь:' : 'No conversation with this client yet. Start one here:'}
      </p>
      <div className="actions" style={{ marginTop: 0 }}>
        {options.length ? options.map((option, index) => (
          <span key={option.key}>{option.node(index === 0 && primary ? 'action-link primary' : 'action-link')}</span>
        )) : (
          <span className="meta">{ru ? 'У клиента нет контактов для ответа.' : 'The client has no contact details to reply to.'}</span>
        )}
      </div>
    </div>
  );
}

type ImageGroupKey = 'design' | 'existing' | 'other';

function imageGroups(files: EnquiryFile[]): Array<{
  key: ImageGroupKey;
  titleKey: 'enquiry.designReferences' | 'enquiry.existingTattooPhotos' | 'enquiry.otherImages' | null;
  files: EnquiryFile[];
}> {
  const design = files.filter((file) => file.intake_role === 'design_reference');
  const existing = files.filter((file) => file.intake_role === 'existing_tattoo');
  const other = files.filter((file) => !file.intake_role);
  if (design.length === 0 && existing.length === 0) return [{ key: 'other', titleKey: null, files: other }];
  return [
    { key: 'existing' as const, titleKey: 'enquiry.existingTattooPhotos' as const, files: existing },
    { key: 'design' as const, titleKey: 'enquiry.designReferences' as const, files: design },
    { key: 'other' as const, titleKey: 'enquiry.otherImages' as const, files: other },
  ].filter((group) => group.files.length > 0);
}
