import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { Project } from '../lib/types';

export function ProjectsPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const { data, loading, error, reload } = useAsync<Project[]>(() => api.listProjects(), [api]);

  if (loading) return <LoadingState label={t('projects.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) {
    return <EmptyState title={t('projects.noProjects')} hint={t('projects.noProjectsHint')} />;
  }

  return (
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
  );
}
