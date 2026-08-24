import { ApiError, type CrmClient } from './api';

export type TelegramDestinationKind = 'profile' | 'artist';

export interface TelegramDestinationStatus {
  destination_kind: TelegramDestinationKind;
  artist_id: string | null;
  target_label: string;
  is_connected: boolean;
  safe_label: string | null;
  connected_at: string | null;
}

export interface TelegramLinkChallenge {
  link_token: string;
  expires_at: string;
  destination_kind: TelegramDestinationKind;
  artist_id: string | null;
  target_label: string;
}

const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const LINK_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

function singleRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.length === 1 && value[0] && typeof value[0] === 'object'
    ? value[0] as Record<string, unknown>
    : null;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function assertDestination(value: unknown): TelegramDestinationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('Could not load Telegram connections.');
  }
  const row = value as Record<string, unknown>;
  const kind = row.destination_kind;
  if (
    (kind !== 'profile' && kind !== 'artist')
    || (kind === 'profile' && row.artist_id !== null)
    || (kind === 'artist' && typeof row.artist_id !== 'string')
    || typeof row.target_label !== 'string'
    || row.target_label.trim() === ''
    || typeof row.is_connected !== 'boolean'
    || (row.safe_label !== null && typeof row.safe_label !== 'string')
    || (row.connected_at !== null && typeof row.connected_at !== 'string')
    || 'chat_id' in row
  ) {
    throw new ApiError('Could not load Telegram connections.');
  }
  return row as unknown as TelegramDestinationStatus;
}

function assertChallenge(value: unknown): TelegramLinkChallenge {
  const row = singleRow(value);
  if (!row) throw new ApiError('Telegram linking returned an invalid response.');
  const kind = row.destination_kind;
  if (
    typeof row.link_token !== 'string'
    || !LINK_TOKEN.test(row.link_token)
    || typeof row.expires_at !== 'string'
    || (kind !== 'profile' && kind !== 'artist')
    || (kind === 'profile' && row.artist_id !== null)
    || (kind === 'artist' && typeof row.artist_id !== 'string')
    || typeof row.target_label !== 'string'
    || row.target_label.trim() === ''
    || 'chat_id' in row
  ) {
    throw new ApiError('Telegram linking returned an invalid response.');
  }
  return row as unknown as TelegramLinkChallenge;
}

function telegramLinkParts(
  botUsername: string,
  challenge: Pick<TelegramLinkChallenge, 'link_token' | 'destination_kind'>,
): { username: string; token: string } {
  const username = botUsername.trim().replace(/^@/, '');
  if (!BOT_USERNAME.test(username) || !LINK_TOKEN.test(challenge.link_token)) {
    throw new ApiError('Telegram linking is not configured correctly.');
  }
  return { username, token: challenge.link_token };
}

export function telegramStartUrl(
  botUsername: string,
  challenge: Pick<TelegramLinkChallenge, 'link_token' | 'destination_kind'>,
): string {
  const { username, token } = telegramLinkParts(botUsername, challenge);
  const url = new URL(`https://t.me/${username}`);
  url.searchParams.set(
    challenge.destination_kind === 'artist' ? 'startgroup' : 'start',
    token,
  );
  return url.toString();
}

export function telegramStartCommand(
  botUsername: string,
  challenge: Pick<TelegramLinkChallenge, 'link_token' | 'destination_kind'>,
): string {
  const { username, token } = telegramLinkParts(botUsername, challenge);
  return challenge.destination_kind === 'artist'
    ? `/start@${username} ${token}`
    : `/start ${token}`;
}

export function createTelegramConnectionsApi(client: CrmClient) {
  return {
    async getTelegramConnectorInfo(): Promise<{ bot_username: string | null }> {
      const result = await client.rpc('get_telegram_connector_info');
      if (result.error) throw new ApiError('Could not load Telegram connector information.', result.error);
      const row = singleRow(result.data);
      if (!row || (row.bot_username !== null && (typeof row.bot_username !== 'string' || !BOT_USERNAME.test(row.bot_username)))) {
        throw new ApiError('Could not load Telegram connector information.');
      }
      return { bot_username: row.bot_username as string | null };
    },

    async listTelegramDestinations(): Promise<TelegramDestinationStatus[]> {
      const result = await client.rpc('list_telegram_destinations');
      if (result.error) throw new ApiError('Could not load Telegram connections.', result.error);
      if (!Array.isArray(result.data)) throw new ApiError('Could not load Telegram connections.');
      return result.data.map(assertDestination);
    },

    async getTelegramNotificationsEnabled(): Promise<boolean> {
      const result = await client
        .from('notification_preferences')
        .select('is_enabled')
        .eq('channel', 'telegram')
        .maybeSingle();
      if (result.error) throw new ApiError('Could not load Telegram notification preference.', result.error);
      if (result.data == null) return false;
      if (typeof result.data?.is_enabled !== 'boolean') {
        throw new ApiError('Could not load Telegram notification preference.');
      }
      return result.data.is_enabled;
    },

    async beginTelegramLink(
      destinationKind: TelegramDestinationKind,
      artistId: string | null = null,
    ): Promise<TelegramLinkChallenge> {
      if (destinationKind === 'profile' && artistId !== null) {
        throw new ApiError('A personal Telegram connection cannot name an artist.');
      }
      if (destinationKind === 'artist' && !artistId) {
        throw new ApiError('Choose an artist before connecting a shared Telegram group.');
      }
      const result = await client.rpc('begin_telegram_link', {
        p_destination_kind: destinationKind,
        p_artist_id: artistId,
      });
      if (result.error) throw new ApiError('Could not create a Telegram connection link.', result.error);
      const challenge = assertChallenge(result.data);
      if (challenge.destination_kind !== destinationKind || challenge.artist_id !== artistId) {
        throw new ApiError('Telegram linking returned the wrong target.');
      }
      return challenge;
    },

    async disconnectTelegramDestination(
      destinationKind: TelegramDestinationKind,
      artistId: string | null = null,
    ): Promise<boolean> {
      const result = await client.rpc('disconnect_telegram_destination', {
        p_destination_kind: destinationKind,
        p_artist_id: artistId,
      });
      if (result.error) throw new ApiError('Could not disconnect Telegram.', result.error);
      return result.data === true;
    },

    async setTelegramNotificationsEnabled(enabled: boolean): Promise<void> {
      const result = await client.rpc('set_notification_preference', {
        p_channel: 'telegram',
        p_is_enabled: enabled,
      });
      if (result.error) throw new ApiError('Could not update Telegram notifications.', result.error);
    },

    async configureTelegramBotUsername(botUsername: string): Promise<string | null> {
      const username = botUsername.trim().replace(/^@/, '');
      if (username && !BOT_USERNAME.test(username)) {
        throw new ApiError('Enter a valid Telegram bot username.');
      }
      const result = await client.rpc('configure_telegram_connector_identity', {
        p_bot_username: username || null,
      });
      if (result.error) throw new ApiError('Could not update the Telegram bot username.', result.error);
      if (result.data !== null && (typeof result.data !== 'string' || !BOT_USERNAME.test(result.data))) {
        throw new ApiError('Telegram returned an invalid bot username.');
      }
      return result.data as string | null;
    },
  };
}

export type TelegramConnectionsApi = ReturnType<typeof createTelegramConnectionsApi>;
