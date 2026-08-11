import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApi, useSession } from '../lib/session';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { formatDate } from '../lib/format';
import { useLanguage } from '../lib/i18n';
import type {
  Artist,
  ArtistAccessLevel,
  ArtistMembership,
  CrmRole,
  Profile,
  StaffInviteMembership,
} from '../lib/types';
import './UsersPage.css';

const ROLES: CrmRole[] = ['owner', 'booking_manager', 'read_only'];
const INVITE_ROLES: Exclude<CrmRole, 'owner'>[] = ['booking_manager', 'read_only'];
const ACCESS_LEVELS: Exclude<ArtistAccessLevel, 'owner'>[] = ['artist', 'manager', 'read_only'];

interface TeamData {
  profiles: Profile[];
  artists: Artist[];
  memberships: ArtistMembership[];
}

export function UsersPage() {
  const api = useApi();
  const { profile } = useSession();
  const { t, label, language } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<TeamData>(async () => {
    const [profiles, artists, memberships] = await Promise.all([
      api.listProfiles(),
      api.listAccessibleArtists(),
      api.listTeamMemberships(),
    ]);
    return { profiles, artists, memberships };
  }, [api]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await action();
      if (success) setActionSuccess(success);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('users.actionFailed'));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label={t('users.loading')} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={t('users.noStaff')} />;

  return (
    <div className="team-page">
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}
      {actionSuccess ? <div className="notice ok" role="status">{actionSuccess}</div> : null}

      <section className="team-section" aria-labelledby="team-invite-title">
        <div className="team-heading">
          <div>
            <h2 id="team-invite-title">{t('users.inviteTitle')}</h2>
            <p>{t('users.inviteHint')}</p>
          </div>
        </div>
        <InviteForm
          artists={data.artists}
          busy={busy}
          configured={api.teamInviteConfigured}
          onInvite={async (invite) => {
            await run(
              () => api.inviteStaff(invite),
              t('users.inviteSuccess')
            );
          }}
        />
      </section>

      <section className="team-section" aria-labelledby="team-members-title">
        <div className="team-heading">
          <div>
            <h2 id="team-members-title">{t('users.teamTitle')}</h2>
            <p>{t('users.teamHint')}</p>
          </div>
        </div>

        <div className="team-list">
          {data.profiles.map((staff) => {
            const staffName = staff.display_name ?? staff.email;
            return (
              <article key={staff.id} className="row team-member-card">
                <header className="team-member-header">
                  <div>
                    <div className="title">{staffName}</div>
                    <div className="meta">
                      {staff.email} · {t('common.joined', { date: formatDate(staff.created_at, language) })}{' '}
                      {staff.is_active
                        ? <span className="badge ok">{t('users.active')}</span>
                        : <span className="badge danger">{t('users.deactivated')}</span>}
                    </div>
                  </div>

                  <div className="team-global-actions">
                    <label htmlFor={`role-${staff.id}`}>{t('users.globalRole')}</label>
                    <select
                      id={`role-${staff.id}`}
                      aria-label={t('users.roleFor', { name: staffName })}
                      value={staff.role}
                      disabled={busy}
                      onChange={(event) => {
                        void run(() => api.setProfileRole(
                          staff.id,
                          event.target.value as CrmRole
                        )).catch(() => undefined);
                      }}
                    >
                      {ROLES.map((role) => <option key={role} value={role}>{label('role', role)}</option>)}
                    </select>

                    <button
                      type="button"
                      className={staff.is_active ? 'danger' : ''}
                      disabled={busy || staff.id === profile?.id}
                      onClick={() => {
                        void run(() => api.setProfileActive(staff.id, !staff.is_active))
                          .catch(() => undefined);
                      }}
                    >
                      {staff.is_active ? t('users.deactivate') : t('users.reactivate')}
                    </button>
                  </div>
                </header>

                <div className="team-membership-grid">
                  {data.artists.map((artist) => (
                    <MembershipEditor
                      key={`${staff.id}:${artist.id}`}
                      staff={staff}
                      artist={artist}
                      membership={data.memberships.find(
                        (candidate) => candidate.profile_id === staff.id
                          && candidate.artist_id === artist.id
                      ) ?? null}
                      busy={busy}
                      onSave={async (membership) => {
                        await run(
                          () => api.upsertArtistMembership(membership),
                          t('users.accessSaved')
                        );
                      }}
                    />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <p className="notice">{t('users.notice')}</p>
    </div>
  );
}

function membershipDefaults(staff: Profile, artist: Artist): ArtistMembership {
  const readOnly = staff.role === 'read_only';
  return {
    profile_id: staff.id,
    artist_id: artist.id,
    access_level: readOnly ? 'read_only' : 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: !readOnly,
    can_manage_integrations: false,
    is_active: false,
  };
}

function MembershipEditor({
  staff,
  artist,
  membership,
  busy,
  onSave,
}: {
  staff: Profile;
  artist: Artist;
  membership: ArtistMembership | null;
  busy: boolean;
  onSave: (membership: ArtistMembership) => Promise<void>;
}) {
  const { t, label } = useLanguage();
  const automaticOwner = staff.role === 'owner';
  const [draft, setDraft] = useState<ArtistMembership>(
    membership ?? membershipDefaults(staff, artist)
  );

  useEffect(() => {
    setDraft(membership ?? membershipDefaults(staff, artist));
  }, [membership, staff.role, staff.id, artist.id]);

  function update(patch: Partial<ArtistMembership>) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (staff.role === 'read_only' || next.access_level === 'read_only') {
        next.access_level = 'read_only';
        next.can_view_finance = false;
        next.can_manage_finance = false;
        next.can_manage_sessions = false;
        next.can_manage_integrations = false;
      }
      if (!next.can_view_finance) next.can_manage_finance = false;
      return next;
    });
  }

  return (
    <fieldset className="membership-card" disabled={busy || automaticOwner}>
      <legend>{artist.display_name}</legend>
      {automaticOwner ? <p className="meta">{t('users.ownerAccessAutomatic')}</p> : null}

      <label className="check-row">
        <input
          type="checkbox"
          checked={automaticOwner || draft.is_active}
          onChange={(event) => update({ is_active: event.target.checked })}
        />
        <span>{t('users.membershipActive')}</span>
      </label>

      <label>
        {t('users.accessLevel')}
        <select
          value={automaticOwner ? 'owner' : draft.access_level}
          disabled={busy || automaticOwner || !draft.is_active || staff.role === 'read_only'}
          onChange={(event) => update({ access_level: event.target.value as ArtistAccessLevel })}
        >
          {automaticOwner ? <option value="owner">{label('artistAccess', 'owner')}</option> : null}
          {ACCESS_LEVELS.map((access) => (
            <option key={access} value={access}>{label('artistAccess', access)}</option>
          ))}
        </select>
      </label>

      <CapabilityChecks
        value={draft}
        disabled={busy || automaticOwner || !draft.is_active || draft.access_level === 'read_only'}
        onChange={update}
      />

      {!automaticOwner ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => { void onSave(draft).catch(() => undefined); }}
        >
          {t('users.saveAccess')}
        </button>
      ) : null}
    </fieldset>
  );
}

function CapabilityChecks({
  value,
  disabled,
  onChange,
}: {
  value: Pick<ArtistMembership, typeof CAPABILITIES[number]>;
  disabled: boolean;
  onChange: (patch: Partial<Pick<ArtistMembership, typeof CAPABILITIES[number]>>) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="capability-list">
      {CAPABILITIES.map((capability) => (
        <label className="check-row" key={capability}>
          <input
            type="checkbox"
            checked={value[capability]}
            disabled={disabled || (capability === 'can_manage_finance' && !value.can_view_finance)}
            onChange={(event) => onChange({ [capability]: event.target.checked })}
          />
          <span>{t(`users.${capability}`)}</span>
        </label>
      ))}
    </div>
  );
}

const CAPABILITIES = [
  'can_view_finance',
  'can_manage_finance',
  'can_manage_sessions',
  'can_manage_integrations',
] as const;

function inviteMembershipDefaults(artist: Artist): StaffInviteMembership & { enabled: boolean } {
  return {
    enabled: false,
    artist_id: artist.id,
    access_level: 'manager',
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
  };
}

function InviteForm({
  artists,
  busy,
  configured,
  onInvite,
}: {
  artists: Artist[];
  busy: boolean;
  configured: boolean;
  onInvite: (invite: {
    idempotency_key: string;
    email: string;
    display_name: string | null;
    role: Exclude<CrmRole, 'owner'>;
    memberships: StaffInviteMembership[];
  }) => Promise<void>;
}) {
  const { t, label } = useLanguage();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Exclude<CrmRole, 'owner'>>('booking_manager');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [memberships, setMemberships] = useState(() => artists.map(inviteMembershipDefaults));

  const selectedMemberships = useMemo(
    () => memberships.filter((membership) => membership.enabled),
    [memberships]
  );

  function updateMembership(artistId: string, patch: Partial<(typeof memberships)[number]>) {
    setMemberships((current) => current.map((membership) => {
      if (membership.artist_id !== artistId) return membership;
      const next = { ...membership, ...patch };
      if (role === 'read_only' || next.access_level === 'read_only') {
        next.access_level = 'read_only';
        next.can_view_finance = false;
        next.can_manage_finance = false;
        next.can_manage_sessions = false;
        next.can_manage_integrations = false;
      }
      if (!next.can_view_finance) next.can_manage_finance = false;
      return next;
    }));
  }

  function changeRole(nextRole: Exclude<CrmRole, 'owner'>) {
    setRole(nextRole);
    if (nextRole === 'read_only') {
      setMemberships((current) => current.map((membership) => ({
        ...membership,
        access_level: 'read_only',
        can_view_finance: false,
        can_manage_finance: false,
        can_manage_sessions: false,
        can_manage_integrations: false,
      })));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const requestMemberships = selectedMemberships.map(({ enabled: _enabled, ...membership }) => membership);
    try {
      await onInvite({
        idempotency_key: idempotencyKey,
        email,
        display_name: displayName.trim() || null,
        role,
        memberships: requestMemberships,
      });
      setEmail('');
      setDisplayName('');
      setIdempotencyKey(crypto.randomUUID());
      setMemberships(artists.map(inviteMembershipDefaults));
    } catch {
      // Keep the same idempotency key and form for a safe replay.
    }
  }

  return (
    <form className="invite-form" onSubmit={(event) => { void submit(event); }}>
      {!configured ? <div className="notice warn">{t('users.inviteNotConfigured')}</div> : null}
      <div className="field-row">
        <label>
          {t('users.email')}
          <input
            type="email"
            autoComplete="off"
            required
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          {t('users.displayName')}
          <input
            type="text"
            autoComplete="off"
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
      </div>

      <label>
        {t('users.globalRole')}
        <select
          value={role}
          onChange={(event) => changeRole(event.target.value as Exclude<CrmRole, 'owner'>)}
        >
          {INVITE_ROLES.map((value) => (
            <option key={value} value={value}>{label('role', value)}</option>
          ))}
        </select>
      </label>

      <div className="invite-artist-grid">
        {artists.map((artist) => {
          const membership = memberships.find((candidate) => candidate.artist_id === artist.id)!;
          return (
            <fieldset key={artist.id} className="membership-card">
              <legend>{artist.display_name}</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={membership.enabled}
                  onChange={(event) => updateMembership(artist.id, { enabled: event.target.checked })}
                />
                <span>{t('users.grantArtistAccess')}</span>
              </label>
              <label>
                {t('users.accessLevel')}
                <select
                  value={membership.access_level}
                  disabled={!membership.enabled || role === 'read_only'}
                  onChange={(event) => updateMembership(artist.id, {
                    access_level: event.target.value as Exclude<ArtistAccessLevel, 'owner'>,
                  })}
                >
                  {ACCESS_LEVELS.map((access) => (
                    <option key={access} value={access}>{label('artistAccess', access)}</option>
                  ))}
                </select>
              </label>
              <CapabilityChecks
                value={membership}
                disabled={!membership.enabled || membership.access_level === 'read_only'}
                onChange={(patch) => updateMembership(artist.id, patch)}
              />
            </fieldset>
          );
        })}
      </div>

      <button
        type="submit"
        disabled={busy || !configured || selectedMemberships.length === 0}
      >
        {busy ? t('users.inviting') : t('users.sendInvite')}
      </button>
      <p className="meta">{t('users.inviteSecurityNotice')}</p>
    </form>
  );
}
