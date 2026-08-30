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

import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
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
} from '../lib/platform-api';
import type {
  ArtistControlPlaneContext,
  ArtistMembershipRow,
  DirectoryProfile,
  MembershipGrant,
  OnboardingRow,
  OnboardingStatus,
} from '../lib/control-plane-api';
import './ControlPlane.css';

interface ArtistData {
  context: ArtistControlPlaneContext | null;
  onboarding: OnboardingRow[];
  memberships: ArtistMembershipRow[] | null;
  bookingSources: BookingSource[] | null;
  directory: DirectoryProfile[];
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
    // One read resolves the artist, its organization and the viewer's rights.
    //
    // This used to walk every workspace the viewer belonged to, looking for the
    // artist on each roster. That worked for an administrator and failed for
    // the person the page matters most to: a freshly seated artist holds an
    // artist membership and, in a studio, no workspace membership at all —
    // seat_artist_owner grants one and not the other, deliberately, because
    // workspace authority is not artist authority. So list_workspaces()
    // returned nothing for them and their own onboarding page said they had no
    // access to it.
    const context = await api.artistControlPlaneContext(artistId);
    if (!context) {
      return {
        context: null, onboarding: [], memberships: null,
        bookingSources: null, directory: [], defaultsCount: 0,
      };
    }

    const onboarding = await api.artistOnboardingState(artistId);

    // Each of these needs a right the reader may not hold. A refusal means the
    // section is not theirs to see, so it collapses rather than erroring.
    let memberships: ArtistMembershipRow[] | null = null;
    try { memberships = await api.listArtistMemberships(artistId); } catch { memberships = null; }

    let bookingSources: BookingSource[] | null = null;
    try { bookingSources = await api.listBookingSources(artistId); } catch { bookingSources = null; }

    let directory: DirectoryProfile[] = [];
    if (context.viewer_can_manage_team) {
      try { directory = await api.listDirectoryProfiles(); } catch { directory = []; }
    }

    let defaultsCount = 0;
    try {
      defaultsCount = (await api.listWorkspaceAutomationDefaults(context.workspace_id)).length;
    } catch { defaultsCount = 0; }

    return { context, onboarding, memberships, bookingSources, directory, defaultsCount };
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
  if (!data?.context) {
    return (
      <EmptyState
        title={ru ? 'Мастер недоступен' : 'Artist unavailable'}
        hint={ru
          ? 'У вас нет доступа ни к самому мастеру, ни к его организации.'
          : 'You have access neither to this artist nor to their organization.'}
      />
    );
  }

  const { context, onboarding, memberships, bookingSources, directory, defaultsCount } = data;
  const canAdminister = context.viewer_can_administer;
  const remaining = onboarding.filter((row) => row.status === 'required').length;

  // The bootstrap seat is a one-shot: the database refuses it the moment any
  // membership row exists. Offer it only while that is genuinely true, so the
  // button is never a guaranteed error.
  const canSeat = canAdminister && memberships !== null && memberships.length === 0;

  return (
    <div className="stack">
      <div className="page-head">
        {/* Named, not linked, for a viewer who holds no workspace right: the
            organization's name is context, and following it would only reach a
            refusal. */}
        {canAdminister ? (
          <Link to={`/workspaces/${context.workspace_id}`} className="linklike">
            ← {context.workspace_display_name}
          </Link>
        ) : (
          <div className="meta">{context.workspace_display_name}</div>
        )}
        <h1>{context.artist_display_name}</h1>
        <div className="meta">
          {context.artist_timezone}{' · '}{context.artist_default_currency}
          {context.artist_is_active ? null : (
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
            profiles={directory}
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
            profiles={directory.filter(
              (profile) => !memberships.some((m) => m.profile_id === profile.id),
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
          artist={context}
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
  profiles: DirectoryProfile[];
  onSeat: (profileId: string) => void;
}) {
  const [profileId, setProfileId] = useState('');
  const chosen = profiles.find((profile) => profile.id === profileId) ?? null;
  // The seat is one-shot and the database refuses an ineligible target, so the
  // person is told before they try rather than after. A read-only CRM user
  // holds no write capability whatever their artist membership says.
  const ineligible = chosen !== null && !chosen.can_hold_artist_writes;
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
      <button type="submit" disabled={busy || !profileId || ineligible}>
        {ru ? 'Выдать доступ' : 'Give them access'}
      </button>
      {ineligible ? (
        <p className="meta" role="status">
          {ru
            ? 'У этого человека роль «только чтение» — он не сможет ничего изменить. Сначала повысьте его роль в CRM или выберите другого.'
            : 'This person is a read-only CRM user and could not change anything. Raise their CRM role first, or choose somebody else.'}
        </p>
      ) : null}
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
  const { preview, loading } = useCapabilityPreview(
    loader, grant, open, membership.profile_id);

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
  profiles: DirectoryProfile[];
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
  const { preview, loading } = useCapabilityPreview(
    loader, grant, Boolean(profileId), profileId);

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
  artist: ArtistControlPlaneContext;
  ru: boolean;
  busy: boolean;
  onSave: (patch: {
    displayName?: string;
    timezone?: string;
    defaultCurrency?: string;
    isActive?: boolean;
  }) => void;
}) {
  const [name, setName] = useState(artist.artist_display_name);
  const [timezone, setTimezone] = useState(artist.artist_timezone);
  const [currency, setCurrency] = useState(artist.artist_default_currency);

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
        {artist.artist_is_active ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const message = ru
                  ? 'Отключить мастера? Публичные формы перестанут принимать заявки, и доступ у всех закроется. Данные сохранятся.'
                  : 'Deactivate this artist? Public forms stop taking enquiries and everyone’s access closes. The data stays.';
                void (async () => {
                  const approved = await confirmDialog({
                    title: ru ? 'Отключить?' : 'Deactivate?',
                    message,
                    confirmLabel: ru ? 'Отключить' : 'Deactivate',
                    cancelLabel: cancelLabelFor(ru ? 'ru' : 'en'),
                  });
                  if (approved) onSave({ isActive: false });
                })();
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
