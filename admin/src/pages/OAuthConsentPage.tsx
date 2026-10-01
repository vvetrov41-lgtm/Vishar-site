import { useEffect, useMemo, useState } from 'react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import type { PendingGptConsent } from '../lib/oauth-consent-api';
import { useLanguage } from '../lib/i18n';
import { useSession } from '../lib/session';

const COPY = {
  en: {
    title: 'Authorize private GPT',
    pluginTitle: 'Authorize Vishar CRM Plugin',
    pluginPermission: 'CRM access within your permissions',
    pluginAccess: 'The Plugin can use appointments, enquiries, CRM records, finance and payments, client communications, research and read-only Cloudflare tools only where your CRM permissions allow. Sending messages and changing records are write actions, not read-only access.',
    pluginBoundary: 'Every request checks your profile, workspace membership, artist access and the required CRM permission. This Plugin cannot run arbitrary database queries, access another workspace without membership, administer automations, integrations or workspaces, delete your account, transfer workspace ownership or change signup policy. Cloudflare control is read-only.',
    loading: 'Checking this authorization request…',
    invalid: 'This authorization request is invalid, expired, or not available for your CRM access.',
    requestedBy: 'Requesting application',
    signedInAs: 'Signed in as',
    artist: 'Fixed artist scope',
    artistAccess: 'Artist access',
    membershipScope: 'Artists available through your CRM memberships',
    membershipCount: (count: number) => (count === 1
      ? '1 artist you are currently authorized for'
      : `${count} artists you are currently authorized for`),
    permission: 'Appointment access',
    write: 'View, create, reschedule and cancel appointments.',
    read: 'View appointments only.',
    scope: 'OAuth scope',
    boundaryTitle: 'What this does not allow',
    boundary: 'This action surface cannot switch artist, run arbitrary database queries, access finance, send client messages, or manage payments.',
    unifiedBoundary: 'The active artist can be changed only to an artist you are authorized to access, and access is re-checked on every request. This action surface cannot run arbitrary database queries, access finance, send client messages, or manage payments.',
    approve: 'Approve access',
    deny: 'Deny',
    approving: 'Approving…',
    denying: 'Denying…',
    signOut: 'Sign out',
    failed: 'The authorization decision could not be completed. Try again from the private GPT.',
  },
  ru: {
    title: 'Авторизация приватного GPT',
    pluginTitle: 'Авторизация Vishar CRM Plugin',
    pluginPermission: 'Доступ к CRM в рамках ваших прав',
    pluginAccess: 'Plugin может работать с записями, заявками, данными CRM, финансами и платежами, сообщениями клиентам, исследованием и read-only инструментами Cloudflare только там, где это разрешают ваши права в CRM. Отправка сообщений и изменение данных являются действиями записи, а не доступом только для чтения.',
    pluginBoundary: 'Каждый запрос проверяет профиль, участие в workspace, доступ к артисту и нужное право CRM. Plugin не может выполнять произвольные запросы к базе, получать доступ к чужому workspace без участия, администрировать автоматизации, интеграции или workspace, удалять ваш аккаунт, передавать владение workspace или изменять политику регистрации. Управление Cloudflare доступно только для чтения.',
    loading: 'Проверяем запрос на авторизацию…',
    invalid: 'Запрос недействителен, истёк или недоступен для ваших прав в CRM.',
    requestedBy: 'Запрашивающее приложение',
    signedInAs: 'Вы вошли как',
    artist: 'Фиксированный артист',
    artistAccess: 'Доступ к артистам',
    membershipScope: 'Артисты, доступные через ваши права в CRM',
    membershipCount: (count: number) => `Сейчас вам доступно артистов: ${count}`,
    permission: 'Доступ к записям',
    write: 'Просмотр, создание, перенос и отмена записей.',
    read: 'Только просмотр записей.',
    scope: 'OAuth-разрешение',
    boundaryTitle: 'Что этот доступ не разрешает',
    boundary: 'GPT не может переключить артиста, выполнять произвольные запросы к базе, видеть финансы, отправлять сообщения клиентам или управлять платежами.',
    unifiedBoundary: 'Активного артиста можно переключить только на артиста, к которому у вас есть доступ, и доступ проверяется заново при каждом запросе. GPT не может выполнять произвольные запросы к базе, видеть финансы, отправлять сообщения клиентам или управлять платежами.',
    approve: 'Разрешить доступ',
    deny: 'Отклонить',
    approving: 'Разрешаем…',
    denying: 'Отклоняем…',
    signOut: 'Выйти',
    failed: 'Не удалось завершить авторизацию. Запустите подключение заново из приватного GPT.',
  },
} as const;

function authorizationIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('authorization_id') ?? '';
}

export function OAuthConsentPage() {
  const { api, profile, signOut } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const authorizationId = useMemo(authorizationIdFromLocation, []);
  const [consent, setConsent] = useState<PendingGptConsent | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (!api || !authorizationId) {
      setError(copy.invalid);
      setLoading(false);
      return () => { current = false; };
    }

    setLoading(true);
    setError(null);
    void api.loadGptOAuthConsent(authorizationId)
      .then((result) => {
        if (!current) return;
        if (result.kind === 'redirect') {
          window.location.assign(result.redirectUrl);
          return;
        }
        setConsent(result.consent);
      })
      .catch(() => {
        if (current) setError(copy.invalid);
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => { current = false; };
  }, [api, authorizationId, copy.invalid]);

  async function decide(decision: 'approve' | 'deny') {
    if (!api || !consent || busy) return;
    setBusy(decision);
    setError(null);
    try {
      const redirectUrl = await api.decideGptOAuthConsent(
        consent.authorizationId,
        decision,
      );
      window.location.assign(redirectUrl);
    } catch {
      setError(copy.failed);
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="container" style={{ maxWidth: 640, paddingTop: 24 }}>
        <div className="login-language"><LanguageSwitcher /></div>
        <div className="card"><p>{copy.loading}</p></div>
      </div>
    );
  }

  // A screen that cannot tell which binding it is describing describes the
  // narrower one: a fixed artist. It never claims membership-wide reach it has
  // not been told about.
  const profileBound = consent?.details?.binding_mode === 'profile';
  const pluginBound = profileBound && consent?.details?.integration_key === 'vishar-crm-plugin';

  return (
    <div className="container" style={{ maxWidth: 640, paddingTop: 24 }}>
      <div className="login-language"><LanguageSwitcher /></div>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 4 }}>{pluginBound ? copy.pluginTitle : copy.title}</h1>

      {error || !consent ? (
        <div className="card">
          <p role="alert" style={{ color: 'var(--danger)' }}>{error ?? copy.invalid}</p>
          <div className="actions">
            <button type="button" onClick={() => { void signOut(); }}>{copy.signOut}</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 0.6fr) 1fr', gap: '10px 16px', margin: 0 }}>
            <dt style={{ color: 'var(--muted)' }}>{copy.requestedBy}</dt>
            <dd style={{ margin: 0 }}>{consent.summary.client_display_name}</dd>

            <dt style={{ color: 'var(--muted)' }}>{copy.signedInAs}</dt>
            <dd style={{ margin: 0 }}>{profile?.display_name ?? 'CRM staff'}</dd>

            <dt style={{ color: 'var(--muted)' }}>
              {profileBound ? copy.artistAccess : copy.artist}
            </dt>
            <dd style={{ margin: 0 }}>
              {profileBound ? (
                <>
                  {copy.membershipScope}
                  <br />
                  <span style={{ color: 'var(--muted)' }}>
                    {copy.membershipCount(consent.details?.artist_count ?? 0)}
                  </span>
                </>
              ) : consent.summary.artist_display_name}
            </dd>

            <dt style={{ color: 'var(--muted)' }}>{copy.permission}</dt>
            <dd style={{ margin: 0 }}>
              {consent.summary.can_manage_appointments ? copy.write : copy.read}
            </dd>

            {pluginBound && (
              <>
                <dt style={{ color: 'var(--muted)' }}>{copy.pluginPermission}</dt>
                <dd style={{ margin: 0 }}>{copy.pluginAccess}</dd>
              </>
            )}

            <dt style={{ color: 'var(--muted)' }}>{copy.scope}</dt>
            <dd style={{ margin: 0 }}>{consent.scopes.join(', ')}</dd>
          </dl>

          <div className="notice" style={{ marginTop: 18 }}>
            <strong>{copy.boundaryTitle}</strong>
            <p style={{ marginBottom: 0 }}>
              {pluginBound ? copy.pluginBoundary : profileBound ? copy.unifiedBoundary : copy.boundary}
            </p>
          </div>

          <div className="actions" style={{ marginTop: 18 }}>
            <button
              className="primary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => { void decide('approve'); }}
            >
              {busy === 'approve' ? copy.approving : copy.approve}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => { void decide('deny'); }}
            >
              {busy === 'deny' ? copy.denying : copy.deny}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const __testing = Object.freeze({ authorizationIdFromLocation });
