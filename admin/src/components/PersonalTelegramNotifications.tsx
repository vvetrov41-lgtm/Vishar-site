import { useState } from 'react';
import { useAsync } from './AsyncData';
import { TelegramConnectionCard } from './TelegramConnectionCard';
import { ErrorState, LoadingState, Section } from './StateViews';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';

/**
 * The single user-facing Telegram notification configuration surface.
 *
 * Both Notifications and Integrations render this component so connection
 * state and the delivery preference cannot drift into separate UX models.
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
    <Section title={language === 'ru' ? 'Личные уведомления' : 'Personal delivery'}>
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
                <strong>{language === 'ru' ? 'Доставка уведомлений' : 'Notification delivery'}</strong>
                <span className={`badge badge-${state.data?.notificationsEnabled ? 'connected' : 'not_connected'}`}>
                  {state.data?.notificationsEnabled
                    ? (language === 'ru' ? 'Включена' : 'Enabled')
                    : (language === 'ru' ? 'Выключена' : 'Disabled')}
                </span>
              </div>
              <p className="muted">
                {language === 'ru'
                  ? 'В CRM уведомления остаются всегда. Telegram является дополнительным личным каналом доставки.'
                  : 'Notifications always remain in the CRM. Telegram is an optional personal delivery channel.'}
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || state.data?.notificationsEnabled === true}
                  onClick={() => { void setNotifications(true); }}
                >
                  {language === 'ru' ? 'Включить Telegram' : 'Enable Telegram'}
                </button>
                <button
                  type="button"
                  disabled={busy || state.data?.notificationsEnabled !== true}
                  onClick={() => { void setNotifications(false); }}
                >
                  {language === 'ru' ? 'Выключить Telegram' : 'Disable Telegram'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
