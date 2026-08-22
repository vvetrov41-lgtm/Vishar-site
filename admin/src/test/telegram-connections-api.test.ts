import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import {
  createTelegramConnectionsApi,
  telegramStartUrl,
} from '../lib/telegram-connections-api';

function rpcClient(response: { data: unknown; error: unknown } = { data: null, error: null }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as CrmClient, rpc };
}

describe('Telegram self-service API boundary', () => {
  it('builds private and group links with different Telegram deep-link parameters', () => {
    const profile = telegramStartUrl('vishar_crm_bot', {
      link_token: '12345678901234567890abcdef',
      destination_kind: 'profile',
    });
    const artist = telegramStartUrl('@vishar_crm_bot', {
      link_token: 'abcdef12345678901234567890',
      destination_kind: 'artist',
    });

    expect(new URL(profile).searchParams.get('start')).toBe('12345678901234567890abcdef');
    expect(new URL(profile).searchParams.has('startgroup')).toBe(false);
    expect(new URL(artist).searchParams.get('startgroup')).toBe('abcdef12345678901234567890');
    expect(new URL(artist).searchParams.has('start')).toBe(false);
  });

  it('loads only the public bot username', async () => {
    const { client, rpc } = rpcClient({ data: [{ bot_username: 'vishar_crm_bot' }], error: null });
    const api = createTelegramConnectionsApi(client);

    await expect(api.getTelegramConnectorInfo()).resolves.toEqual({ bot_username: 'vishar_crm_bot' });
    expect(rpc).toHaveBeenCalledWith('get_telegram_connector_info');
  });

  it('accepts safe destination metadata but rejects a leaked chat id', async () => {
    const safe = rpcClient({
      data: [{
        destination_kind: 'profile',
        artist_id: null,
        target_label: 'Personal Telegram',
        is_connected: true,
        safe_label: 'Personal Telegram',
        connected_at: '2026-08-22T12:00:00Z',
      }],
      error: null,
    });
    await expect(createTelegramConnectionsApi(safe.client).listTelegramDestinations()).resolves.toHaveLength(1);

    const leaked = rpcClient({
      data: [{
        destination_kind: 'profile',
        artist_id: null,
        target_label: 'Personal Telegram',
        is_connected: true,
        safe_label: 'Personal Telegram',
        connected_at: null,
        chat_id: '123456',
      }],
      error: null,
    });
    await expect(createTelegramConnectionsApi(leaked.client).listTelegramDestinations()).rejects.toThrow(
      'Could not load Telegram connections.',
    );
  });

  it('starts a personal challenge without an Artist and an Artist challenge with the exact Artist', async () => {
    const profile = rpcClient({
      data: {
        link_token: '12345678901234567890abcdef',
        expires_at: '2026-08-22T12:10:00Z',
        destination_kind: 'profile',
        artist_id: null,
        target_label: 'Personal Telegram',
      },
      error: null,
    });
    await createTelegramConnectionsApi(profile.client).beginTelegramLink('profile');
    expect(profile.rpc).toHaveBeenCalledWith('begin_telegram_link', {
      p_destination_kind: 'profile',
      p_artist_id: null,
    });

    const artist = rpcClient({
      data: {
        link_token: 'abcdef12345678901234567890',
        expires_at: '2026-08-22T12:10:00Z',
        destination_kind: 'artist',
        artist_id: 'artist-1',
        target_label: 'Artist One',
      },
      error: null,
    });
    await createTelegramConnectionsApi(artist.client).beginTelegramLink('artist', 'artist-1');
    expect(artist.rpc).toHaveBeenCalledWith('begin_telegram_link', {
      p_destination_kind: 'artist',
      p_artist_id: 'artist-1',
    });
  });

  it('reads the signed-in profile notification preference through the RLS table read', async () => {
    const maybeSingle = vi.fn(async () => ({ data: { is_enabled: true }, error: null }));
    const eqChannel = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: eqChannel }));
    const from = vi.fn(() => ({ select }));
    const client = { from, rpc: vi.fn() } as unknown as CrmClient;

    await expect(createTelegramConnectionsApi(client).getTelegramNotificationsEnabled()).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith('notification_preferences');
    expect(select).toHaveBeenCalledWith('is_enabled');
    expect(eqChannel).toHaveBeenCalledWith('channel', 'telegram');
  });

  it('uses the existing named preference RPC with the exact parameter name', async () => {
    const { client, rpc } = rpcClient({ data: true, error: null });
    await createTelegramConnectionsApi(client).setTelegramNotificationsEnabled(true);
    expect(rpc).toHaveBeenCalledWith('set_notification_preference', {
      p_channel: 'telegram',
      p_is_enabled: true,
    });
  });

  it('disconnects only the named target and never supplies a chat id', async () => {
    const { client, rpc } = rpcClient({ data: true, error: null });
    await createTelegramConnectionsApi(client).disconnectTelegramDestination('artist', 'artist-1');
    expect(rpc).toHaveBeenCalledWith('disconnect_telegram_destination', {
      p_destination_kind: 'artist',
      p_artist_id: 'artist-1',
    });
  });
});
