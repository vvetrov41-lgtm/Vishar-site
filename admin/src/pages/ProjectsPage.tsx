import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { Project } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';

export function ProjectsPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const { selectedArtistId } = useArtistScope();
  const { data, loading, error, reload } = useAsync<Project[]>(
    () => api.listProjects(undefined, selectedArtistId ?? undefined),
    [api, selectedArtistId]
  );

  if (loading) return <LoadingState label={t('projects.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const creationGuide = (
    <div className="card" style={{ marginBottom: 14 }}>
      <strong style={{ display: 'block', marginBottom: 6 }}>
        {language === 'ru' ? 'Как создать проект' : 'How to create a project'}
      </strong>
      <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: '0.9rem' }}>
        {language === 'ru'
          ? 'Откройте заявку клиента, переведите её в статус «Принята», затем нажмите «Создать проект». Клиент и данные заявки перенесутся автоматически.'
          : 'Open the client enquiry, move it to Accepted, then choose Create project. The client and enquiry data carry over automatically.'}
      </p>
      <Link to="/enquiries" className="badge" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', paddingInline: 14 }}>
        {language === 'ru' ? 'Перейти к заявкам' : 'Open enquiries'}
      </Link>
    </div>
  );

  if (!data || data.length === 0) {
    return (
      <>
        {creationGuide}
        <EmptyState title={t('projects.noProjects')} hint={t('projects.noProjectsHint')} />
      </>
    );
  }

  return (
    <>
      {creationGuide}
      <div className="list">
        {data.map((project) => (
          <Link key={project.id} to={`/projects/${project.id}`} className="row">
            <div className="title">{project.title}</div>
            <div className="meta">
              <span className="badge">{label('projectStatus', project.status)}</span>{' '}
              <span className="badge">
                {t('common.deposit')}: {label('depositStatus', project.deposit_status)}
              </span>{' '}
              {t('common.updated', { date: formatDateTime(project.updated_at, language) })}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
