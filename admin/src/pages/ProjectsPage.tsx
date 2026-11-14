import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link, useQueryState } from '../lib/router';
import { formatDateTime } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type { Project } from '../lib/types';
import { useArtistScope } from '../lib/artist-scope';

export function ProjectsPage() {
  const api = useApi();
  const { t, label, language } = useLanguage();
  const { selectedArtistId } = useArtistScope();
  const [search, setSearch] = useQueryState('q');
  const { data, loading, error, reload } = useAsync<{
    projects: Project[];
    clientNames: Map<string, string>;
  }>(async () => {
    const projects = await api.listProjects(undefined, selectedArtistId ?? undefined);
    const clients = await api.listClientsByIds(projects.map((project) => project.client_id));
    return {
      projects,
      clientNames: new Map(clients.map((entry) => [entry.id, entry.full_name])),
    };
  }, [api, selectedArtistId]);

  if (loading && !data) return <LoadingState label={t('projects.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  // Projects are already fetched with a bounded list. Filter the loaded rows
  // locally so typing does not trigger extra Supabase requests.
  const term = search.trim().toLocaleLowerCase();
  const matchingProjects = (data?.projects ?? []).filter((project) =>
    !term || [project.title, project.description, data?.clientNames.get(project.client_id)]
      .some((value) => value?.toLocaleLowerCase().includes(term))
  );
  const searchField = (
    <div className="card">
      <label htmlFor="project-search">
        {language === 'ru' ? 'Поиск проектов' : 'Search projects'}
      </label>
      <input
        id="project-search"
        type="search"
        inputMode="search"
        placeholder={language === 'ru' ? 'Имя клиента или название проекта' : 'Client name or project title'}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
    </div>
  );

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

  if (!data || data.projects.length === 0) {
    return (
      <>
        {searchField}
        {creationGuide}
        <EmptyState title={t('projects.noProjects')} hint={t('projects.noProjectsHint')} />
      </>
    );
  }

  return (
    <>
      {searchField}
      {matchingProjects.length === 0 ? (
        <EmptyState
          title={language === 'ru' ? 'Проекты не найдены' : 'No matching projects'}
          hint={language === 'ru' ? 'Попробуй другое имя или название.' : 'Try another client name or project title.'}
        />
      ) : null}
      <div className="list">
        {matchingProjects.map((project) => (
          <Link key={project.id} to={`/projects/${project.id}`} className="row">
            <div className="title">
              {data.clientNames.get(project.client_id) ?? project.title}
            </div>
            <div className="meta">
              <span className="badge">{label('projectStatus', project.status)}</span>{' '}
              <span className="badge">
                {t('common.deposit')}: {label('depositStatus', project.deposit_status)}
              </span>{' '}
              {t('common.updated', { date: formatDateTime(project.updated_at, language) })}
            </div>
            <div className="meta">{project.title}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
