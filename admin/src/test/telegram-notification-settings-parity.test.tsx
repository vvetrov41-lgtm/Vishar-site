import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTelegramConnectorInfo: vi.fn(),
  listTelegramDestinations: vi.fn(),
  getTelegramNotificationsEnabled: vi.fn(),
  setTelegramNotificationsEnabled: vi.fn(),
  beginTelegramLink: vi.fn(),
  disconnectTelegramDestination: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  snoozeFollowUp: vi.fn(),
}));

vi.mock('../lib/session', () => ({
  useApi: () => mocks,
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({
    language: 'en' as const,
    t: (key: string) => key,
  }),
}));

import { PersonalTelegramNotifications } from '../components/PersonalTelegramNotifications';
import { NotificationsPage } from '../pages/NotificationsPage';
import { TelegramConnectionsPage } from '../pages/TelegramConnectionsPage';

const personalDestination = {
  destination_kind: 'profile' as const,
  artist_id: null,
  target_label: 'Your Telegram',
  is_connected: true,
  safe_label: 'Vladimir private Telegram',
  connected_at: '2026-09-06T12:00:00.000Z',
};

const legacyArtistDestination = {
  destination_kind: 'artist' as const,
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  target_label: 'Legacy Artist Telegram',
  is_connected: true,
  safe_label: 'Legacy group',
  connected_at: '2026-08-01T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTelegramConnectorInfo.mockResolvedValue({ bot_username: 'VisharBot' });
  mocks.listTelegramDestinations.mockResolvedValue([
    personalDestination,
    legacyArtistDestination,
  ]);
  mocks.getTelegramNotificationsEnabled.mockResolvedValue(true);
  mocks.setTelegramNotificationsEnabled.mockResolvedValue(true);
  mocks.disconnectTelegramDestination.mockResolvedValue(true);
  mocks.listNotifications.mockResolvedValue([]);
  mocks.markNotificationRead.mockResolvedValue(true);
  mocks.snoozeFollowUp.mockResolvedValue(true);
});

describe('personal Telegram settings parity', () => {
  it('uses only the signed-in profile destination and the notification delivery preference', async () => {
    render(<PersonalTelegramNotifications />);

    expect(await screen.findByText('Your Telegram')).toBeInTheDocument();
    expect(screen.getByText('Notification delivery')).toBeInTheDocument();
    expect(screen.getByText('Enabled', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.queryByText('Legacy Artist Telegram')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disable Telegram' }));
    await waitFor(() => {
      expect(mocks.setTelegramNotificationsEnabled).toHaveBeenCalledWith(false);
    });
  });

  it('renders the same shared personal Telegram surface from Integrations and Notifications', async () => {
    const integration = render(<TelegramConnectionsPage />);

    expect(await screen.findByText('Personal delivery')).toBeInTheDocument();
    expect(screen.getByText('Your Telegram')).toBeInTheDocument();
    expect(screen.getByText('Notification delivery')).toBeInTheDocument();
    expect(screen.queryByText('Shared Telegram bot')).not.toBeInTheDocument();
    expect(screen.queryByText('Artist Telegram')).not.toBeInTheDocument();

    integration.unmount();
    render(<NotificationsPage />);

    expect(await screen.findByText('Personal delivery')).toBeInTheDocument();
    expect(screen.getByText('Your Telegram')).toBeInTheDocument();
    expect(screen.getByText('Notification delivery')).toBeInTheDocument();
  });
});
