import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginTelegramLink: vi.fn(),
  listTelegramDestinations: vi.fn(),
  disconnectTelegramDestination: vi.fn(),
  onChanged: vi.fn(),
}));

vi.mock('../lib/session', () => ({
  useApi: () => ({
    beginTelegramLink: mocks.beginTelegramLink,
    listTelegramDestinations: mocks.listTelegramDestinations,
    disconnectTelegramDestination: mocks.disconnectTelegramDestination,
  }),
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({ language: 'en' as const }),
}));

import { TelegramConnectionCard } from '../components/TelegramConnectionCard';

const destination = {
  destination_kind: 'profile' as const,
  artist_id: null,
  target_label: 'Your Telegram',
  is_connected: false,
  safe_label: null,
  connected_at: null,
};

const challenge = {
  link_token: '0123456789abcdef0123456789abcdef',
  expires_at: '2099-01-01T00:00:00.000Z',
  destination_kind: 'profile' as const,
  artist_id: null,
  target_label: 'Your Telegram',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beginTelegramLink.mockResolvedValue(challenge);
  mocks.listTelegramDestinations.mockResolvedValue([destination]);
  mocks.disconnectTelegramDestination.mockResolvedValue(true);
});

describe('Telegram connection card', () => {
  it('creates one live link and does not offer a second Connect that would revoke it', async () => {
    render(
      <TelegramConnectionCard
        destination={destination}
        botUsername="VisharBot"
        onChanged={mocks.onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const openTelegram = await screen.findByRole('link', { name: 'Open Telegram' });
    expect(openTelegram).toHaveAttribute(
      'href',
      'https://t.me/VisharBot?start=0123456789abcdef0123456789abcdef',
    );
    expect(mocks.beginTelegramLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(screen.getByText(/will not create a second link and cancel it/i)).toBeInTheDocument();
  });

  it('keeps the current link after a negative status read instead of minting another token', async () => {
    render(
      <TelegramConnectionCard
        destination={destination}
        botUsername="VisharBot"
        onChanged={mocks.onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('link', { name: 'Open Telegram' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));

    await waitFor(() => {
      expect(screen.getByText(/finish starting the bot from the current link/i)).toBeInTheDocument();
    });
    expect(mocks.beginTelegramLink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Open Telegram' })).toBeInTheDocument();
  });

  it('switches to Connected when status readback proves the link completed', async () => {
    const connected = {
      ...destination,
      is_connected: true,
      safe_label: 'Telegram chat ending 6001',
      connected_at: '2026-09-04T08:00:00.000Z',
    };
    mocks.listTelegramDestinations.mockResolvedValue([connected]);

    render(
      <TelegramConnectionCard
        destination={destination}
        botUsername="VisharBot"
        onChanged={mocks.onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('link', { name: 'Open Telegram' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));

    await screen.findByText('Connection confirmed.');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Telegram' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(mocks.onChanged).toHaveBeenCalledTimes(1);
  });
});
