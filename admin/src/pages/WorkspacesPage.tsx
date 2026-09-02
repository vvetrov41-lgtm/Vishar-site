// Organizations: the list, and founding a new one.
//
// A solo artist has exactly one of these and will rarely open this screen. A
// studio owner lives here. Both see the same thing, which is the point: there
// is no "studio mode" to switch into.
//
// "Управление" / "Manage" reads as an instruction, so it navigates. It used to
// be a decorative span that said you may administer this organization and then
// did nothing when tapped. The organization name goes to the same screen; the
// named action exists because a title is not an obvious control on a phone.
// "Команда" / "Team" stays a plain label: it names a right, not an action.

import { useState, type FormEvent } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { useControlPlaneAccess } from '../lib/control-plane-access';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import type { WorkspaceType } from '../lib/control-plane-api';
import './ControlPlane.css';

export function WorkspacesPage() {
  const api = useApi();
  const { access } = useControlPlaneAccess();
  const { language } = useLanguage();
  const ru = language === 'ru';

  const [name, setName] = useState('');
  const [type, setType] = useState<WorkspaceType>('studio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const state = useAsync(() => api.listWorkspaces(), [api]);

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const workspaces = state.data ?? [];
  // Founding is installation-level and has no existing workspace from which the
  // browser could derive a permission. Trust the server answer directly. This
  // is also what makes the zero-workspace bootstrap reachable.
  const canFound = access?.can_found_workspace === true;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError(ru ? 'Введите название.' : 'Enter a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createWorkspace({ displayName: name.trim(), workspaceType: type });
      setName('');
      setShowForm(false);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create that organization.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="notice" role="note">
        <strong style={{ display: 'block' }}>
          {ru ? 'Организации' : 'Organizations'}
        </strong>
        <span>
          {ru
            ? 'Организация владеет мастерами. Права в организации не дают доступа к работе мастера - для этого нужен отдельный доступ к самому мастеру.'
            : 'An organization owns artists. Rights here do not open an artist’s work: that always needs separate access to the artist itself.'}
        </span>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          title={ru ? 'Организаций нет' : 'No organizations'}
          hint={canFound
            ? (ru
              ? 'Создайте первую организацию ниже.'
              : 'Create the first organization below.')
            : (ru
              ? 'Вас пока не добавили ни в одну организацию.'
              : 'You have not been added to an organization yet.')}
        />
      ) : (
        <div className="ws-list">
          {workspaces.map((workspace) => (
            <article key={workspace.id} className="card ws-card">
              <div className="ws-card-main">
                <Link to={`/workspaces/${workspace.id}`} className="ws-card-title">
                  {workspace.display_name}
                </Link>
                <div className="meta">
                  {workspace.workspace_type === 'solo'
                    ? (ru ? 'Соло' : 'Solo')
                    : (ru ? 'Студия' : 'Studio')}
                  {' · '}
                  {ru ? 'мастеров: ' : 'artists: '}{workspace.artist_count}
                  {' · '}{workspace.timezone}
                  {' · '}{workspace.default_currency}
                </div>
              </div>
              <div className="ws-card-badges">
                {workspace.is_active
                  ? null
                  : <span className="badge danger">{ru ? 'Отключена' : 'Deactivated'}</span>}
                {workspace.can_manage_workspace
                  ? (
                    <Link to={`/workspaces/${workspace.id}`} className="badge">
                      {ru ? 'Управление' : 'Manage'}
                    </Link>
                  )
                  : null}
                {workspace.can_manage_team
                  ? <span className="badge">{ru ? 'Команда' : 'Team'}</span>
                  : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {canFound ? (
        <section className="card">
          {!showForm ? (
            <button type="button" onClick={() => setShowForm(true)}>
              {ru ? 'Создать организацию' : 'New organization'}
            </button>
          ) : (
            <form className="stack" onSubmit={(event) => { void create(event); }}>
              <h2>{ru ? 'Новая организация' : 'New organization'}</h2>
              {error ? <div className="notice warn" role="alert">{error}</div> : null}
              <label>
                {ru ? 'Название' : 'Name'}
                <input
                  type="text"
                  required
                  maxLength={120}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                {ru ? 'Тип' : 'Type'}
                <select value={type} onChange={(event) => setType(event.target.value as WorkspaceType)}>
                  <option value="studio">{ru ? 'Студия - несколько мастеров' : 'Studio - several artists'}</option>
                  <option value="solo">{ru ? 'Соло - один мастер' : 'Solo - one artist'}</option>
                </select>
              </label>
              <p className="meta">
                {ru
                  ? 'Соло-организация вмещает ровно одного мастера. Для второго нужна студия.'
                  : 'A solo organization holds exactly one artist. A second one needs a studio.'}
              </p>
              <div className="actions">
                <button type="submit" disabled={busy}>
                  {busy ? (ru ? 'Создаём…' : 'Creating…') : (ru ? 'Создать' : 'Create')}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setError(null); }}>
                  {ru ? 'Отмена' : 'Cancel'}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
