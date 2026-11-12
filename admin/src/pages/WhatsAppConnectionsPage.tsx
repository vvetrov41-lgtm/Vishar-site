import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useAsync } from '../components/AsyncData';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { useLanguage } from '../lib/i18n';
import { canShowArtistIntegration } from '../lib/integration-visibility';
import {
  describeWhatsAppEmbeddedSignupError,
  META_WHATSAPP_APP_ID,
  META_WHATSAPP_COEXISTENCE_CONFIG_ID,
} from '../lib/meta-whatsapp-embedded-signup';
import {
  beginEmbeddedSignupRedirect,
  takeEmbeddedSignupCallback,
} from '../lib/meta-whatsapp-signup-redirect';
import {
  beginBusinessReviewLogin,
  takeBusinessReviewCallback,
} from '../lib/meta-review-business-login';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import type { Artist } from '../lib/types';
import {
  whatsappCrmEnvironment,
  whatsappIntegrationKey,
  type MetaReviewTemplateMetadata,
  type WhatsAppIntegrationMetadata,
} from '../lib/whatsapp-connections-api';

interface ConnectionsData {
  artists: Artist[];
  integrations: WhatsAppIntegrationMetadata[];
  environment: 'production' | 'staging';
}

// Kristina's WABA is a WhatsApp Business app account that Meta refuses to
// let the CRM manage templates on (100/2494160) until the number is onboarded
// to Cloud API coexistence. Coexistence keeps the number, the Business app and
// its chats; the existing Embedded Signup flow already launches it
// (featureType whatsapp_business_app_onboarding) and never registers or
// migrates the number. Vladimir is already on coexistence and keeps only the
// token form, so a working connection cannot be replaced by accident.
const COEXISTENCE_RECONNECT_ARTISTS = new Set(['kristina']);

export function canOfferCoexistenceReconnect(
  artistSlug: string,
  productionOnboardingAvailable: boolean,
): boolean {
  return productionOnboardingAvailable && COEXISTENCE_RECONNECT_ARTISTS.has(artistSlug);
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
  const [existingMetaTokens, setExistingMetaTokens] = useState<Record<string, string>>({});
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewLoginBusy, setReviewLoginBusy] = useState(false);
  const [reviewLoginBusiness, setReviewLoginBusiness] = useState<{ business_id: string; business_name: string | null } | null>(null);
  const [reviewTemplate, setReviewTemplate] = useState<MetaReviewTemplateMetadata | null>(null);
  const [reviewBusiness, setReviewBusiness] = useState<{ business_id: string; waba_id: string; waba_name: string | null } | null>(null);
  const [reviewRecipient, setReviewRecipient] = useState('');
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
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

  async function runMetaReview(action: 'create' | 'delete' | 'status' | 'send' | 'business') {
    if (action === 'send') {
      if (reviewTemplate?.status !== 'APPROVED' || !/^[+]?[1-9][0-9]{7,14}$/.test(reviewRecipient)) {
        setActionError(language === 'ru'
          ? 'Нужен одобренный тестовый шаблон и номер получателя в международном формате.'
          : 'An approved review template and an international test recipient number are required.');
        return;
      }
      const approved = await confirmDialog({
        title: language === 'ru' ? 'Отправить тестовое WhatsApp?' : 'Send a test WhatsApp?',
        message: language === 'ru'
          ? `Отправить один тестовый шаблон на ${reviewRecipient}? Только если этот номер добавлен в Meta как тестовый получатель. Повторной отправки при ошибке не будет.`
          : `Send one review template to ${reviewRecipient}? The number must be a registered Meta test recipient. Failed or ambiguous sends will not be retried.`,
        confirmLabel: language === 'ru' ? 'Отправить один раз' : 'Send once',
        cancelLabel: cancelLabelFor(language),
      });
      if (!approved) return;
    }
    if (action === 'delete') {
      const approved = await confirmDialog({
        title: language === 'ru' ? 'Удалить тестовый шаблон?' : 'Delete the test template?',
        message: language === 'ru'
          ? 'Шаблон удалится из review WABA. Следующее создание получит новое имя.'
          : 'The template is removed from the review WABA. The next create will use a new name.',
        confirmLabel: language === 'ru' ? 'Удалить' : 'Delete',
        cancelLabel: cancelLabelFor(language),
        tone: 'danger',
      });
      if (!approved) return;
    }
    setReviewBusy(true);
    setActionError(null);
    setReviewMessage(null);
    try {
      if (!api || !data || data.environment !== 'production' || profile?.role !== 'owner') {
        throw new Error(language === 'ru'
          ? 'Проверка Meta App Review доступна только владельцу production CRM.'
          : 'Meta App Review controls are available only to the production CRM owner.');
      }
      const result = await api.manageMetaReviewTemplate(
        action,
        action === 'send' ? reviewRecipient : undefined,
        action === 'send' ? reviewTemplate?.name : undefined,
      );
      if (action === 'business') {
        setReviewBusiness(result.business ?? null);
        setReviewMessage(language === 'ru'
          ? 'Meta подтвердила принадлежность тестовой WABA бизнесу. Запрос только для чтения.'
          : 'Meta confirmed the review WABA belongs to the business. Read-only request.');
        return;
      }
      if (action === 'send') {
        setReviewMessage(language === 'ru'
          ? `Meta приняла тестовое сообщение: ${result.message_id}. Доставку проверь в WhatsApp получателя.`
          : `Meta accepted the test message: ${result.message_id}. Check delivery in the recipient's WhatsApp.`);
        return;
      }
      if (action === 'delete') {
        setReviewTemplate(null);
        setReviewMessage(language === 'ru'
          ? (result.deleted ? 'Тестовый шаблон удалён, readback подтвердил удаление.' : 'Тестового шаблона уже нет.')
          : (result.deleted ? 'Test template deleted and deletion confirmed by readback.' : 'The test template is already absent.'));
        return;
      }
      const template = result.template ?? null;
      setReviewTemplate(template);
      setReviewMessage(language === 'ru'
        ? (template
            ? `Readback Meta подтверждён: ${template.name}, статус ${template.status ?? 'unknown'}.`
            : 'Тестовый шаблон отсутствует в review WABA.')
        : (template
            ? `Meta readback confirmed: ${template.name}, status ${template.status ?? 'unknown'}.`
            : 'The test template is absent from the review WABA.'));
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (language === 'ru' ? 'Не удалось выполнить проверку Meta App Review.' : 'Could not run the Meta App Review check.'));
    } finally {
      setReviewBusy(false);
    }
  }

  async function connectExistingMetaAccount(artist: Artist) {
    setMetaBusyArtistId(artist.id);
    setActionError(null);
    setMetaMessage(null);
    const existingMetaToken = existingMetaTokens[artist.id] ?? '';
    try {
      if (
        !api
        || !data
        || data.environment !== 'production'
        || !['vladimir', 'kristina'].includes(artist.slug)
        || !canManageArtist(profile?.role, artist.id, memberships)
      ) {
        throw new Error(language === 'ru'
          ? 'Прямое подключение существующего WhatsApp недоступно в этой CRM-сессии.'
          : 'Existing WhatsApp connection is unavailable in this CRM session.');
      }
      const provisioned = await api.provisionExistingProductionWhatsApp(
        artist,
        supabaseUrl,
        existingMetaToken,
      );
      const identity = [provisioned.verified_name, provisioned.display_phone_number]
        .filter(Boolean)
        .join(' · ');
      setMetaMessage(
        language === 'ru'
          ? `WhatsApp ${artist.display_name} подключён${identity ? `: ${identity}` : ''}. Encrypted Worker bindings записаны.`
          : `${artist.display_name} WhatsApp connected${identity ? `: ${identity}` : ''}. Encrypted Worker bindings were written.`,
      );
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : (language === 'ru' ? 'Не удалось подключить WhatsApp.' : 'Could not connect WhatsApp.'));
    } finally {
      setExistingMetaTokens((current) => ({ ...current, [artist.id]: '' }));
      setMetaBusyArtistId(null);
    }
  }

  // Embedded Signup leaves the CRM: the page navigates to Meta's dialog in this
  // tab and Meta returns to the CRM root, where main.tsx captures the code.
  async function startMetaOnboarding(artist: Artist) {
    setActionError(null);
    setMetaMessage(null);
    if (
      !api
      || !data
      || data.environment !== 'production'
      || !canManageArtist(profile?.role, artist.id, memberships)
    ) {
      setActionError(language === 'ru'
        ? 'Подключение WhatsApp через Meta недоступно в этой сессии CRM.'
        : 'Production WhatsApp onboarding is unavailable in this CRM session.');
      return;
    }
    setMetaBusyArtistId(artist.id);
    try {
      if (artist.slug === 'kristina') {
        // A missing Meta webhook subscription must be fixed before QR/phone
        // approval; otherwise the one-time 24h sync could be lost.
        await api.checkCoexistenceWebhookReadiness(artist, supabaseUrl);
      }
      beginEmbeddedSignupRedirect(artist.id);
    } catch (cause) {
      setMetaBusyArtistId(null);
      const detail = cause instanceof Error ? cause.message : '';
      setActionError(detail.includes('meta_coexistence_webhook_fields_missing')
        ? (language === 'ru'
          ? 'Meta App не подписано на history / smb_app_state_sync / smb_message_echoes. Сначала настрой webhook-поля приложения, затем повтори подключение.'
          : 'Required Meta App webhook fields are missing. Enable history, smb_app_state_sync and smb_message_echoes before reconnecting.')
        : describeWhatsAppEmbeddedSignupError(cause, language));
    }
  }

  // Meta's redirect back: exchange the single-use code once, for the artist the
  // flow was started for, and only if this session may manage that artist.
  useEffect(() => {
    if (!api || !data || data.environment !== 'production') return;
    const callback = takeEmbeddedSignupCallback();
    if (!callback) return;
    if (callback.status === 'rejected') {
      setActionError(language === 'ru'
        ? `Ответ Meta отклонён (${callback.reason}). Запустите подключение заново.`
        : `Meta's response was refused (${callback.reason}). Start the connection again.`);
      return;
    }
    const artist = data.artists.find((candidate) => candidate.id === callback.artistId);
    if (!artist || !canManageArtist(profile?.role, artist.id, memberships)) {
      setActionError(language === 'ru'
        ? 'Подключение WhatsApp относится к мастеру, которым эта сессия не управляет.'
        : 'The WhatsApp connection belongs to an artist this session cannot manage.');
      return;
    }
    if (callback.status === 'cancelled') {
      setActionError(language === 'ru'
        ? `Подключение WhatsApp ${artist.display_name} отменено в Meta.`
        : `${artist.display_name} WhatsApp connection was cancelled in Meta.`);
      return;
    }
    setMetaBusyArtistId(artist.id);
    void api.provisionProductionWhatsApp(artist, supabaseUrl, {
      authorizationCode: callback.code,
      wabaId: null,
      phoneNumberId: null,
      event: 'CODE_ONLY',
      redirectFlow: 'crm_root',
    })
      .then((provisioned) => {
        const identity = [provisioned.verified_name, provisioned.display_phone_number]
          .filter(Boolean)
          .join(' · ');
        setMetaMessage(
          language === 'ru'
            ? `WhatsApp ${artist.display_name} подключён${identity ? `: ${identity}` : ''}. Оба encrypted Worker bindings записаны.`
            : `${artist.display_name} WhatsApp connected${identity ? `: ${identity}` : ''}. Both encrypted Worker bindings were written.`,
        );
        reload();
      })
      .catch((cause) => setActionError(describeWhatsAppEmbeddedSignupError(cause, language)))
      .finally(() => setMetaBusyArtistId(null));
  }, [api, data, language, memberships, profile?.role, reload, supabaseUrl]);

  async function startBusinessReviewLogin() {
    setActionError(null);
    setReviewMessage(null);
    setReviewLoginBusy(true);
    try {
      if (!api || !data || data.environment !== 'production' || profile?.role !== 'owner') {
        throw new Error('Meta App Review requires the production CRM owner.');
      }
      const config = await api.getBusinessReviewLoginConfig();
      beginBusinessReviewLogin(config.config_id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Meta business login unavailable.');
      setReviewLoginBusy(false);
    }
  }

  // The Meta callback is captured at root before the WhatsApp signup handler.
  // This path never calls the production provisioning methods.
  useEffect(() => {
    if (!api || !data || data.environment !== 'production' || profile?.role !== 'owner') return;
    const callback = takeBusinessReviewCallback();
    if (!callback) return;
    if (callback.status !== 'code') {
      setActionError(callback.status === 'cancelled'
        ? (language === 'ru' ? 'Вход Meta отменён.' : 'Meta login cancelled.')
        : `Meta business login rejected (${callback.reason}).`);
      return;
    }
    setReviewLoginBusy(true);
    setActionError(null);
    void api.completeBusinessReviewLogin(callback.code)
      .then((business) => {
        setReviewLoginBusiness(business);
        setReviewMessage(language === 'ru'
          ? 'Meta подтвердила разрешение business_management и вернула тестовый бизнес. Данные не сохранены.'
          : 'Meta confirmed business_management and returned the test business. No data was saved.');
      })
      .catch((cause) => setActionError(cause instanceof Error ? cause.message : 'Meta business login failed.'))
      .finally(() => setReviewLoginBusy(false));
  }, [api, data, language, profile?.role]);

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
              ? 'Здесь хранится только безопасная маршрутизация CRM. Постоянные токены после подключения уходят напрямую в encrypted Worker bindings и не сохраняются в Postgres.'
              : 'Only safe CRM routing metadata lives here. Persistent tokens go directly to encrypted Worker bindings and are never stored in Postgres.'}
          </p>
        </div>
        <div className="actions">
          <Link to="/integrations/calendar" className="badge">Google Calendar</Link>
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
            {language === 'ru' ? 'ID приложения Meta:' : 'Meta App ID:'} <code>{META_WHATSAPP_APP_ID}</code>
            {' · '}
            {language === 'ru' ? 'ID конфигурации Coexistence:' : 'Coexistence config ID:'} <code>{META_WHATSAPP_COEXISTENCE_CONFIG_ID}</code>
          </p>
        ) : null}
      </div>

      {metaMessage ? <div className="notice" role="status">{metaMessage}</div> : null}
      {reviewMessage ? <div className="notice" role="status">{reviewMessage}</div> : null}
      {actionError ? <div className="notice warn" role="alert">{actionError}</div> : null}

      {profile?.role === 'owner' && data.environment === 'production' ? (
        <Section title={language === 'ru' ? 'Meta App Review' : 'Meta App Review'}>
          <p className="notice">
            {language === 'ru'
              ? 'business_management: отдельный вход через Meta с выбором тестового бизнес-портфеля. CRM проверяет выданное разрешение и читает только заранее разрешённый тестовый бизнес. WhatsApp, WABA, номера и рабочие интеграции не меняются.'
              : 'business_management: separate Meta login for the isolated review business portfolio. The CRM verifies the permission and reads only the allowlisted test business. WhatsApp and live integrations are untouched.'}
          </p>
          <div className="actions">
            <button type="button" className="primary" disabled={reviewLoginBusy || !api}
              onClick={() => { void startBusinessReviewLogin(); }}>
              {reviewLoginBusy
                ? (language === 'ru' ? 'Проверяю вход…' : 'Checking Meta login…')
                : (language === 'ru' ? 'Войти через Meta (тестовый бизнес)' : 'Log in with Meta (test business)')}
            </button>
          </div>
          {reviewLoginBusiness ? (
            <dl className="definition" aria-live="polite">
              <dt>{language === 'ru' ? 'Выбранный бизнес' : 'Selected business'}</dt>
              <dd>{reviewLoginBusiness.business_name ?? '—'}</dd>
              <dt>Business ID</dt><dd><code>{reviewLoginBusiness.business_id}</code></dd>
              <dt>Permission</dt><dd><code>business_management: granted</code></dd>
            </dl>
          ) : null}
          <p className="notice">
            {language === 'ru'
              ? 'Отдельно: прежняя кнопка ниже использует серверный токен для проверки WABA, но не заменяет видео входа пользователя.'
              : 'Separately: the existing check below uses a server-side token to inspect the review WABA; it does not demonstrate user login.'}
          </p>
          <div className="actions">
            <button type="button" disabled={reviewBusy || !api} onClick={() => { void runMetaReview('business'); }}>
              {language === 'ru' ? 'Проверить тестовый бизнес' : 'Check review business'}
            </button>
          </div>
          {reviewBusiness ? (
            <dl className="definition" aria-live="polite">
              <dt>{language === 'ru' ? 'Бизнес ID' : 'Business ID'}</dt><dd><code>{reviewBusiness.business_id}</code></dd>
              <dt>{language === 'ru' ? 'Тестовая WABA ID' : 'Review WABA ID'}</dt><dd><code>{reviewBusiness.waba_id}</code></dd>
              <dt>{language === 'ru' ? 'Название' : 'Name'}</dt><dd>{reviewBusiness.waba_name ?? '—'}</dd>
            </dl>
          ) : null}
          <p className="notice">
            {language === 'ru'
              ? 'Изолированный сценарий для видео whatsapp_business_management. CRM может работать только с тестовыми шаблонами meta_review_permission_demo_<время> и только с review WABA, заданным на сервере. Клиентские данные и production WABA через этот экран выбрать нельзя.'
              : 'Isolated whatsapp_business_management review flow. The CRM can only operate on meta_review_permission_demo_<timestamp> test templates and the server-configured review WABA. Customer data and the production WABA cannot be selected here.'}
          </p>
          <dl className="definition">
            <dt>{language === 'ru' ? 'Шаблон' : 'Template'}</dt>
            <dd><code>{reviewTemplate?.name ?? 'meta_review_permission_demo_<timestamp>'}</code></dd>
            <dt>{language === 'ru' ? 'Readback' : 'Readback'}</dt>
            <dd>{reviewTemplate
              ? `${reviewTemplate.status ?? 'unknown'} · ${reviewTemplate.language} · ${reviewTemplate.category}`
              : (language === 'ru' ? 'Ещё не выполнен' : 'Not checked yet')}</dd>
          </dl>
          <div className="actions">
            <button type="button" disabled={reviewBusy || !api} onClick={() => { void runMetaReview('status'); }}>
              {reviewBusy ? (language === 'ru' ? 'Проверяю…' : 'Checking…') : (language === 'ru' ? 'Проверить шаблон' : 'Check template')}
            </button>
            <button type="button" className="primary" disabled={reviewBusy || !api} onClick={() => { void runMetaReview('create'); }}>
              {language === 'ru' ? 'Создать тестовый шаблон' : 'Create test template'}
            </button>
            <button type="button" disabled={reviewBusy || !api} onClick={() => { void runMetaReview('delete'); }}>
              {language === 'ru' ? 'Удалить тестовый шаблон' : 'Delete test template'}
            </button>
          </div>
          <p className="notice">
            {language === 'ru'
              ? 'Видео whatsapp_business_messaging: используй только номер, заранее добавленный в Meta как тестовый получатель. Отправка идёт с изолированного review WABA. Никаких повторов при ошибке.'
              : 'whatsapp_business_messaging demo: use only a recipient already registered in Meta for testing. Sending uses the isolated review WABA, with no retries.'}
          </p>
          <label htmlFor="meta-review-recipient">
            {language === 'ru' ? 'Тестовый получатель (+44…)' : 'Registered test recipient (+44…)'}
          </label>
          <input
            id="meta-review-recipient"
            type="tel"
            autoComplete="off"
            value={reviewRecipient}
            onChange={(event) => setReviewRecipient(event.target.value.trim())}
            placeholder="+44..."
            disabled={reviewBusy}
          />
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={reviewBusy || !api || reviewTemplate?.status !== 'APPROVED'
                || !/^[+]?[1-9][0-9]{7,14}$/.test(reviewRecipient)}
              onClick={() => { void runMetaReview('send'); }}
            >
              {language === 'ru' ? 'Отправить тестовое сообщение' : 'Send test message'}
            </button>
          </div>
        </Section>
      ) : null}

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
            && integration?.is_enabled === true;
          const existingAccountAvailable = productionOnboardingAvailable
            && (artist.slug === 'vladimir' || artist.slug === 'kristina');
          const existingMetaToken = existingMetaTokens[artist.id] ?? '';
          const coexistenceReconnectAvailable = canOfferCoexistenceReconnect(
            artist.slug,
            productionOnboardingAvailable,
          );

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
                      void run(artist.id, () => api.setWhatsAppIntegrationEnabled(artist, supabaseUrl, !integration.is_enabled));
                    }}
                  >
                    {integration.is_enabled
                      ? (language === 'ru' ? 'Выключить маршрут' : 'Disable route')
                      : (language === 'ru' ? 'Включить маршрут' : 'Enable route')}
                  </button>
                </div>
              )}

              {existingAccountAvailable ? (
                <form
                  style={{ marginTop: 12 }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (existingMetaToken.trim().length >= 40) {
                      void connectExistingMetaAccount(artist);
                    }
                  }}
                >
                  <label>
                    <span>{language === 'ru' ? 'System-user access token Meta' : 'Meta system-user access token'}</span>
                    <input
                      type="password"
                      value={existingMetaToken}
                      onChange={(event) => setExistingMetaTokens((current) => ({
                        ...current,
                        [artist.id]: event.target.value,
                      }))}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={metaBusyArtistId !== null}
                      placeholder={language === 'ru' ? 'Вставьте токен из Meta' : 'Paste the token from Meta'}
                    />
                  </label>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button
                      type="submit"
                      className="primary"
                      disabled={metaBusyArtistId !== null || existingMetaToken.trim().length < 40}
                    >
                      {metaBusy
                        ? (language === 'ru' ? 'Проверяю и подключаю…' : 'Verifying and connecting…')
                        : (language === 'ru' ? 'Подключить существующий WhatsApp' : 'Connect existing WhatsApp')}
                    </button>
                  </div>
                  <p className="notice" style={{ marginTop: 8 }}>
                    {language === 'ru'
                      ? 'Токен отправляется только на backend CRM по HTTPS, проверяется Meta и сразу записывается в artist-scoped encrypted Worker bindings. После попытки поле очищается.'
                      : 'The token is sent only to the CRM backend over HTTPS, verified with Meta, and written directly to artist-scoped encrypted Worker bindings. The field is cleared after the attempt.'}
                  </p>
                </form>
              ) : null}

              {coexistenceReconnectAvailable ? (
                <div style={{ marginTop: 12 }}>
                  <p className="notice">
                    {language === 'ru'
                      ? 'Coexistence: подключает этот же номер из приложения WhatsApp Business к Cloud API. Номер, приложение и переписки остаются у мастера; номер не перерегистрируется. После подключения Worker сам создаст шаблоны booking-карточек, а карточки включатся только после одобрения Meta.'
                      : 'Coexistence connects this same WhatsApp Business app number to Cloud API. The number, the app and its chats stay with the artist; the number is not re-registered. Afterwards the Worker creates the booking-card templates itself, and cards switch on only once Meta approves them.'}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={metaBusyArtistId !== null}
                      onClick={() => startMetaOnboarding(artist)}
                    >
                      {metaBusy
                        ? (language === 'ru' ? 'Подключаю…' : 'Connecting…')
                        : (language === 'ru'
                          ? `Подключить WhatsApp Business App ${artist.display_name} (Coexistence)`
                          : `Connect ${artist.display_name} WhatsApp Business app (Coexistence)`)}
                    </button>
                  </div>
                </div>
              ) : !existingAccountAvailable && productionOnboardingAvailable ? (
                <div className="actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={metaBusyArtistId !== null}
                    onClick={() => startMetaOnboarding(artist)}
                  >
                    {metaBusy
                      ? (language === 'ru' ? 'Подключаю…' : 'Connecting…')
                      : (language === 'ru'
                        ? `Подключить WhatsApp ${artist.display_name}`
                        : `Connect ${artist.display_name} WhatsApp`)}
                  </button>
                </div>
              ) : null}

              {!existingAccountAvailable ? (
                <p className="notice" style={{ marginTop: 12 }}>
                  {language === 'ru'
                    ? 'Подключение через Meta доступно пользователю с правом управления интеграциями этого мастера. Токены остаются в encrypted Worker bindings и не сохраняются в браузере или Postgres.'
                    : 'Meta connection is available to a user who can manage this artist\'s integrations. Tokens remain in encrypted Worker bindings and are never stored in the browser or Postgres.'}
                </p>
              ) : null}
            </Section>
          );
        })
      )}
    </>
  );
}
