import { useState } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { SignedImage } from '../components/SignedImage';
import { Link, useRouter } from '../lib/router';
import { availableTransitions, can, ENQUIRY_STATUS_LABELS } from '../lib/permissions';
import { formatDateTime, relativeDue } from '../lib/format';
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

export function EnquiryDetailPage({ enquiryId }: { enquiryId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const { navigate } = useRouter();
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
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading enquiry…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.enquiry) {
    return <EmptyState title="Enquiry not found" hint="It may have been archived, or your role may not be able to see it." />;
  }

  const { enquiry, client, files, notes, followUps, activity, transitions, colleagues } = data;
  const transitionOptions = availableTransitions(transitions, enquiry.status, role);

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{enquiry.reference_number}</h2>
        <div>
          <span className="badge">{ENQUIRY_STATUS_LABELS[enquiry.status]}</span>{' '}
          {enquiry.intake_state !== 'complete' ? (
            <span className="badge warn">Intake {enquiry.intake_state}</span>
          ) : null}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 0 }}>
          Received {formatDateTime(enquiry.created_at)} · last action {formatDateTime(enquiry.last_action_at)}
        </p>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      <Section title="Client">
        {client ? (
          <>
            <dl className="definition">
              <dt>Name</dt><dd>{client.full_name}</dd>
              <dt>Email</dt><dd>{client.email ?? '—'}</dd>
              <dt>Phone</dt><dd>{client.phone ?? '—'}</dd>
              <dt>Instagram</dt><dd>{client.instagram ?? '—'}</dd>
              <dt>Prefers</dt><dd>{client.preferred_contact ?? '—'}</dd>
              <dt>Travelling from</dt><dd>{client.travelling_from ?? '—'}</dd>
            </dl>
            <div className="actions">
              <Link to={`/clients/${client.id}`} className="badge">Open client</Link>
            </div>
          </>
        ) : (
          <EmptyState title="Client record unavailable" />
        )}
      </Section>

      <Section title="The project">
        <dl className="definition">
          <dt>Type</dt><dd>{enquiry.project_type ?? '—'}</dd>
          <dt>Placement</dt><dd>{enquiry.placement ?? '—'}</dd>
          <dt>Size</dt><dd>{enquiry.approximate_size ?? '—'}</dd>
          <dt>Cover-up</dt><dd>{enquiry.cover_up ?? '—'}</dd>
          <dt>Timing</dt><dd>{enquiry.preferred_timing ?? '—'}</dd>
        </dl>
        <p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{enquiry.idea ?? '—'}</p>
      </Section>

      {can(role, 'viewEnquiryFiles') ? (
        <Section title="Reference images">
          {files.length === 0 ? (
            <EmptyState title="No reference images" />
          ) : (
            <div className="thumbs">
              {files.map((file) => <SignedImage key={file.id} file={file} />)}
            </div>
          )}
          <p className="notice" style={{ marginTop: 12 }}>
            Images open through links that expire within a minute. Reload the page if one stops loading.
          </p>
        </Section>
      ) : null}

      {transitionOptions.length > 0 ? (
        <Section title="Move this enquiry on">
          <div className="actions">
            {transitionOptions.map((transition) => (
              <button
                key={transition.to_status}
                type="button"
                disabled={busy}
                onClick={() => { void run(() => api.transitionEnquiry(enquiry.id, transition.to_status)); }}
              >
                {ENQUIRY_STATUS_LABELS[transition.to_status]}
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {can(role, 'assignEnquiry') ? (
        <Section title="Assigned to">
          <label htmlFor="assignee" className="visually-hidden">Assignee</label>
          <select
            id="assignee"
            value={enquiry.assigned_to ?? ''}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value || null;
              void run(() => api.assignEnquiry(enquiry.id, value));
            }}
          >
            <option value="">Unassigned</option>
            {colleagues.map((colleague) => (
              <option key={colleague.id} value={colleague.id}>
                {colleague.display_name ?? colleague.id}
              </option>
            ))}
          </select>
        </Section>
      ) : null}

      {can(role, 'convertEnquiry') && enquiry.status !== 'converted' ? (
        <Section title="Convert to a project">
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 0 }}>
            One enquiry becomes at most one project. This cannot be undone.
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
                    `${enquiry.project_type ?? 'Tattoo'} — ${client?.full_name ?? enquiry.reference_number}`
                  );
                  const projectId = (result as { project_id?: string })?.project_id;
                  if (projectId) navigate(`/projects/${projectId}`);
                });
              }}
            >
              Convert to project
            </button>
          </div>
        </Section>
      ) : null}

      {can(role, 'viewFollowUps') ? (
        <Section title="Follow-ups">
          {followUps.length === 0 ? (
            <EmptyState title="No follow-ups" />
          ) : (
            <div className="list">
              {followUps.map((followUp) => {
                const due = relativeDue(followUp.due_at);
                return (
                  <div key={followUp.id} className="row">
                    <div className="title">{followUp.subject}</div>
                    <div className="meta">
                      <span className={due.overdue ? 'badge danger' : 'badge'}>{due.label}</span>{' '}
                      <span className="badge">{followUp.status}</span>
                      {can(role, 'manageFollowUps') && followUp.status === 'open' ? (
                        <div className="actions">
                          <button
                            type="button" disabled={busy}
                            onClick={() => { void run(() => api.completeFollowUp(followUp.id)); }}
                          >
                            Mark done
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
                  void run(() => api.createFollowUp('Chase this enquiry', dueAt, { enquiryId: enquiry.id }));
                }}
              >
                Add a 3-day follow-up
              </button>
            </div>
          ) : null}
        </Section>
      ) : null}

      {can(role, 'viewNotes') ? (
        <Section title="Internal notes">
          {can(role, 'createNotes') ? (
            <>
              <label htmlFor="note-body">Add a note</label>
              <textarea
                id="note-body" value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
                placeholder="Only staff see this."
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
                  Save note
                </button>
              </div>
            </>
          ) : null}

          {notes.length === 0 ? (
            <EmptyState title="No notes yet" />
          ) : (
            <ul className="timeline" style={{ marginTop: 12 }}>
              {notes.map((note) => (
                <li key={note.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                  <div className="when">{formatDateTime(note.created_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {can(role, 'viewActivity') ? (
        <Section title="Activity">
          {activity.length === 0 ? (
            <EmptyState title="No activity recorded" />
          ) : (
            <ul className="timeline">
              {activity.map((entry) => (
                <li key={entry.id}>
                  <div>{entry.event_type}</div>
                  <div className="when">{formatDateTime(entry.occurred_at)} · {entry.actor_kind}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}
