import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useAsync } from '../components/AsyncData';
import { useLanguage } from '../lib/i18n';
import { canShowArtistIntegration } from '../lib/integration-visibility';
import {
  describeWhatsAppEmbeddedSignupError,
  launchWhatsAppEmbeddedSignup,
  META_WHATSAPP_APP_ID,
  META_WHATSAPP_CONFIG_ID,
  prepareWhatsAppEmbeddedSignup,
} from '../lib/meta-whatsapp-embedded-signup';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import type { Artist } from '../lib/types';
import {
  whatsappCrmEnvironment,
  whatsappIntegrationKey,
  type WhatsAppIntegrationMetadata,
} from '../lib/whatsapp-connections-api';

interface ConnectionsData {
  artists: Artist[];
  integrations: WhatsAppIntegrationMetadata[];
  environment: 'production' | 'staging';
}

export function canManageArtist(
  role: string | null | undefined,
  artistId: string,
  memberships: ReturnType<typeof useSession>['memberships'],
): boolean {
  if (role === 'owner') return true;
  if (role !== 'booking_manager') return false;
  return memberships.some(
    (membership) => membership.artist_id === artistId
      && membership.is_active
      && membership.can_manage_integrations,
  );
}

export function WhatsAppConnectionsPage() {
  const { api, profile, memberships } = useSession();
  const { language } = useLanguage();
  const [busyArtistId, setBusyArtistId] = useState<string | null>(null);
  const [metaBusyArtistId, setMetaBusyArtistId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [metaMessage, setMetaMessage] = useState<string | null>(null);
  const [metaSdkReady, setMetaSdkReady] = useState(false);
  const [metaSdkError, setMetaSdkError] = useState<string | null>(null);
  const [existingMetaToken, setExistingMetaToken] = useState('');
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();

  const canManageAnyArtist = profile?.role === 'owner'
    || (profile?.role === 'booking_manager' && memberships.some(
      (membership) => membership.is_active && membership.can_manage_integrations,
    ));

  useEffect(() => {
    if (!canManageAnyArtist) return undefined;
    let environment: 'production' | 'staging';
    try {
      environment = whatsappCrmEnvironment(supabaseUrl);
    } catch {
      return undefined;
    }
    if (environment !== 'production') return undefined;

    let active = true;
    setMetaSdkReady(false);
    setMetaSdkError(null);
    void prepareWhatsAppEmbeddedSignup()
      .then(() => {
        if (active) setMetaSdkReady(true);
      })
      .catch((cause) => {
        if (!active) return;
        setMetaSdkError(describeWhatsAppEmbeddedSignupError(cause, language));
      });
    return () => { active = false; };
  }, [canManageAnyArtist, language, supabaseUrl]);

  const { data, loading, error, reload } = useAsync<ConnectionsData>(async () => {
    if (!api) throw new Error('CRM API unavailable.');
    const environment = whatsappCrmEnvironment(supabaseUrl);
    const [artists, integrations] = await Promise.all([
      api.listAccessibleArtists(),
      api.listWhatsAppIntegrations(),
    ]);
    return {
      environment,
      integrations,
      artists: artists.filter(
        (artist) => artist.is_active && canShowArtistIntegration(profile, artist, memberships),
      ),
    };
  }, [api, memberships, profile, supabaseUrl]);

  async function runRouteAction(artistId: string, action: () => Promise<unknown>) {
    setBusyArtistId(artistId);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not update WhatsApp.');
    } finally {
      setBusyArtistId(null);
    }
  }

  async function startMetaOnboarding(artist: Artist) {
    setMetaBusyArtistId(artist.id);
    setActionError(null);
    setMetaMessage(null);
    try {
      if (
        !api
        || !data
        || data.environment !== 'production'
        || !canManageArtist(profile?.role, artist.id, memberships)
      ) {
        throw new Error('Production WhatsApp onboarding is unavailable in this CRM session.');
      }
      if (!metaSdkReady) throw new Error('Meta SDK is not ready yet.');
      const signup = await launchWhatsAppEmbeddedSignup();
      const provisioned = await api.provisionProductionWhatsApp(artist, supabaseUrl, signup);
      const identity = [provisioned.verified_name, provisioned.display_phone_number]
        .filter(Boolean)
        .join(' · ');
      setMetaMessage(language === 'ru'
        ? `WhatsApp ${artist.display_name} подключён${identity ? `: ${identity}` : ''}.`
        : `${artist.display_name} WhatsApp connected${identity ? `: ${identity}` : ''}.`);
      reload();
    } catch (cause) {
      setActionError(describeWhatsAppEmbeddedSignupError(cause, language));
    } finally {
      setMetaBusyArtistId(null);
    }
  }

  async function connectVladimirLegacy(artist: Artist) {
    setMetaBusyArtistId(artist.id);
    setActionError(null);
    setMetaMessage(null);
    try {
      if (!api || artist.slug !== 'vladimir' || !canManageArtist(profile?.role, artist.id, memberships)) {
        throw new Error('Existing WhatsApp connection is unavailable in this CRM session.');
      }
      const provisioned = await api.provisionExistingProductionWhatsApp(artist, supabaseUrl, existingMetaToken);
      setMetaMessage(language === 'ru'
        ? `Резервное подключение WhatsApp ${artist.display_name} проверено.`
        : `${artist.display_name} legacy WhatsApp connection verified.`);
      if (!provisioned.connected) throw new Error('WhatsApp connected-state readback failed.');
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not connect WhatsApp.');
    } finally {
      setExistingMetaToken('');
      setMetaBusyArtistId(null);
    }
  }

  function retryMetaSdk() {
    setMetaSdkReady(false);
    setMetaSdkError(null);
    void prepareWhatsAppEmbeddedSignup()
      .then(() => setMetaSdkReady(true))
      .catch((cause) => setMetaSdkError(describeWhatsAppEmbeddedSignupError(cause, language)));
  }

  if (loading) return <LoadingState label={language === 'ru' ? 'Загрузка WhatsApp…' : 'Loading WhatsApp…'} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">{language === 'ru' ? 'Интеграции' : 'Integrations'}</p>
          <h2>WhatsApp</h2>
          <p className="page-subtitle">
            {language === 'ru'
              ? 'Мастер подключает свой WhatsApp через обычное окно входа Meta. Facebook Developers, System User и ручные токены не требуются.'
              : 'Each artist connects WhatsApp through the normal Meta sign-in flow. Facebook Developers, System Users and manual tokens are not required.'}
          </p>
        </div>
        <div className="actions">
          <Link to="/integrations/calendar" className="badge">Google Calendar</Link>
        </div>
      </div>

      <div className="notice">
        <p>{language === 'ru'
          ? `Среда CRM: ${data.environment}. Постоянные credentials хранятся только в encrypted Worker bindings.`
          : `CRM environment: ${data.environment}. Persistent credentials live only in encrypted Worker bindings.`}</p>
        {data.environment === 'production' ? (
          <p>Meta App ID: <code>{META_WHATSAPP_APP_ID}</code>{' · '}Config ID: <code>{META_WHATSAPP_CONFIG_ID}</code></p>
        ) : null}
      </div>

      {metaSdkError ? (
        <div className="notice warn" role="alert">
          <p>{metaSdkError}</p>
          <button type="button" disabled={metaBusyArtistId !== null} onClick={retryMetaSdk}>
            {language === 'ru' ? 'Повторить загрузку Meta' : 'Retry Meta SDK'}
          </button>
        </div>
      ) : null}
      {metaMessage ? <div className="notice" role="status">{metaMessage}</div> : null}
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      {data.artists.length === 0 ? (
        <EmptyState
          title={language === 'ru' ? 'Нет доступных WhatsApp-интеграций' : 'No WhatsApp integrations available'}
          hint={language === 'ru'
            ? 'Для этого аккаунта нет artist scope с правом управления интеграциями.'
            : 'This account has no artist scope with integration-management permission.'}
        />
      ) : data.artists.map((artist) => {
        const expectedKey = whatsappIntegrationKey(supabaseUrl, artist.slug);
        const rows = data.integrations.filter((row) => row.artist_id === artist.id);
        const exact = rows.filter((row) => row.integration_key === expectedKey);
        const inconsistent = rows.length > 1 || rows.some((row) => row.integration_key !== expectedKey);
        const integration = !inconsistent && exact.length === 1 ? exact[0] : null;
        const canManage = canManageArtist(profile?.role, artist.id, memberships);
        const routeBusy = busyArtistId === artist.id;
        const metaBusy = metaBusyArtistId === artist.id;
        const onboardingAvailable = data.environment === 'production'
          && canManage
          && integration?.is_enabled === true;

        return (
          <Section key={artist.id} title={artist.display_name}>
            <dl className="definition">
              <dt>{language === 'ru' ? 'Провайдер' : 'Provider'}</dt><dd>Meta Cloud API</dd>
              <dt>{language === 'ru' ? 'Маршрут CRM' : 'CRM route'}</dt><dd><code>{expectedKey}</code></dd>
              <dt>{language === 'ru' ? 'Статус' : 'Status'}</dt>
              <dd>{inconsistent
                ? (language === 'ru' ? 'Требует проверки' : 'Needs review')
                : integration?.is_enabled
                  ? (language === 'ru' ? 'Включён' : 'Enabled')
                  : integration
                    ? (language === 'ru' ? 'Подготовлен, выключен' : 'Prepared, disabled')
                    : (language === 'ru' ? 'Не подготовлен' : 'Not prepared')}</dd>
            </dl>

            {inconsistent ? (
              <div className="notice warn" role="alert">
                {language === 'ru'
                  ? 'Найдена неожиданная или дублированная WhatsApp-маршрутизация.'
                  : 'Unexpected or duplicate WhatsApp routing exists for this artist.'}
              </div>
            ) : !integration ? (
              <div className="actions">
                <button
                  type="button"
                  disabled={routeBusy || !api || !canManage}
                  onClick={() => { if (api) void runRouteAction(artist.id, () => api.prepareWhatsAppIntegration(artist, supabaseUrl)); }}
                >
                  {language === 'ru' ? 'Подготовить WhatsApp' : 'Prepare WhatsApp'}
                </button>
              </div>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  disabled={routeBusy || !api || !canManage}
                  onClick={() => { if (api) void runRouteAction(artist.id, () => api.setWhatsAppIntegrationEnabled(artist, supabaseUrl, !integration.is_enabled)); }}
                >
                  {integration.is_enabled
                    ? (language === 'ru' ? 'Выключить маршрут' : 'Disable route')
                    : (language === 'ru' ? 'Включить маршрут' : 'Enable route')}
                </button>
              </div>
            )}

            {onboardingAvailable ? (
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="primary"
                  disabled={metaBusyArtistId !== null || !metaSdkReady}
                  onClick={() => { void startMetaOnboarding(artist); }}
                >
                  {metaBusy
                    ? (language === 'ru' ? 'Подключаю…' : 'Connecting…')
                    : !metaSdkReady
                      ? (language === 'ru' ? 'Загрузка Meta…' : 'Loading Meta…')
                      : (language === 'ru' ? `Подключить WhatsApp ${artist.display_name}` : `Connect ${artist.display_name} WhatsApp`)}
                </button>
              </div>
            ) : null}

            {artist.slug === 'vladimir' && onboardingAvailable ? (
              <details style={{ marginTop: 12 }}>
                <summary>{language === 'ru' ? 'Резервный ручной способ' : 'Legacy manual fallback'}</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (existingMetaToken.trim()) void connectVladimirLegacy(artist);
                  }}
                >
                  <label>
                    <span>{language === 'ru' ? 'System-user access token Meta' : 'Meta system-user access token'}</span>
                    <input
                      type="password"
                      value={existingMetaToken}
                      onChange={(event) => setExistingMetaToken(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={metaBusyArtistId !== null}
                    />
                  </label>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button type="submit" disabled={metaBusyArtistId !== null || existingMetaToken.trim().length < 40}>
                      {language === 'ru' ? 'Проверить резервное подключение' : 'Verify legacy connection'}
                    </button>
                  </div>
                </form>
              </details>
            ) : null}

            <p className="notice" style={{ marginTop: 12 }}>
              {language === 'ru'
                ? 'При обычном подключении мастер только входит в Facebook/Meta и выбирает свой WhatsApp Business. Токены не копируются вручную и не сохраняются в браузере или Postgres.'
                : 'Normal onboarding only asks the artist to sign in to Facebook/Meta and choose their WhatsApp Business account. Tokens are never copied manually or stored in the browser or Postgres.'}
            </p>
          </Section>
        );
      })}
    </>
  );
}
