// One organization: its settings, its artists, and its people.
//
// This is the screen that replaces "ask an engineer to add a migration". Add
// artist lives here, and so does the roster that tells an owner, honestly,
// which of their own artists they cannot open — because administering an
// organization has never included reading an artist's work.

import { useMemo, useState, type FormEvent } from 'react';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { useApi } from '../lib/session';
import type {
  DirectoryProfile,
  WorkspaceArtist,
  WorkspaceRole,
  WorkspaceTeamMember,
} from '../lib/control-plane-api';
import type { Workspace } from '../lib/platform-api';
import './ControlPlane.css';

interface WorkspaceDetailData {
  workspace: Workspace | null;
  artists: WorkspaceArtist[];
  team: WorkspaceTeamMember[] | null;
  directory: DirectoryProfile[];
}

export function WorkspaceDetailPage({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const { language } = useLanguage();
  const { navigate } = useRouter();
  const ru = language === 'ru';

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useAsync<WorkspaceDetailData>(async () => {
    const workspaces = await api.listWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
    if (!workspace) return { workspace: null, artists: [], team: null, directory: [] };

    const artists = await api.listWorkspaceArtists(workspaceId);

    // The staff list needs team management. Somebody who only belongs here
    // sees the roster and no directory, which is the rule, not a failure —
    // so a refusal becomes an absent section rather than an error screen.
    let team: WorkspaceTeamMember[] | null = null;
    if (workspace.can_manage_team) {
      try {
        team = await api.listWorkspaceTeam(workspaceId);
      } catch {
        team = null;
      }
    }

    // The scoped directory, not public.list_profiles(). That one requires the
    // legacy installation-wide owner role, so it returned nothing — and
    // therefore an empty "add a person" dropdown — for exactly the studio
    // administrator this screen exists to serve.
    let directory: DirectoryProfile[] = [];
    if (workspace.can_manage_team) {
      try {
        directory = await api.listDirectoryProfiles();
      } catch {
        directory = [];
      }
    }

    return { workspace, artists, team, directory };
  }, [api, workspaceId]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const workspace = state.data?.workspace ?? null;
  if (!workspace) {
    return (
      <EmptyState
        title={ru ? 'Организация недоступна' : 'Organization unavailable'}
        hint={ru
          ? 'Возможно, у вас нет к ней доступа.'
          : 'You may not have access to it.'}
      />
    );
  }

  const artists = state.data?.artists ?? [];
  const team = state.data?.team ?? null;
  const directory = state.data?.directory ?? [];
  const soloFull = workspace.workspace_type === 'solo' && artists.length >= 1;

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/workspaces" className="linklike">← {ru ? 'Организации' : 'Organizations'}</Link>
        <h1>{workspace.display_name}</h1>
        <div className="meta">
          {workspace.workspace_type === 'solo' ? (ru ? 'Соло' : 'Solo') : (ru ? 'Студия' : 'Studio')}
          {' · '}{workspace.timezone}{' · '}{workspace.default_currency}
          {workspace.is_active ? null : (
            <> {' · '}<span className="badge danger">{ru ? 'Отключена' : 'Deactivated'}</span></>
          )}
        </div>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}

      <Section title={ru ? 'Мастера' : 'Artists'}>
        {artists.length === 0 ? (
          <EmptyState
            compact
            title={ru ? 'Пока никого' : 'Nobody yet'}
            hint={ru ? 'Добавьте первого мастера ниже.' : 'Add the first artist below.'}
          />
        ) : (
          <div className="artist-roster">
            {artists.map((artist) => (
              <ArtistRow key={artist.id} artist={artist} ru={ru} />
            ))}
          </div>
        )}

        {workspace.can_manage_workspace ? (
          soloFull ? (
            <p className="meta">
              {ru
                ? 'Соло-организация вмещает одного мастера. Для второго создайте студию.'
                : 'A solo organization holds one artist. Create a studio for a second.'}
            </p>
          ) : (
            <AddArtistForm
              busy={busy}
              ru={ru}
              onAdd={async (displayName) => {
                let created: string | null = null;
                await run(async () => {
                  created = await api.createArtist({ workspaceId, displayName });
                });
                if (created) navigate(`/artists/${created}`);
              }}
            />
          )
        ) : null}
      </Section>

      {team ? (
        <Section title={ru ? 'Люди' : 'People'}>
          <p className="meta">
            {ru
              ? 'Доступ здесь — на уровне организации. Доступ к конкретному мастеру выдаётся на странице мастера.'
              : 'Access here is organization-level. Access to a particular artist is granted on that artist’s page.'}
          </p>
          <div className="team-rows">
            {team.map((member) => (
              <TeamRow
                key={member.profile_id}
                member={member}
                ru={ru}
                busy={busy}
                canManageIntegrations={workspace.can_manage_integrations}
                canManageWorkspace={workspace.can_manage_workspace}
                onSave={(next) => run(
                  () => api.upsertWorkspaceMembership({ ...next, workspaceId }),
                  ru ? 'Сохранено.' : 'Saved.',
                )}
              />
            ))}
          </div>

          <AddPersonForm
            ru={ru}
            busy={busy}
            profiles={directory.filter(
              (profile) => !team.some((member) => member.profile_id === profile.id),
            )}
            onAdd={(profileId) => run(
              () => api.upsertWorkspaceMembership({
                profileId,
                workspaceId,
                workspaceRole: 'booking_manager',
                canManageWorkspace: false,
                canManageTeam: false,
                canManageIntegrations: false,
                isActive: true,
              }),
              ru ? 'Человек добавлен в организацию.' : 'Added to the organization.',
            )}
          />
        </Section>
      ) : null}

      {workspace.can_manage_workspace ? (
        <WorkspaceSettings
          workspace={workspace}
          ru={ru}
          busy={busy}
          hasActiveArtists={artists.some((artist) => artist.is_active)}
          onSave={(patch) => run(
            () => api.updateWorkspace({ workspaceId, ...patch }),
            ru ? 'Сохранено.' : 'Saved.',
          )}
        />
      ) : null}
    </div>
  );
}

function ArtistRow({ artist, ru }: { artist: WorkspaceArtist; ru: boolean }) {
  return (
    <article className="card artist-row">
      <div className="artist-row-main">
        <Link to={`/artists/${artist.id}`} className="artist-row-title">
          {artist.display_name}
        </Link>
        <div className="meta">
          {ru ? 'команда: ' : 'team: '}{artist.member_count}
          {' · '}{ru ? 'форм: ' : 'forms: '}{artist.active_booking_sources}
          {' · '}{ru ? 'интеграций: ' : 'integrations: '}{artist.enabled_integrations}
        </div>
      </div>
      <div className="artist-row-badges">
        {artist.is_active
          ? null
          : <span className="badge danger">{ru ? 'Отключён' : 'Deactivated'}</span>}
        {artist.member_count === 0
          ? <span className="badge warn">{ru ? 'Нет доступа ни у кого' : 'Nobody has access'}</span>
          : null}
        {/* Said plainly rather than hidden: administering the organization is
            not the same as being able to open this artist's work. */}
        {!artist.viewer_has_membership
          ? <span className="badge">{ru ? 'Вы не видите работу' : 'You cannot open their work'}</span>
          : null}
      </div>
    </article>
  );
}

function AddArtistForm({
  busy, ru, onAdd,
}: {
  busy: boolean;
  ru: boolean;
  onAdd: (displayName: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {ru ? 'Добавить мастера' : 'Add artist'}
      </button>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void onAdd(name.trim()).then(() => { setName(''); setOpen(false); });
      }}
    >
      <label>
        {ru ? 'Имя мастера' : 'Artist name'}
        <input
          type="text"
          required
          maxLength={120}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="meta">
        {ru
          ? 'Адрес и префикс ссылок подберутся сами. Мастер создаётся без интеграций и без доступа — дальше откроется список шагов.'
          : 'The address and reference prefix are worked out for you. The artist is created with no integrations and no access; the next screen lists what is left.'}
      </p>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? (ru ? 'Добавляем…' : 'Adding…') : (ru ? 'Добавить' : 'Add')}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          {ru ? 'Отмена' : 'Cancel'}
        </button>
      </div>
    </form>
  );
}

function AddPersonForm({
  ru, busy, profiles, onAdd,
}: {
  ru: boolean;
  busy: boolean;
  profiles: DirectoryProfile[];
  onAdd: (profileId: string) => void;
}) {
  const [profileId, setProfileId] = useState('');

  if (profiles.length === 0) {
    return (
      <p className="meta">
        {ru
          ? 'Все активные пользователи CRM уже в этой организации. Пригласить нового человека можно на странице «Пользователи».'
          : 'Every active CRM user is already in this organization. Invite someone new from the Users screen.'}
      </p>
    );
  }

  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (profileId) { onAdd(profileId); setProfileId(''); }
      }}
    >
      <label>
        {ru ? 'Добавить человека' : 'Add a person'}
        <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          <option value="">{ru ? 'Выберите…' : 'Choose…'}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.display_name ?? profile.email}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy || !profileId}>
        {ru ? 'Добавить' : 'Add'}
      </button>
    </form>
  );
}

// `owner` is absent on purpose. public.upsert_workspace_membership refuses to
// grant it and refuses to write over a row that already holds it, so offering
// it here could only ever produce an error.
const ASSIGNABLE_WORKSPACE_ROLES: Exclude<WorkspaceRole, 'owner'>[] =
  ['admin', 'booking_manager', 'read_only'];

function TeamRow({
  member, ru, busy, canManageIntegrations, canManageWorkspace, onSave,
}: {
  member: WorkspaceTeamMember;
  ru: boolean;
  busy: boolean;
  canManageIntegrations: boolean;
  canManageWorkspace: boolean;
  onSave: (next: {
    profileId: string;
    workspaceRole: WorkspaceRole;
    canManageWorkspace: boolean;
    canManageTeam: boolean;
    canManageIntegrations: boolean;
    isActive: boolean;
  }) => void;
}) {
  const isOwner = member.workspace_role === 'owner';
  const [draft, setDraft] = useState({
    workspaceRole: member.workspace_role,
    canManageWorkspace: member.can_manage_workspace,
    canManageTeam: member.can_manage_team,
    canManageIntegrations: member.can_manage_integrations,
    isActive: member.membership_is_active,
  });

  const dirty = useMemo(
    () => draft.workspaceRole !== member.workspace_role
      || draft.canManageWorkspace !== member.can_manage_workspace
      || draft.canManageTeam !== member.can_manage_team
      || draft.canManageIntegrations !== member.can_manage_integrations
      || draft.isActive !== member.membership_is_active,
    [draft, member],
  );

  return (
    <article className="card team-row">
      <header>
        <strong>{member.display_name ?? member.email}</strong>
        <div className="meta">
          {member.email}
          {member.profile_is_active ? null : (
            <> · <span className="badge danger">{ru ? 'Учётка отключена' : 'Account deactivated'}</span></>
          )}
          {' · '}
          {ru ? 'мастеров здесь: ' : 'artists here: '}{member.artist_access_count}
        </div>
      </header>

      {isOwner ? (
        // The backend refuses every edit to an owner row through this RPC, so
        // the row renders as a statement of fact rather than as a form that is
        // guaranteed to fail. Ownership moves through a deliberate transfer.
        <p className="meta">
          {ru
            ? 'Владелец организации. Передать владение можно только явной передачей — обычное управление командой здесь ничего не меняет.'
            : 'Owns this organization. Ownership moves only through a deliberate transfer; ordinary team management cannot change this row.'}
        </p>
      ) : (
      <div className="team-row-controls">
        <label>
          {ru ? 'Роль' : 'Role'}
          <select
            value={draft.workspaceRole}
            disabled={busy}
            onChange={(event) => setDraft((current) => ({
              ...current, workspaceRole: event.target.value as WorkspaceRole,
            }))}
          >
            {ASSIGNABLE_WORKSPACE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role === 'admin' ? (ru ? 'Администратор' : 'Admin')
                  : role === 'booking_manager' ? (ru ? 'Менеджер' : 'Manager')
                  : (ru ? 'Только чтение' : 'Read only')}
              </option>
            ))}
          </select>
        </label>

        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.isActive}
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
          />
          <span>{ru ? 'Активен' : 'Active'}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.canManageTeam}
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, canManageTeam: event.target.checked }))}
          />
          <span>{ru ? 'Управляет людьми' : 'Manages people'}</span>
        </label>
        {/* Offered only to somebody who holds the right themselves: the
            database refuses to mint a right the caller lacks, and an editor
            that showed the box anyway would be promising a failed save. */}
        {canManageWorkspace ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.canManageWorkspace}
              disabled={busy}
              onChange={(event) => setDraft((current) => ({
                ...current, canManageWorkspace: event.target.checked,
              }))}
            />
            <span>{ru ? 'Управляет организацией' : 'Manages the organization'}</span>
          </label>
        ) : null}
        {canManageIntegrations ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.canManageIntegrations}
              disabled={busy}
              onChange={(event) => setDraft((current) => ({
                ...current, canManageIntegrations: event.target.checked,
              }))}
            />
            <span>{ru ? 'Управляет интеграциями' : 'Manages integrations'}</span>
          </label>
        ) : null}
      </div>

      )}

      {dirty && !isOwner ? (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave({ profileId: member.profile_id, ...draft })}
          >
            {ru ? 'Сохранить' : 'Save'}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function WorkspaceSettings({
  workspace, ru, busy, hasActiveArtists, onSave,
}: {
  workspace: Workspace;
  ru: boolean;
  busy: boolean;
  hasActiveArtists: boolean;
  onSave: (patch: {
    displayName?: string;
    timezone?: string;
    defaultCurrency?: string;
    isActive?: boolean;
  }) => void;
}) {
  const [name, setName] = useState(workspace.display_name);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [currency, setCurrency] = useState(workspace.default_currency);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      displayName: name.trim(),
      timezone: timezone.trim(),
      defaultCurrency: currency.trim().toUpperCase(),
    });
  }

  return (
    <Section title={ru ? 'Настройки организации' : 'Organization settings'}>
      <form className="stack" onSubmit={submit}>
        <label>
          {ru ? 'Название' : 'Name'}
          <input type="text" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {ru ? 'Часовой пояс' : 'Time zone'}
          <input type="text" maxLength={100} value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        </label>
        <label>
          {ru ? 'Валюта' : 'Currency'}
          <input
            type="text"
            maxLength={3}
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy}>{ru ? 'Сохранить' : 'Save'}</button>
        </div>
      </form>

      <div className="danger-zone">
        {workspace.is_active ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={busy || hasActiveArtists}
              onClick={() => {
                const message = ru
                  ? 'Отключить организацию? Она исчезнет из списков, данные сохранятся.'
                  : 'Deactivate this organization? It disappears from lists; the data stays.';
                if (window.confirm(message)) onSave({ isActive: false });
              }}
            >
              {ru ? 'Отключить организацию' : 'Deactivate organization'}
            </button>
            {hasActiveArtists ? (
              <p className="meta">
                {ru
                  ? 'Сначала отключите всех активных мастеров этой организации.'
                  : 'Deactivate this organization’s active artists first.'}
              </p>
            ) : null}
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => onSave({ isActive: true })}>
            {ru ? 'Включить организацию' : 'Reactivate organization'}
          </button>
        )}
      </div>
    </Section>
  );
}
