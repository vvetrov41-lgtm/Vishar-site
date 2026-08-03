import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { DetailBackLink } from '../components/DetailContext';
import { Link } from '../lib/router';
import { can } from '../lib/permissions';
import { formatDate, formatDateTime, localiseKnownValue } from '../lib/format';
import { useLanguage } from '../lib/i18n';
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
  const { t, label, language } = useLanguage();
  const role = profile?.role;

  const { data, loading, error, reload } = useAsync<ClientData>(async () => {
    const client = await api.getClient(clientId);
    if (!client) return { client: null, enquiries: [], projects: [], notes: [] };

    const [enquiries, projects, notes] = await Promise.all([
      api.listEnquiries({ clientId }),
      api.listProjects(clientId),
      can(role, 'viewNotes') ? api.listNotes({ clientId }) : Promise.resolve([]),
    ]);

    return {
      client,
      enquiries,
      projects,
      notes,
    };
  }, [api, clientId, role]);

  if (loading) return <LoadingState label={t('client.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data?.client) return <EmptyState title={t('client.notFound')} />;

  const { client, enquiries, projects, notes } = data;

  return (
    <>
      <DetailBackLink to="/clients" sectionLabel={t('nav.clients')} />

      <div className="card">
        <h2 style={{ fontSize: '1.2rem' }}>{client.full_name}</h2>
        <dl className="definition">
          <dt>{t('enquiry.email')}</dt><dd>{client.email ?? '—'}</dd>
          <dt>{t('enquiry.phone')}</dt><dd>{client.phone ?? '—'}</dd>
          <dt>{t('enquiry.instagram')}</dt><dd>{client.instagram ?? '—'}</dd>
          <dt>{t('enquiry.prefers')}</dt><dd>{localiseKnownValue(client.preferred_contact, language)}</dd>
          <dt>{t('enquiry.travellingFrom')}</dt><dd>{client.travelling_from ?? '—'}</dd>
          <dt>{t('client.firstSeen')}</dt><dd>{formatDate(client.created_at, language)}</dd>
        </dl>
        <p className="notice" style={{ marginTop: 12 }}>{t('client.mergeNotice')}</p>
      </div>

      <Section title={t('client.enquiries')}>
        {enquiries.length === 0 ? (
          <EmptyState title={t('client.noEnquiries')} />
        ) : (
          <div className="list">
            {enquiries.map((enquiry) => (
              <Link key={enquiry.id} to={`/enquiries/${enquiry.id}`} className="row">
                <div className="title">{enquiry.reference_number}</div>
                <div className="meta">
                  <span className="badge">{label('enquiryStatus', enquiry.status)}</span>{' '}
                  {formatDateTime(enquiry.created_at, language)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('client.projects')}>
        {projects.length === 0 ? (
          <EmptyState title={t('client.noProjects')} hint={t('client.noProjectsHint')} />
        ) : (
          <div className="list">
            {projects.map((project) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="row">
                <div className="title">{project.title}</div>
                <div className="meta">
                  <span className="badge">{label('projectStatus', project.status)}</span>{' '}
                  <span className="badge">
                    {t('common.deposit')}: {label('depositStatus', project.deposit_status)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {can(role, 'viewNotes') ? (
        <Section title={t('client.notes')}>
          {notes.length === 0 ? <EmptyState title={t('client.noNotes')} /> : (
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
    </>
  );
}
