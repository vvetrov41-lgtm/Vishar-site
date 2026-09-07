import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTelegramConnectorInfo: vi.fn(),
  listTelegramDestinations: vi.fn(),
  listAccessibleArtists: vi.fn(),
  getTelegramNotificationsEnabled: vi.fn(),
  setTelegramNotificationsEnabled: vi.fn(),
  beginTelegramLink: vi.fn(),
  disconnectTelegramDestination: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  snoozeFollowUp: vi.fn(),
}));

const session = vi.hoisted(() => ({
  profile: {
    id: 'p1111111-1111-4111-8111-111111111111',
    display_name: 'Andrei Cotici',
    role: 'booking_manager' as const,
    is_active: true,
  },
  memberships: [{
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    is_active: true,
    can_manage_integrations: true,
  }],
}));

vi.mock('../lib/session', () => ({
  useApi: () => mocks,
  useSession: () => session,
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
  session.memberships[0].can_manage_integrations = true;
  mocks.getTelegramConnectorInfo.mockResolvedValue({ bot_username: 'VisharBot' });
  mocks.listTelegramDestinations.mockResolvedValue([
    personalDestination,
    legacyArtistDestination,
  ]);
  mocks.listAccessibleArtists.mockResolvedValue([{
    id: 'a1111111-1111-4111-8111-111111111111',
    slug: 'andrei-cotici',
    display_name: 'Andrei Cotici',
    is_active: true,
  }]);
  mocks.getTelegramNotificationsEnabled.mockResolvedValue(true);
  mocks.setTelegramNotificationsEnabled.mockResolvedValue(true);
  mocks.disconnectTelegramDestination.mockResolvedValue(true);
  mocks.listNotifications.mockResolvedValue([]);
  mocks.markNotificationRead.mockResolvedValue(true);
  mocks.snoozeFollowUp.mockResolvedValue(true);
});

describe('Telegram notification settings parity', () => {
  it('uses only the signed-in profile destination for personal CRM delivery', async () => {
    render(<PersonalTelegramNotifications />);

    expect(await screen.findByText('Your Telegram')).toBeInTheDocument();
    expect(screen.getByText('Personal CRM notifications')).toBeInTheDocument();
    expect(screen.getByText('Enabled', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.queryByText('Legacy Artist Telegram')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disable personal Telegram' }));
    await waitFor(() => {
      expect(mocks.setTelegramNotificationsEnabled).toHaveBeenCalledWith(false);
    });
  });

  it('shows personal and artist destinations together on Notifications for integration managers', async () => {
    render(<NotificationsPage />);

    expect(await screen.findByText('Personal Telegram')).toBeInTheDocument();
    expect(await screen.findByText('Your Telegram')).toBeInTheDocument();
    expect(await screen.findByText('Artist Telegram')).toBeInTheDocument();
    expect(await screen.findByText('Legacy Artist Telegram')).toBeInTheDocument();
    expect(
      screen.getByText('New enquiry notifications are delivered to this Telegram, not to your personal one.'),
    ).toBeInTheDocument();
  });

  it('keeps the old Telegram deep link as artist-only compatibility UI', async () => {
    render(<TelegramConnectionsPage />);

    expect(await screen.findByText('Artist Telegram')).toBeInTheDocument();
    expect(await screen.findByText('Legacy Artist Telegram')).toBeInTheDocument();
    expect(screen.queryByText('Personal Telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('Your Telegram')).not.toBeInTheDocument();
  });

  it('does not point non-managers to a hidden artist section', async () => {
    session.memberships[0].can_manage_integrations = false;
    render(<NotificationsPage />);

    expect(await screen.findByText('Personal Telegram')).toBeInTheDocument();
    expect(screen.queryByText('Artist Telegram')).not.toBeInTheDocument();
    expect(screen.getByText(
      'This controls only personal CRM notification delivery. New enquiries are sent to the Telegram destination configured for the artist.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/below/i)).not.toBeInTheDocument();
  });

  it('hides artist destinations this profile may not manage', async () => {
    mocks.listAccessibleArtists.mockResolvedValue([{
      id: 'a9999999-9999-4999-8999-999999999999',
      slug: 'someone-else',
      display_name: 'Someone Else',
      is_active: true,
    }]);

    render(<NotificationsPage />);

    expect(await screen.findByText('No manageable artists')).toBeInTheDocument();
    expect(screen.queryByText('Legacy Artist Telegram')).not.toBeInTheDocument();
  });
});
