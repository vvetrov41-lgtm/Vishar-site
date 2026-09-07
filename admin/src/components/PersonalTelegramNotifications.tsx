import { useState } from 'react';
import { useAsync } from './AsyncData';
import { TelegramConnectionCard } from './TelegramConnectionCard';
import { ErrorState, LoadingState, Section } from './StateViews';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';

/**
 * Personal Telegram delivery for the signed-in profile.
 *
 * This is intentionally different from an artist-bound destination: personal
 * CRM reminders can be mirrored here, while new enquiries are routed to the
 * artist Telegram configured alongside it on the Notifications page.
 */
export function PersonalTelegramNotifications() {
  const api = useApi();
  const { language } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = useAsync(async () => {
    const [info, destinations, notificationsEnabled] = await Promise.all([
      api.getTelegramConnectorInfo(),
      api.listTelegramDestinations(),
      api.getTelegramNotificationsEnabled(),
    ]);
    return { info, destinations, notificationsEnabled };
  }, [api]);

  async function setNotifications(enabled: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await api.setTelegramNotificationsEnabled(enabled);
      state.reload();
    } catch (cause) {
      setActionError(cause instanceof Error
        ? cause.message
        : (language === 'ru'
          ? 'Не удалось изменить настройки уведомлений Telegram.'
          : 'Could not update Telegram notifications.'));
    } finally {
      setBusy(false);
    }
  }

  const personalTelegram = state.data?.destinations.find(
    (destination) => destination.destination_kind === 'profile',
  ) ?? null;

  return (
    <Section title={language === 'ru' ? 'Личный Telegram' : 'Personal Telegram'}>
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && personalTelegram ? (
        <div className="stack" data-personal-telegram-notifications>
          <TelegramConnectionCard
            destination={personalTelegram}
            botUsername={state.data?.info.bot_username ?? null}
            onChanged={state.reload}
          />
          {actionError ? <ErrorState message={actionError} /> : null}
          {personalTelegram.is_connected ? (
            <div className="card">
              <div className="card-header">
                <strong>{language === 'ru' ? 'Личные CRM-уведомления' : 'Personal CRM notifications'}</strong>
                <span className={`badge badge-${state.data?.notificationsEnabled ? 'connected' : 'not_connected'}`}>
                  {state.data?.notificationsEnabled
                    ? (language === 'ru' ? 'Включены' : 'Enabled')
                    : (language === 'ru' ? 'Выключены' : 'Disabled')}
                </span>
              </div>
              <p className="muted">
                {language === 'ru'
                  ? 'Здесь включается только личная доставка уведомлений CRM. Новые заявки отправляются в Telegram, настроенный для мастера.'
                  : 'This controls only personal CRM notification delivery. New enquiries are sent to the Telegram destination configured for the artist.'}
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || state.data?.notificationsEnabled === true}
                  onClick={() => { void setNotifications(true); }}
                >
                  {language === 'ru' ? 'Включить личный Telegram' : 'Enable personal Telegram'}
                </button>
                <button
                  type="button"
                  disabled={busy || state.data?.notificationsEnabled !== true}
                  onClick={() => { void setNotifications(false); }}
                >
                  {language === 'ru' ? 'Выключить личный Telegram' : 'Disable personal Telegram'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
