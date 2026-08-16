import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useAsync } from '../components/AsyncData';
import { useLanguage } from '../lib/i18n';
import { launchWhatsAppEmbeddedSignup } from '../lib/meta-whatsapp-embedded-signup';
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

function canManageArtist(
  role: string | null | undefined,
  artistId: string,
  memberships: ReturnType<typeof useSession>['memberships'],
): boolean {
  if (role === 'owner') return true;
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
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaMessage, setMetaMessage] = useState<string | null>(null);
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();

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
        (artist) => artist.is_active && canManageArtist(profile?.role, artist.id, memberships),
      ),
    };
  }, [api, memberships, profile?.role, supabaseUrl]);

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

  async function startMetaOnboarding() {
    setMetaBusy(true);
    setActionError(null);
    setMetaMessage(null);
    try {
      const result = await launchWhatsAppEmbeddedSignup();
      if (!result.authorizationCode) throw new Error('Meta returned no authorization code.');
      setMetaMessage(
        language === 'ru'
          ? 'Meta onboarding завершён в браузере. Код авторизации не сохранён. Следующий этап - безопасный server-side обмен кода и проверка artist-scoped binding.'
          : 'Meta onboarding completed in the browser. The authorization code was not persisted. Next: secure server-side code exchange and artist-scoped binding verification.',
      );
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : language === 'ru'
            ? 'Не удалось запустить Meta Embedded Signup.'
            : 'Could not start Meta Embedded Signup.',
      );
    } finally {
      setMetaBusy(false);
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
        {language === 'ru'
          ? `Среда CRM: ${data.environment}. Включайте маршрут только после отдельной проверки Meta и encrypted Worker bindings.`
          : `CRM environment: ${data.environment}. Enable a route only after the Meta account and encrypted Worker bindings have been verified separately.`}
      </div>

      {profile?.role === 'owner' ? (
        <Section title={language === 'ru' ? 'Подключение существующего WhatsApp Business' : 'Connect an existing WhatsApp Business app'}>
          <p>
            {language === 'ru'
              ? 'Запускает официальный Meta Embedded Signup в режиме WhatsApp Business App onboarding. Номер не выбирается CRM и не мигрируется автоматически.'
              : 'Launches Meta Embedded Signup in WhatsApp Business App onboarding mode. The CRM does not choose a number or migrate it automatically.'}
          </p>
          <div className="actions">
            <button type="button" className="primary" disabled={metaBusy} onClick={() => { void startMetaOnboarding(); }}>
              {metaBusy
                ? (language === 'ru' ? 'Открываю Meta…' : 'Opening Meta…')
                : (language === 'ru' ? 'Подключить через Meta' : 'Connect with Meta')}
            </button>
          </div>
          <p className="notice" style={{ marginTop: 12 }}>
            {language === 'ru'
              ? 'Доступно только owner. Authorization code остаётся только в памяти браузера и не показывается в интерфейсе или логах.'
              : 'Owner only. The authorization code remains in browser memory and is never displayed or logged.'}
          </p>
          {metaMessage ? <div className="notice" role="status">{metaMessage}</div> : null}
        </Section>
      ) : null}

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

              <p className="notice" style={{ marginTop: 12 }}>
                {language === 'ru'
                  ? 'Статус Enabled означает только, что CRM может выбрать этот artist-scoped маршрут. Наличие Meta credentials подтверждается отдельно в Cloudflare и production rollout.'
                  : 'Enabled means only that CRM may select this artist-scoped route. Meta credentials are verified separately in Cloudflare and the production rollout.'}
              </p>
            </Section>
          );
        })
      )}
    </>
  );
}
