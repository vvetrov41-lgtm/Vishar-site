import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { Link } from '../lib/router';
import { can, ENQUIRY_STATUS_LABELS } from '../lib/permissions';
import { formatDate, formatDateTime } from '../lib/format';
import type { Client, Enquiry, InternalNote, Project } from '../lib/types';

interface ClientData {
  client: Client | null;
  enquiries: Enquiry[];
  projects: Project[];
  notes: InternalNote[];
}

export function ClientDetailPage({ clientId }: { clientId: string }) {
  const api = useApi();
  const { profile } = useSession();
  const role = profile?.role;

  const { data, loading, error, reload } = useAsync<ClientData>(async () => {
    const client = await api.getClient(clientId);
    if (!client) return { client: null, enquiries: [], projects: [], notes: [] };

    const [enquiries, projects, notes] = await Promise.all([
      api.listEnquiries(),
      api.listProjects(clientId),
      can(role, 'viewNotes') ? api.listNotes({ clientId }) : Promise.resolve([]),
    ]);

    return {
      client,
      enquiries: enquiries.filter((enquiry) => enquiry.client_id === clientId),
      projects,
      notes,
    };
  }, [api, clientId, role]);

  if (loading) return <LoadingState label="Loading client…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.client) return <EmptyState title="Client not found" />;

  const { client, enquiries, projects, notes } = data;

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{client.full_name}</h2>
        <dl className="definition">
          <dt>Email</dt><dd>{client.email ?? '—'}</dd>
          <dt>Phone</dt><dd>{client.phone ?? '—'}</dd>
          <dt>Instagram</dt><dd>{client.instagram ?? '—'}</dd>
          <dt>Prefers</dt><dd>{client.preferred_contact ?? '—'}</dd>
          <dt>Travelling from</dt><dd>{client.travelling_from ?? '—'}</dd>
          <dt>First seen</dt><dd>{formatDate(client.created_at)}</dd>
        </dl>
        <p className="notice" style={{ marginTop: 12 }}>
          Client records are never merged automatically. If two records look like the
          same person, the owner reviews it — a wrong merge cannot be undone.
        </p>
      </div>

      <Section title="Enquiries">
        {enquiries.length === 0 ? (
          <EmptyState title="No enquiries for this client" />
        ) : (
          <div className="list">
            {enquiries.map((enquiry) => (
              <Link key={enquiry.id} to={`/enquiries/${enquiry.id}`} className="row">
                <div className="title">{enquiry.reference_number}</div>
                <div className="meta">
                  <span className="badge">{ENQUIRY_STATUS_LABELS[enquiry.status]}</span>{' '}
                  {formatDateTime(enquiry.created_at)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Projects">
        {projects.length === 0 ? (
          <EmptyState title="No projects yet" hint="A project is created by converting an enquiry." />
        ) : (
          <div className="list">
            {projects.map((project) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="row">
                <div className="title">{project.title}</div>
                <div className="meta">
                  <span className="badge">{project.status}</span>{' '}
                  <span className="badge">Deposit: {project.deposit_status.replace(/_/g, ' ')}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {can(role, 'viewNotes') ? (
        <Section title="Notes">
          {notes.length === 0 ? <EmptyState title="No notes" /> : (
            <ul className="timeline">
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
    </>
  );
}
