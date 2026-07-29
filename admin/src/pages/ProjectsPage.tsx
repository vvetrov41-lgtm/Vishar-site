import { useApi } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { Link } from '../lib/router';
import { formatDateTime } from '../lib/format';
import type { Project } from '../lib/types';

export function ProjectsPage() {
  const api = useApi();
  const { data, loading, error, reload } = useAsync<Project[]>(() => api.listProjects(), [api]);

  if (loading) return <LoadingState label="Loading projects…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || data.length === 0) {
    return <EmptyState title="No projects yet" hint="Convert an accepted enquiry to create one." />;
  }

  return (
    <div className="list">
      {data.map((project) => (
        <Link key={project.id} to={`/projects/${project.id}`} className="row">
          <div className="title">{project.title}</div>
          <div className="meta">
            <span className="badge">{project.status}</span>{' '}
            <span className="badge">Deposit: {project.deposit_status.replace(/_/g, ' ')}</span>{' '}
            updated {formatDateTime(project.updated_at)}
          </div>
        </Link>
      ))}
    </div>
  );
}
