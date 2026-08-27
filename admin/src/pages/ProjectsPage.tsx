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

  const guide = language === 'ru'
    ? {
        title: 'Как создать проект',
        body: 'Проект создаётся из заявки, чтобы клиент, референсы и история переписки оставались связаны с одной работой.',
        steps: 'Открой «Заявки» → выбери нужную заявку → переведи её в статус «Принята» → нажми «Создать проект».',
        action: 'Перейти к заявкам',
      }
    : {
        title: 'How to create a project',
        body: 'A project is created from an enquiry so the client, references and enquiry history stay attached to the same job.',
        steps: 'Open Enquiries → choose the enquiry → move it to Accepted → press Create project.',
        action: 'Go to enquiries',
      };

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>{guide.title}</h2>
        <p style={{ marginBottom: 8 }}>{guide.body}</p>
        <p style={{ color: 'var(--muted)', fontSize: '0.88rem', marginTop: 0 }}>
          {guide.steps}
        </p>
        <div className="actions">
          <Link to="/enquiries" className="badge">{guide.action}</Link>
        </div>
      </div>

      {!data || data.length === 0 ? (
        <EmptyState title={t('projects.noProjects')} hint={t('projects.noProjectsHint')} />
      ) : (
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
      )}
    </>
  );
}
