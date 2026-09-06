import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { PROFILES, renderWithSession } from './fixtures';

const NOTIFICATIONS_ONLY = 'Telegram is used only for artist notifications. It is not a client messaging channel.';

describe('Telegram in the integrations hub', () => {
  const originalOwnerDisplayName = PROFILES.owner.display_name;

  afterEach(() => {
    PROFILES.owner.display_name = originalOwnerDisplayName;
  });

  it('shows Telegram as available before this artist has a destination row', async () => {
    // Kristina has a visible Calendar row in the fixture but no Telegram row.
    PROFILES.owner.display_name = 'Kristina Vishar';
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    const available = (await screen.findByRole('heading', {
      level: 2,
      name: 'Available integrations',
    })).closest('section') as HTMLElement;

    expect(within(available).getByText('Telegram')).toBeInTheDocument();
    expect(within(available).getByText(NOTIFICATIONS_ONLY)).toBeInTheDocument();
    expect(within(available).getByRole('link', { name: 'Connect' }))
      .toHaveAttribute('href', '#/integrations/telegram');
  });

  it('keeps the notifications-only explanation on a connected Telegram card', async () => {
    PROFILES.owner.display_name = 'Vladimir Vishar';
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    const telegram = (await screen.findByRole('heading', {
      level: 2,
      name: 'Telegram',
    })).closest('section') as HTMLElement;

    expect(within(telegram).getByText(NOTIFICATIONS_ONLY)).toBeInTheDocument();
    expect(within(telegram).getByText('Connected', { selector: '.badge' })).toBeInTheDocument();
    expect(within(telegram).getByRole('link', { name: 'Manage' }))
      .toHaveAttribute('href', '#/integrations/telegram');
  });
});
