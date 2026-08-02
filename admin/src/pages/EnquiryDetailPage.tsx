import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { SignedImage } from '../components/SignedImage';
import { Link, useRouter } from '../lib/router';
import { availableTransitions, can } from '../lib/permissions';
import { formatDateTime, relativeDue } from '../lib/format';
import { useLanguage } from '../lib/i18n';
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
}

function contactValue(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase('en-GB');
}

function submittedContactDiffers(enquiry: Enquiry, client: Client | null) {
  if (!client || !enquiry.submitted_email) return false;
  return [
    [enquiry.submitted_full_name, client.full_name],
    [enquiry.submitted_email, client.email],
    [enquiry.submitted_phone, client.phone],
    [enquiry.submitted_instagram, client.instagram],
    [enquiry.submitted_preferred_contact, client.preferred_contact],
    [enquiry.submitted_travelling_from, client.travelling_from],
  ].some(([submitted, current]) => contactValue(submitted) !== contactValue(current));
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
      return { enquiry: null, client: null, files: [], notes: [], followUps: [], activity: [], transitions: [], colleagues: [] };
    }

    const [client, files, notes, followUps, activity, transitions, colleagues] = await Promise.all([
      api.getClient(enquiry.client_id),
      can(role, 'viewEnquiryFiles') ? api.listEnquiryFiles(enquiryId) : Promise.resolve([]),
      can(role, 'viewNotes') ? api.listNotes({ enquiryId }) : Promise.resolve([]),
      api.listFollowUps({ enquiryId }),
      can(role, 'viewActivity') ? api.listActivity({ enquiryId }) : Promise.resolve([]),
      can(role, 'transitionEnquiry') ? api.listStatusTransitions() : Promise.resolve([]),
      can(role, 'assignEnquiry') ? api.listAssignableProfiles() : Promise.resolve([]),
    ]);

    return { enquiry, client, files, notes, followUps, activity, transitions, colleagues };
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

  const { enquiry, client, files, notes, followUps, activity, transitions, colleagues } = data;
  const transitionOptions = availableTransitions(transitions, enquiry.status, role);
  const contactDiffers = submittedContactDiffers(enquiry, client);

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{enquiry.reference_number}</h2>
        <div>
          <span className="badge">{label('enquiryStatus', enquiry.status)}</span>{' '}
          {enquiry.intake_state !== 'complete' ? (
            <span className="badge warn">
              {t('common.intake', { state: label('intakeState', enquiry.intake_state) })}
            </span>
          ) : null}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 0 }}>
          {t('enquiry.receivedLastAction', {
            received: formatDateTime(enquiry.created_at, language),
            lastAction: formatDateTime(enquiry.last_action_at, language),
          })}
        </p>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      {enquiry.client_identifier_conflict ? (
        <div className="notice warn" role="alert">{t('enquiry.identifierConflict')}</div>
      ) : contactDiffers ? (
        <div className="notice warn" role="status">{t('enquiry.contactDiffers')}</div>
      ) : null}

      <Section title={t('enquiry.contactSubmitted')}>
        <dl className="definition">
          <dt>{t('enquiry.name')}</dt><dd>{enquiry.submitted_full_name ?? client?.full_name ?? '—'}</dd>
          <dt>{t('enquiry.email')}</dt><dd>{enquiry.submitted_email ?? client?.email ?? '—'}</dd>
          <dt>{t('enquiry.phone')}</dt><dd>{enquiry.submitted_phone ?? '—'}</dd>
          <dt>{t('enquiry.instagram')}</dt><dd>{enquiry.submitted_instagram ?? '—'}</dd>
          <dt>{t('enquiry.prefers')}</dt><dd>{enquiry.submitted_preferred_contact ?? '—'}</dd>
          <dt>{t('enquiry.travellingFrom')}</dt><dd>{enquiry.submitted_travelling_from ?? '—'}</dd>
        </dl>
        {client ? (
          <div className="actions">
            <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openCurrentClient')}</Link>
          </div>
        ) : null}
      </Section>

      {client && contactDiffers ? (
        <Section title={t('enquiry.currentClient')}>
          <dl className="definition">
            <dt>{t('enquiry.name')}</dt><dd>{client.full_name}</dd>
            <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
            <dt>{t('enquiry.phone')}</dt><dd>{client.phone ?? '—'}</dd>
            <dt>{t('enquiry.instagram')}</dt><dd>{client.instagram ?? '—'}</dd>
            <dt>{t('enquiry.prefers')}</dt><dd>{client.preferred_contact ?? '—'}</dd>
            <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
          </dl>
          <div className="actions">
            <Link to={`/clients/${client.id}`} className="badge">{t('enquiry.openClient')}</Link>
          </div>
        </Section>
      ) : null}

      <Section title={t('enquiry.project')}>
        <dl className="definition">
          <dt>{t('enquiry.type')}</dt><dd>{enquiry.project_type ?? '—'}</dd>
          <dt>{t('enquiry.placement')}</dt><dd>{enquiry.placement ?? '—'}</dd>
          <dt>{t('enquiry.size')}</dt><dd>{enquiry.approximate_size ?? '—'}</dd>
          <dt>{t('enquiry.coverUp')}</dt><dd>{enquiry.cover_up ?? '—'}</dd>
          <dt>{t('enquiry.timing')}</dt><dd>{enquiry.preferred_timing ?? '—'}</dd>
        </dl>
        <p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{enquiry.idea ?? '—'}</p>
      </Section>

      {can(role, 'viewEnquiryFiles') ? (
        <Section title={t('enquiry.referenceImages')}>
          {files.length === 0 ? (
            <EmptyState title={t('enquiry.noReferenceImages')} />
          ) : (
            <div className="thumbs">
              {files.map((file) => <SignedImage key={file.id} file={file} />)}
            </div>
          )}
          <p className="notice" style={{ marginTop: 12 }}>{t('enquiry.imageNotice')}</p>
        </Section>
      ) : null}

      {transitionOptions.length > 0 ? (
        <Section title={t('enquiry.moveOn')}>
          <div className="actions">
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
        </Section>
      ) : null}

      {can(role, 'assignEnquiry') ? (
        <Section title={t('enquiry.assignedTo')}>
          <label htmlFor="assignee" className="visually-hidden">{t('enquiry.assignee')}</label>
          <select
            id="assignee"
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
                {colleague.display_name ?? colleague.id}
              </option>
            ))}
          </select>
        </Section>
      ) : null}

      {can(role, 'convertEnquiry') && ['accepted', 'deposit_paid'].includes(enquiry.status) ? (
        <Section title={t('enquiry.convertTitle')}>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 0 }}>
            {t('enquiry.convertHint')}
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
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
        </Section>
      ) : null}

      {can(role, 'viewFollowUps') ? (
        <Section title={t('enquiry.followUps')}>
          {followUps.length === 0 ? (
            <EmptyState title={t('enquiry.noFollowUps')} />
          ) : (
            <div className="list">
              {followUps.map((followUp) => {
                const due = relativeDue(followUp.due_at, new Date(), language);
                return (
                  <div key={followUp.id} className="row">
                    <div className="title">{followUp.subject}</div>
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
        </Section>
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title={t('enquiry.internalNotes')}>
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
            <EmptyState title={t('enquiry.noNotes')} />
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
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title={t('enquiry.activity')}>
          {activity.length === 0 ? (
            <EmptyState title={t('enquiry.noActivity')} />
          ) : (
            <ul className="timeline">
              {activity.map((entry) => (
                <li key={entry.id}>
                  <div>{label('event', entry.event_type)}</div>
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
