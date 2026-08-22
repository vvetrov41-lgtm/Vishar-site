import { useEffect, useState } from 'react';
import { TelegramConnectionCard } from '../components/TelegramConnectionCard';
import { useAsync } from '../components/AsyncData';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { useLanguage } from '../lib/i18n';
import { useApi, useSession } from '../lib/session';

export function TelegramConnectionsPage() {
  const api = useApi();
  const { profile } = useSession();
  const { language } = useLanguage();
  const state = useAsync(async () => {
    const [info, destinations] = await Promise.all([
      api.getTelegramConnectorInfo(),
      api.listTelegramDestinations(),
    ]);
    return { info, destinations };
  }, [api]);
  const [botUsername, setBotUsername] = useState('');
  const [savingBot, setSavingBot] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);

  useEffect(() => {
    setBotUsername(state.data?.info.bot_username ?? '');
  }, [state.data?.info.bot_username]);

  async function saveBotIdentity() {
    setSavingBot(true);
    setBotError(null);
    try {
      await api.configureTelegramBotUsername(botUsername);
      state.reload();
    } catch (cause) {
      setBotError(cause instanceof Error ? cause.message : 'Could not update Telegram bot identity.');
    } finally {
      setSavingBot(false);
    }
  }

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const connectorUsername = state.data?.info.bot_username ?? null;
  const artistDestinations = (state.data?.destinations ?? [])
    .filter((destination) => destination.destination_kind === 'artist');

  return (
    <div className="stack">
      {profile?.role === 'owner' ? (
        <Section title={language === 'ru' ? 'Общий Telegram-бот' : 'Shared Telegram bot'}>
          <div className="card">
            <p className="muted">
              {language === 'ru'
                ? 'Это публичное имя бота, без токена. Оно используется только для создания безопасных одноразовых ссылок подключения.'
                : 'This is the bot’s public username, not its token. It is used only to build safe single-use linking links.'}
            </p>
            <label>
              {language === 'ru' ? 'Username бота' : 'Bot username'}
              <input
                value={botUsername}
                onChange={(event) => setBotUsername(event.target.value)}
                placeholder="vishar_crm_bot"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            {botError ? <ErrorState message={botError} /> : null}
            <div className="actions">
              <button type="button" disabled={savingBot} onClick={() => { void saveBotIdentity(); }}>
                {language === 'ru' ? 'Сохранить' : 'Save'}
              </button>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title={language === 'ru' ? 'Telegram мастеров' : 'Artist Telegram'}>
        {artistDestinations.length === 0 ? (
          <EmptyState
            title={language === 'ru' ? 'Нет доступных мастеров' : 'No manageable artists'}
            hint={language === 'ru'
              ? 'Здесь появляются только мастера, для которых у вас есть право управлять интеграциями.'
              : 'Only artists whose integrations you may manage appear here.'}
          />
        ) : (
          <div className="stack">
            {artistDestinations.map((destination) => (
              <TelegramConnectionCard
                key={destination.artist_id ?? destination.target_label}
                destination={destination}
                botUsername={connectorUsername}
                onChanged={state.reload}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
