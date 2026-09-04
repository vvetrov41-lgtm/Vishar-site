import { useEffect, useState } from 'react';
import { ErrorState } from './StateViews';
import { useLanguage } from '../lib/i18n';
import {
  telegramStartCommand,
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
  const [currentDestination, setCurrentDestination] = useState(destination);
  const [challenge, setChallenge] = useState<TelegramLinkChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);

  useEffect(() => {
    setCurrentDestination(destination);
  }, [destination]);

  useEffect(() => {
    if (!challenge) return undefined;

    const expiresAt = Date.parse(challenge.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      setChallenge(null);
      setCommandCopied(false);
      setStatusMessage(language === 'ru'
        ? 'Ссылка подключения истекла. Создайте новую ссылку.'
        : 'The linking link expired. Create a new link.');
      return undefined;
    }

    let cancelled = false;
    const expireTimer = window.setTimeout(() => {
      if (cancelled) return;
      setChallenge(null);
      setCommandCopied(false);
      setStatusMessage(language === 'ru'
        ? 'Ссылка подключения истекла. Создайте новую ссылку.'
        : 'The linking link expired. Create a new link.');
    }, Math.min(expiresAt - Date.now(), 2_147_483_647));

    const pollStatus = async () => {
      try {
        const destinations = await api.listTelegramDestinations();
        if (cancelled) return;
        const next = destinations.find((candidate) => (
          candidate.destination_kind === currentDestination.destination_kind
          && candidate.artist_id === currentDestination.artist_id
        ));
        if (!next) return;
        setCurrentDestination(next);
        if (!next.is_connected) return;

        setChallenge(null);
        setCommandCopied(false);
        setStatusMessage(language === 'ru' ? 'Подключение подтверждено.' : 'Connection confirmed.');
        if (next.destination_kind === 'profile') onChanged();
      } catch {
        // Linking remains usable when a background status read fails. The
        // explicit status button below still reports errors to the operator.
      }
    };

    const pollTimer = window.setInterval(() => { void pollStatus(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(expireTimer);
      window.clearInterval(pollTimer);
    };
  }, [api, challenge, currentDestination.artist_id, currentDestination.destination_kind, language, onChanged]);

  const startLink = challenge && botUsername
    ? telegramStartUrl(botUsername, challenge)
    : null;
  const startCommand = challenge && botUsername && challenge.destination_kind === 'artist'
    ? telegramStartCommand(botUsername, challenge)
    : null;

  async function beginLink() {
    if (challenge) return;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    setCommandCopied(false);
    try {
      const next = await api.beginTelegramLink(
        currentDestination.destination_kind,
        currentDestination.artist_id,
      );
      setChallenge(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Telegram linking.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const destinations = await api.listTelegramDestinations();
      const next = destinations.find((candidate) => (
        candidate.destination_kind === currentDestination.destination_kind
        && candidate.artist_id === currentDestination.artist_id
      ));
      if (!next) {
        throw new Error('Could not find this Telegram connection.');
      }
      setCurrentDestination(next);

      if (next.is_connected) {
        setChallenge(null);
        setCommandCopied(false);
        setStatusMessage(language === 'ru' ? 'Подключение подтверждено.' : 'Connection confirmed.');

        // Personal Telegram has adjacent delivery controls owned by the parent
        // page, so let that page refresh after a successful link. Artist cards
        // intentionally stay local here: a full page reload was causing the
        // reported jump-to-top defect on mobile.
        if (next.destination_kind === 'profile') onChanged();
      } else {
        setStatusMessage(
          next.destination_kind === 'artist'
            ? (language === 'ru'
              ? 'Пока не подключено. Используйте текущую ссылку ниже. Не создавайте новую, потому что новая ссылка отменит предыдущую.'
              : 'Not connected yet. Keep using the current link below. Do not create another one because a new link cancels the previous link.')
            : (language === 'ru'
              ? 'Пока не подключено. Завершите запуск бота по текущей ссылке и проверьте ещё раз.'
              : 'Not connected yet. Finish starting the bot from the current link and check again.'),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh Telegram status.');
    } finally {
      setBusy(false);
    }
  }

  async function copyLinkCommand() {
    if (!startCommand) return;
    setError(null);
    setCommandCopied(false);
    try {
      await copyText(startCommand);
      setCommandCopied(true);
    } catch {
      setError(language === 'ru'
        ? 'Не удалось скопировать команду. Откройте Telegram и попробуйте текущую ссылку подключения ещё раз.'
        : 'Could not copy the command. Open Telegram and try the current linking link again.');
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      await api.disconnectTelegramDestination(
        currentDestination.destination_kind,
        currentDestination.artist_id,
      );
      setChallenge(null);
      setCommandCopied(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect Telegram.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-telegram-kind={currentDestination.destination_kind}>
      <div className="card-header">
        <strong>{currentDestination.target_label}</strong>
        <span className={`badge badge-${currentDestination.is_connected ? 'connected' : 'not_connected'}`}>
          {currentDestination.is_connected
            ? (language === 'ru' ? 'Подключено' : 'Connected')
            : (language === 'ru' ? 'Не подключено' : 'Not connected')}
        </span>
      </div>

      {currentDestination.is_connected ? (
        <p className="muted">
          {currentDestination.safe_label ?? (language === 'ru' ? 'Telegram подключён' : 'Telegram connected')}
          {currentDestination.connected_at ? ` · ${formatDate(currentDestination.connected_at, language)}` : ''}
        </p>
      ) : (
        <p className="muted">
          {currentDestination.destination_kind === 'profile'
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
      {statusMessage ? <p className="muted" role="status">{statusMessage}</p> : null}

      {challenge && startLink ? (
        <div className="stack">
          <p className="muted">
            {currentDestination.destination_kind === 'profile'
              ? (language === 'ru'
                ? 'Откройте Telegram и нажмите Start. Пока эта ссылка действует, CRM не создаст вторую и не отменит её.'
                : 'Open Telegram and press Start. While this link is active, CRM will not create a second link and cancel it.')
              : (language === 'ru'
                ? 'Откройте Telegram, выберите группу и добавьте в неё бота. Если iPhone не показывает выбор группы, используйте кнопку «Скопировать команду». Пока эта ссылка действует, CRM не создаст вторую и не отменит её.'
                : 'Open Telegram, choose the group and add the bot. If iPhone does not show group selection, use Copy linking command. While this link is active, CRM will not create a second link and cancel it.')}
          </p>
          <div className="actions">
            <a href={startLink} target="_blank" rel="noreferrer">
              {language === 'ru' ? 'Открыть Telegram' : 'Open Telegram'}
            </a>
            <button type="button" disabled={busy} onClick={() => { void refreshStatus(); }}>
              {language === 'ru' ? 'Проверить статус' : 'Refresh status'}
            </button>
            {startCommand ? (
              <button type="button" disabled={busy} onClick={() => { void copyLinkCommand(); }}>
                {language === 'ru' ? 'Скопировать команду' : 'Copy linking command'}
              </button>
            ) : null}
          </div>
          {commandCopied ? (
            <p className="muted" role="status">
              {language === 'ru'
                ? 'Команда скопирована. Вставьте и отправьте её внутри нужной Telegram-группы.'
                : 'Command copied. Paste and send it inside the target Telegram group.'}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="actions">
        {!challenge ? (
          <button type="button" disabled={busy || !botUsername} onClick={() => { void beginLink(); }}>
            {currentDestination.is_connected
              ? (language === 'ru' ? 'Подключить заново' : 'Reconnect')
              : (language === 'ru' ? 'Подключить' : 'Connect')}
          </button>
        ) : null}
        {currentDestination.is_connected ? (
          <button type="button" disabled={busy} onClick={() => { void disconnect(); }}>
            {language === 'ru' ? 'Отключить' : 'Disconnect'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard copy failed.');
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
