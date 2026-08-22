import { useState } from 'react';
import { ErrorState } from './StateViews';
import { useLanguage } from '../lib/i18n';
import {
  telegramStartUrl,
  type TelegramDestinationStatus,
  type TelegramLinkChallenge,
} from '../lib/telegram-connections-api';
import { useApi } from '../lib/session';

export function TelegramConnectionCard({
  destination,
  botUsername,
  onChanged,
}: {
  destination: TelegramDestinationStatus;
  botUsername: string | null;
  onChanged: () => void;
}) {
  const api = useApi();
  const { language } = useLanguage();
  const [challenge, setChallenge] = useState<TelegramLinkChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startLink = challenge && botUsername
    ? telegramStartUrl(botUsername, challenge)
    : null;

  async function beginLink() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.beginTelegramLink(
        destination.destination_kind,
        destination.artist_id,
      );
      setChallenge(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Telegram linking.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectTelegramDestination(
        destination.destination_kind,
        destination.artist_id,
      );
      setChallenge(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect Telegram.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-telegram-kind={destination.destination_kind}>
      <div className="card-header">
        <strong>{destination.target_label}</strong>
        <span className={`badge badge-${destination.is_connected ? 'connected' : 'not_connected'}`}>
          {destination.is_connected
            ? (language === 'ru' ? 'Подключено' : 'Connected')
            : (language === 'ru' ? 'Не подключено' : 'Not connected')}
        </span>
      </div>

      {destination.is_connected ? (
        <p className="muted">
          {destination.safe_label ?? (language === 'ru' ? 'Telegram подключён' : 'Telegram connected')}
          {destination.connected_at ? ` · ${formatDate(destination.connected_at, language)}` : ''}
        </p>
      ) : (
        <p className="muted">
          {destination.destination_kind === 'profile'
            ? (language === 'ru'
              ? 'Личный чат получает только ваши персональные уведомления CRM.'
              : 'Your private chat receives only personal CRM notifications addressed to you.')
            : (language === 'ru'
              ? 'Группа используется как общий Telegram-канал выбранного мастера.'
              : 'A group is used as the selected artist’s shared Telegram destination.')}
        </p>
      )}

      {!botUsername ? (
        <p className="muted">
          {language === 'ru'
            ? 'Общий Telegram-бот ещё не настроен владельцем CRM.'
            : 'The shared Telegram bot has not been configured by the CRM owner yet.'}
        </p>
      ) : null}

      {error ? <ErrorState message={error} /> : null}

      {challenge && startLink ? (
        <div className="stack">
          <p className="muted">
            {destination.destination_kind === 'profile'
              ? (language === 'ru'
                ? 'Откройте Telegram и нажмите Start. Ссылка одноразовая и действует 10 минут.'
                : 'Open Telegram and press Start. The link is single-use and expires in 10 minutes.')
              : (language === 'ru'
                ? 'Откройте Telegram, выберите группу и добавьте в неё бота. Ссылка одноразовая и действует 10 минут.'
                : 'Open Telegram, choose the group and add the bot. The link is single-use and expires in 10 minutes.')}
          </p>
          <div className="actions">
            <a href={startLink} target="_blank" rel="noreferrer">
              {language === 'ru' ? 'Открыть Telegram' : 'Open Telegram'}
            </a>
            <button type="button" disabled={busy} onClick={onChanged}>
              {language === 'ru' ? 'Проверить статус' : 'Refresh status'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="actions">
        <button type="button" disabled={busy || !botUsername} onClick={() => { void beginLink(); }}>
          {destination.is_connected
            ? (language === 'ru' ? 'Подключить заново' : 'Reconnect')
            : (language === 'ru' ? 'Подключить' : 'Connect')}
        </button>
        {destination.is_connected ? (
          <button type="button" disabled={busy} onClick={() => { void disconnect(); }}>
            {language === 'ru' ? 'Отключить' : 'Disconnect'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatDate(value: string, language: 'en' | 'ru'): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
