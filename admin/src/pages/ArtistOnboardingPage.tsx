// One artist: what they still need, and the controls to do it.
//
// Written as a checklist rather than a wizard with Next buttons, for two
// reasons. A wizard implies an order, and only one step here genuinely blocks
// the others. And a wizard has to remember where you are, which means storing
// progress — and stored progress starts lying the moment somebody switches a
// booking form off. Every row below is derived from live state on each load,
// so the screen cannot disagree with the database about what is done.
//
// The status vocabulary comes straight from public.artist_onboarding_state.
// `external` is the one that earns its keep: it marks a step that cannot be
// finished in this CRM at all, because a provider approval or an OAuth consent
// happens somewhere else. Calling that "required" would be asking somebody to
// click a button that does not exist.

import { useCallback, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { CapabilityEditor, useCapabilityPreview } from '../components/CapabilityEditor';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { Link } from '../lib/router';
import { useApi } from '../lib/session';
import {
  bookingSourcePublicUrl,
  type BookingSource,
  type Workspace,
} from '../lib/platform-api';
import type {
  ArtistMembershipRow,
  MembershipGrant,
  OnboardingRow,
  OnboardingStatus,
  WorkspaceArtist,
} from '../lib/control-plane-api';
import type { Profile } from '../lib/types';
import './ControlPlane.css';

interface ArtistData {
  workspace: Workspace | null;
  artist: WorkspaceArtist | null;
  onboarding: OnboardingRow[];
  memberships: ArtistMembershipRow[] | null;
  bookingSources: BookingSource[] | null;
  profiles: Profile[];
  defaultsCount: number;
}

const STATUS_TONE: Record<OnboardingStatus, string> = {
  ready: 'ok',
  required: 'danger',
  recommended: 'warn',
  optional: '',
  external: '',
};

function statusLabel(status: OnboardingStatus, ru: boolean): string {
  const en: Record<OnboardingStatus, string> = {
    ready: 'Done', required: 'Needed', recommended: 'Suggested',
    optional: 'Optional', external: 'Needs an outside step',
  };
  const rus: Record<OnboardingStatus, string> = {
    ready: 'Готово', required: 'Нужно', recommended: 'Рекомендуем',
    optional: 'По желанию', external: 'Требует действия вне CRM',
  };
  return ru ? rus[status] : en[status];
}

function stepLabel(step: string, ru: boolean): string {
  const en: Record<string, string> = {
    identity: 'Who they are', workspace: 'Organization', team: 'Who can reach them',
    booking: 'Taking enquiries', notifications: 'Being told things',
    integrations: 'Connected services', automations: 'Studio automations',
  };
  const rus: Record<string, string> = {
    identity: 'Кто это', workspace: 'Организация', team: 'У кого есть доступ',
    booking: 'Приём заявок', notifications: 'Уведомления',
    integrations: 'Подключённые сервисы', automations: 'Автоматизации студии',
  };
  return (ru ? rus[step] : en[step]) ?? step;
}

export function ArtistOnboardingPage({ artistId }: { artistId: string }) {
  const api = useApi();
  const { language } = useLanguage();
  const ru = language === 'ru';

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useAsync<ArtistData>(async () => {
    const workspaces = await api.listWorkspaces();

    // The artist's own workspace is found by asking each accessible workspace
    // for its roster. There is no "which workspace is this artist in" read for
    // somebody who holds no membership on them, and inventing one would be a
    // way to enumerate the installation.
    let workspace: Workspace | null = null;
    let artist: WorkspaceArtist | null = null;
    for (const candidate of workspaces) {
      try {
        const roster = await api.listWorkspaceArtists(candidate.id);
        const match = roster.find((row) => row.id === artistId);
        if (match) { workspace = candidate; artist = match; break; }
      } catch {
        // Not readable by this profile; try the next.
      }
    }
    if (!artist) {
      return {
        workspace: null, artist: null, onboarding: [], memberships: null,
        bookingSources: null, profiles: [], defaultsCount: 0,
      };
    }

    const onboarding = await api.artistOnboardingState(artistId);

    // Each of these needs a right the reader may not hold. A refusal means the
    // section is not theirs to see, so it collapses rather than erroring.
    let memberships: ArtistMembershipRow[] | null = null;
    try { memberships = await api.listArtistMemberships(artistId); } catch { memberships = null; }

    let bookingSources: BookingSource[] | null = null;
    try { bookingSources = await api.listBookingSources(artistId); } catch { bookingSources = null; }

    let profiles: Profile[] = [];
    try { profiles = await api.listProfiles(); } catch { profiles = []; }

    let defaultsCount = 0;
    if (workspace) {
      try {
        defaultsCount = (await api.listWorkspaceAutomationDefaults(workspace.id)).length;
      } catch { defaultsCount = 0; }
    }

    return { workspace, artist, onboarding, memberships, bookingSources, profiles, defaultsCount };
  }, [api, artistId]);

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

  const data = state.data;
  if (!data?.artist) {
    return (
      <EmptyState
        title={ru ? 'Мастер недоступен' : 'Artist unavailable'}
        hint={ru
          ? 'У вас нет доступа ни к самому мастеру, ни к его организации.'
          : 'You have access neither to this artist nor to their organization.'}
      />
    );
  }

  const { artist, workspace, onboarding, memberships, bookingSources, profiles, defaultsCount } = data;
  const canAdminister = workspace?.can_manage_workspace ?? false;
  const remaining = onboarding.filter((row) => row.status === 'required').length;

  // The bootstrap seat is a one-shot: the database refuses it the moment any
  // membership row exists. Offer it only while that is genuinely true, so the
  // button is never a guaranteed error.
  const canSeat = canAdminister && memberships !== null && memberships.length === 0;

  return (
    <div className="stack">
      <div className="page-head">
        {workspace ? (
          <Link to={`/workspaces/${workspace.id}`} className="linklike">
            ← {workspace.display_name}
          </Link>
        ) : null}
        <h1>{artist.display_name}</h1>
        <div className="meta">
          {artist.timezone}{' · '}{artist.default_currency}
          {artist.is_active ? null : (
            <> {' · '}<span className="badge danger">{ru ? 'Отключён' : 'Deactivated'}</span></>
          )}
        </div>
      </div>

      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {notice ? <div className="notice ok" role="status">{notice}</div> : null}

      <Section title={ru ? 'Что осталось сделать' : 'What is left to do'}>
        {remaining === 0 ? (
          <div className="notice ok" role="status">
            {ru
              ? 'Мастер готов к работе. Остальное — по желанию.'
              : 'This artist is ready to work. Everything else is optional.'}
          </div>
        ) : null}
        <ol className="checklist">
          {onboarding.map((row) => (
            <li key={row.step} className={`checklist-row status-${row.status}`}>
              <div className="checklist-row-head">
                <span className="checklist-step">{stepLabel(row.step, ru)}</span>
                <span className={`badge ${STATUS_TONE[row.status]}`}>
                  {statusLabel(row.status, ru)}
                </span>
              </div>
              <p className="meta">{row.detail}</p>
            </li>
          ))}
        </ol>
      </Section>

      {canSeat ? (
        <Section title={ru ? 'Кто этот мастер' : 'Who is this artist'}>
          <p className="meta">
            {ru
              ? 'Выберите человека, который будет вести этот книгу записей. Он получит полный доступ к своей работе, включая финансы. Это делается один раз: дальше доступ выдаётся обычным способом.'
              : 'Choose the person who will run this book. They get full access to their own work, money included. This happens once; after it, access is granted the ordinary way.'}
          </p>
          <SeatArtistForm
            ru={ru}
            busy={busy}
            profiles={profiles.filter((profile) => profile.is_active)}
            onSeat={(profileId) => run(
              () => api.seatArtistOwner(profileId, artistId),
              ru ? 'Мастер получил доступ к своей работе.' : 'The artist now has access to their own work.',
            )}
          />
        </Section>
      ) : null}

      {memberships !== null ? (
        <Section title={ru ? 'Доступ к этому мастеру' : 'Access to this artist'}>
          {memberships.length === 0 ? (
            <EmptyState
              compact
              title={ru ? 'Ни у кого' : 'Nobody'}
              hint={ru
                ? 'Пока никто не может открыть этого мастера — ни в CRM, ни через GPT.'
                : 'Nobody can open this artist yet — not in the CRM, not through the GPT.'}
            />
          ) : (
            <div className="team-rows">
              {memberships.map((membership) => (
                <MembershipRow
                  key={membership.profile_id}
                  artistId={artistId}
                  membership={membership}
                  ru={ru}
                  busy={busy}
                  api={api}
                  onSave={(grant) => run(
                    () => api.grantArtistMembership({
                      profileId: membership.profile_id, artistId, grant,
                    }),
                    ru ? 'Доступ сохранён.' : 'Access saved.',
                  )}
                />
              ))}
            </div>
          )}

          <AddMembershipForm
            artistId={artistId}
            ru={ru}
            busy={busy}
            api={api}
            profiles={profiles.filter(
              (profile) => profile.is_active
                && !memberships.some((membership) => membership.profile_id === profile.id),
            )}
            onGrant={(profileId, grant) => run(
              () => api.grantArtistMembership({ profileId, artistId, grant }),
              ru ? 'Доступ выдан.' : 'Access granted.',
            )}
          />
        </Section>
      ) : null}

      {bookingSources !== null ? (
        <Section title={ru ? 'Приём заявок' : 'Taking enquiries'}>
          {bookingSources.length === 0 ? (
            <p className="meta">
              {ru
                ? 'Формы ещё нет. Создать её можно на странице «Формы и сайты» — деплой не нужен.'
                : 'No form yet. Create one on the Forms and websites screen; no deploy is involved.'}
            </p>
          ) : (
            <ul className="source-list">
              {bookingSources.map((source) => (
                <li key={source.id}>
                  <div>
                    <strong>{source.display_label}</strong>{' '}
                    {source.is_active
                      ? <span className="badge ok">{ru ? 'Включена' : 'Live'}</span>
                      : <span className="badge warn">{ru ? 'Выключена' : 'Off'}</span>}
                  </div>
                  {source.is_active ? (
                    <CopyLink value={bookingSourcePublicUrl(source)} ru={ru} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <Link to="/integrations/forms" className="linklike">
            {ru ? 'Открыть формы и сайты →' : 'Open forms and websites →'}
          </Link>
        </Section>
      ) : null}

      <Section title={ru ? 'Сервисы и автоматизации' : 'Services and automations'}>
        <p className="meta">
          {ru
            ? 'Календарь, почта, платежи и мессенджеры подключаются на странице «Интеграции». Часть из них требует подтверждения на стороне провайдера — это нельзя сделать внутри CRM.'
            : 'Calendar, email, payments and messaging connect on the Integrations screen. Some need an approval on the provider’s side, which cannot happen inside this CRM.'}
        </p>
        <Link to="/integrations" className="linklike">
          {ru ? 'Открыть интеграции →' : 'Open integrations →'}
        </Link>

        {defaultsCount > 0 ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="meta">
              {ru
                ? `У организации есть правил по умолчанию: ${defaultsCount}. Их можно применить к этому мастеру — они станут его собственными правилами.`
                : `This organization has ${defaultsCount} default rule(s). Applying them makes them this artist’s own rules.`}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(
                async () => {
                  const applied = await api.applyWorkspaceAutomationDefaults(artistId);
                  return applied;
                },
                ru ? 'Правила применены.' : 'Defaults applied.',
              )}
            >
              {ru ? 'Применить правила студии' : 'Apply studio defaults'}
            </button>
          </div>
        ) : null}
      </Section>

      {canAdminister ? (
        <ArtistSettings
          artist={artist}
          ru={ru}
          busy={busy}
          onSave={(patch) => run(
            () => api.updateArtist({ artistId, ...patch }),
            ru ? 'Сохранено.' : 'Saved.',
          )}
        />
      ) : null}
    </div>
  );
}

function CopyLink({ value, ru }: { value: string; ru: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="copy-link">
      <code>{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value)
            .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); })
            .catch(() => undefined);
        }}
      >
        {copied ? (ru ? 'Скопировано' : 'Copied') : (ru ? 'Копировать' : 'Copy')}
      </button>
    </div>
  );
}

function SeatArtistForm({
  ru, busy, profiles, onSeat,
}: {
  ru: boolean;
  busy: boolean;
  profiles: Profile[];
  onSeat: (profileId: string) => void;
}) {
  const [profileId, setProfileId] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={(event) => { event.preventDefault(); if (profileId) onSeat(profileId); }}
    >
      <label>
        {ru ? 'Человек' : 'Person'}
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
        {ru ? 'Выдать доступ' : 'Give them access'}
      </button>
    </form>
  );
}

function MembershipRow({
  artistId, membership, ru, busy, api, onSave,
}: {
  artistId: string;
  membership: ArtistMembershipRow;
  ru: boolean;
  busy: boolean;
  api: ReturnType<typeof useApi>;
  onSave: (grant: MembershipGrant) => void;
}) {
  const [open, setOpen] = useState(false);
  const [grant, setGrant] = useState<MembershipGrant>({
    accessLevel: membership.access_level,
    canViewFinance: membership.can_view_finance,
    canManageFinance: membership.can_manage_finance,
    canManageSessions: membership.can_manage_sessions,
    canManageIntegrations: membership.can_manage_integrations,
    isActive: membership.is_active,
  });

  const loader = useCallback(
    (shape: Omit<MembershipGrant, 'isActive'>) =>
      api.previewMembershipCapabilities(artistId, membership.profile_id, shape),
    [api, artistId, membership.profile_id],
  );
  const { preview, loading } = useCapabilityPreview(loader, grant, open);

  return (
    <article className="card team-row">
      <header>
        <strong>{membership.display_name ?? membership.email}</strong>
        <div className="meta">
          {membership.email}
          {' · '}
          {membership.is_active
            ? <span className="badge ok">{ru ? 'Активен' : 'Active'}</span>
            : <span className="badge danger">{ru ? 'Отозван' : 'Revoked'}</span>}
          {/* Answers "why does this person have access", from the record the
              database keeps rather than from a guess. */}
          {membership.grant_source === 'owner_sync' ? (
            <> · <span className="badge">{ru ? 'Прежняя роль владельца' : 'Legacy owner role'}</span></>
          ) : membership.grant_source === 'workspace_grant' ? (
            <> · <span className="badge">{ru ? 'Выдан организацией' : 'Granted by the organization'}</span></>
          ) : null}
        </div>
      </header>

      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          {ru ? 'Изменить доступ' : 'Change access'}
        </button>
      ) : (
        <>
          <CapabilityEditor
            value={grant}
            onChange={setGrant}
            preview={preview}
            previewLoading={loading}
            disabled={busy}
          />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => onSave(grant)}>
              {ru ? 'Сохранить' : 'Save'}
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              {ru ? 'Закрыть' : 'Close'}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function AddMembershipForm({
  artistId, ru, busy, api, profiles, onGrant,
}: {
  artistId: string;
  ru: boolean;
  busy: boolean;
  api: ReturnType<typeof useApi>;
  profiles: Profile[];
  onGrant: (profileId: string, grant: MembershipGrant) => void;
}) {
  const [profileId, setProfileId] = useState('');
  const [grant, setGrant] = useState<MembershipGrant>({
    accessLevel: 'manager',
    canViewFinance: false,
    canManageFinance: false,
    canManageSessions: true,
    canManageIntegrations: false,
    isActive: true,
  });

  const loader = useCallback(
    (shape: Omit<MembershipGrant, 'isActive'>) =>
      api.previewMembershipCapabilities(artistId, profileId, shape),
    [api, artistId, profileId],
  );
  const { preview, loading } = useCapabilityPreview(loader, grant, Boolean(profileId));

  if (profiles.length === 0) return null;

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h3>{ru ? 'Дать доступ ещё кому-то' : 'Give someone else access'}</h3>
      <label>
        {ru ? 'Человек' : 'Person'}
        <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          <option value="">{ru ? 'Выберите…' : 'Choose…'}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.display_name ?? profile.email}
            </option>
          ))}
        </select>
      </label>

      {profileId ? (
        <>
          <CapabilityEditor
            value={grant}
            onChange={setGrant}
            preview={preview}
            previewLoading={loading}
            disabled={busy}
            showActive={false}
          />
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => { onGrant(profileId, grant); setProfileId(''); }}
            >
              {ru ? 'Выдать доступ' : 'Grant access'}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ArtistSettings({
  artist, ru, busy, onSave,
}: {
  artist: WorkspaceArtist;
  ru: boolean;
  busy: boolean;
  onSave: (patch: {
    displayName?: string;
    timezone?: string;
    defaultCurrency?: string;
    isActive?: boolean;
  }) => void;
}) {
  const [name, setName] = useState(artist.display_name);
  const [timezone, setTimezone] = useState(artist.timezone);
  const [currency, setCurrency] = useState(artist.default_currency);

  return (
    <Section title={ru ? 'Настройки мастера' : 'Artist settings'}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            displayName: name.trim(),
            timezone: timezone.trim(),
            defaultCurrency: currency.trim().toUpperCase(),
          });
        }}
      >
        <label>
          {ru ? 'Имя' : 'Name'}
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
        {artist.is_active ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const message = ru
                  ? 'Отключить мастера? Публичные формы перестанут принимать заявки, и доступ у всех закроется. Данные сохранятся.'
                  : 'Deactivate this artist? Public forms stop taking enquiries and everyone’s access closes. The data stays.';
                if (window.confirm(message)) onSave({ isActive: false });
              }}
            >
              {ru ? 'Отключить мастера' : 'Deactivate artist'}
            </button>
            <p className="meta">
              {ru
                ? 'Формы не переключаются по одной: публичный приём отказывает, пока мастер отключён, и возвращается в прежнее состояние после включения.'
                : 'Forms are not switched off one by one: public intake refuses while the artist is deactivated, and returns exactly as it was on reactivation.'}
            </p>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => onSave({ isActive: true })}>
            {ru ? 'Включить мастера' : 'Reactivate artist'}
          </button>
        )}
      </div>
    </Section>
  );
}
