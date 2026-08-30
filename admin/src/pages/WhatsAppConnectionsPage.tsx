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
  const [actionError, setActionError] = useState<string | null>(null);
  const [metaBusyArtistId, setMetaBusyArtistId] = useState<string | null>(null);
  const [metaMessage, setMetaMessage] = useState<string | null>(null);
  const [metaSdkReady, setMetaSdkReady] = useState(false);
  const [metaSdkError, setMetaSdkError] = useState<string | null>(null);
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

    return () => {
      active = false;
    };
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

  async function run(artistId: string, action: () => Promise<unknown>) {
    setBusyArtistId(artistId);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : language === 'ru'
            ? 'Не удалось обновить WhatsApp.'
            : 'Could not update WhatsApp.',
      );
    } finally {
      setBusyArtistId(null);
    }
  }

  function retryMetaSdk() {
    setMetaSdkReady(false);
    setMetaSdkError(null);
    void prepareWhatsAppEmbeddedSignup()
      .then(() => setMetaSdkReady(true))
      .catch((cause) => {
        setMetaSdkError(describeWhatsAppEmbeddedSignupError(cause, language));
      });
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

      // This call must remain synchronous with the tap so iOS/WebKit permits
      // the Meta window. The one-time code is exchanged only by the backend.
      const signup = await launchWhatsAppEmbeddedSignup();
      const provisioned = await api.provisionProductionWhatsApp(artist, supabaseUrl, signup);
      const identity = [provisioned.verified_name, provisioned.display_phone_number]
        .filter(Boolean)
        .join(' · ');
      setMetaMessage(
        language === 'ru'
          ? `WhatsApp ${artist.display_name} подключён${identity ? `: ${identity}` : ''}. Оба encrypted Worker bindings записаны.`
          : `${artist.display_name} WhatsApp connected${identity ? `: ${identity}` : ''}. Both encrypted Worker bindings were written.`,
      );
      reload();
    } catch (cause) {
      setActionError(describeWhatsAppEmbeddedSignupError(cause, language));
    } finally {
      setMetaBusyArtistId(null);
    }
  }

  if (loading) {
    return <LoadingState label={language === 'ru' ? 'Загрузка WhatsApp…' : 'Loading WhatsApp…'} />;
  }
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
              ? 'Здесь хранится только безопасная маршрутизация CRM. Токены, app secret, WABA ID и phone-number ID здесь не вводятся и не показываются.'
              : 'Only safe CRM routing metadata lives here. Access tokens, app secrets, WABA IDs and phone-number IDs are never entered or shown on this screen.'}
          </p>
        </div>
        <div className="actions">
          <Link to="/integrations/calendar" className="badge">
            {language === 'ru' ? 'Google Calendar' : 'Google Calendar'}
          </Link>
        </div>
      </div>

      <div className="notice">
        <p>
          {language === 'ru'
            ? `Среда CRM: ${data.environment}. Включайте маршрут только после отдельной проверки Meta и encrypted Worker bindings.`
            : `CRM environment: ${data.environment}. Enable a route only after the Meta account and encrypted Worker bindings have been verified separately.`}
        </p>
        {data.environment === 'production' ? (
          <p>
            Meta App ID: <code>{META_WHATSAPP_APP_ID}</code>
            {' · '}
            Config ID: <code>{META_WHATSAPP_CONFIG_ID}</code>
          </p>
        ) : null}
      </div>

      {canManageAnyArtist && data.environment === 'production' && metaSdkError ? (
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
      ) : (
        data.artists.map((artist) => {
          const expectedKey = whatsappIntegrationKey(supabaseUrl, artist.slug);
          const rows = data.integrations.filter((row) => row.artist_id === artist.id);
          const exact = rows.filter((row) => row.integration_key === expectedKey);
          const inconsistent = rows.length > 1 || rows.some((row) => row.integration_key !== expectedKey);
          const integration = !inconsistent && exact.length === 1 ? exact[0] : null;
          const busy = busyArtistId === artist.id;
          const metaBusy = metaBusyArtistId === artist.id;
          const productionOnboardingAvailable = data.environment === 'production'
            && canManageArtist(profile?.role, artist.id, memberships)
            && integration?.is_enabled === true
            && (artist.slug === 'vladimir' || artist.slug === 'kristina');

          return (
            <Section key={artist.id} title={artist.display_name}>
              <dl className="definition">
                <dt>{language === 'ru' ? 'Провайдер' : 'Provider'}</dt>
                <dd>Meta Cloud API</dd>
                <dt>{language === 'ru' ? 'Маршрут CRM' : 'CRM route'}</dt>
                <dd><code>{expectedKey}</code></dd>
                <dt>{language === 'ru' ? 'Статус' : 'Status'}</dt>
                <dd>
                  {inconsistent
                    ? (language === 'ru' ? 'Требует проверки' : 'Needs review')
                    : integration?.is_enabled
                      ? (language === 'ru' ? 'Включён' : 'Enabled')
                      : integration
                        ? (language === 'ru' ? 'Подготовлен, выключен' : 'Prepared, disabled')
                        : (language === 'ru' ? 'Не подготовлен' : 'Not prepared')}
                </dd>
                {integration?.external_account_label ? (
                  <>
                    <dt>{language === 'ru' ? 'Метка' : 'Label'}</dt>
                    <dd>{integration.external_account_label}</dd>
                  </>
                ) : null}
              </dl>

              {inconsistent ? (
                <div className="notice warn" role="alert">
                  {language === 'ru'
                    ? 'Для этого мастера найдена неожиданная или дублированная WhatsApp-маршрутизация. CRM намеренно не исправляет её автоматически.'
                    : 'Unexpected or duplicate WhatsApp routing exists for this artist. The CRM deliberately refuses to repair it automatically.'}
                </div>
              ) : !integration ? (
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy || !api}
                    onClick={() => {
                      if (!api) return;
                      void run(artist.id, () => api.prepareWhatsAppIntegration(artist, supabaseUrl));
                    }}
                  >
                    {language === 'ru' ? 'Подготовить metadata' : 'Prepare metadata'}
                  </button>
                </div>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    className={integration.is_enabled ? undefined : 'primary'}
                    disabled={busy || !api}
                    onClick={() => {
                      if (!api) return;
                      void run(
                        artist.id,
                        () => api.setWhatsAppIntegrationEnabled(artist, supabaseUrl, !integration.is_enabled),
                      );
                    }}
                  >
                    {integration.is_enabled
                      ? (language === 'ru' ? 'Выключить маршрут' : 'Disable route')
                      : (language === 'ru' ? 'Включить маршрут' : 'Enable route')}
                  </button>
                </div>
              )}

              {productionOnboardingAvailable ? (
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
                        : (language === 'ru'
                            ? `Подключить WhatsApp ${artist.display_name}`
                            : `Connect ${artist.display_name} WhatsApp`)}
                  </button>
                </div>
              ) : null}

              <p className="notice" style={{ marginTop: 12 }}>
                {language === 'ru'
                  ? 'Подключение через Meta доступно пользователю с правом управления интеграциями этого мастера. Токены остаются в encrypted Worker bindings и не сохраняются в браузере или Postgres.'
                  : 'Meta connection is available to a user who can manage this artist\'s integrations. Tokens remain in encrypted Worker bindings and are never stored in the browser or Postgres.'}
              </p>
            </Section>
          );
        })
      )}
    </>
  );
}
