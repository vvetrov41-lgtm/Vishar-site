import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { PROFILES, renderWithSession } from './fixtures';

describe('Telegram settings surface', () => {
  const originalOwnerDisplayName = PROFILES.owner.display_name;

  afterEach(() => {
    PROFILES.owner.display_name = originalOwnerDisplayName;
  });

  it('keeps Telegram out of the integrations hub before an artist destination exists', async () => {
    PROFILES.owner.display_name = 'Kristina Vishar';
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Available integrations' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Telegram')).not.toBeInTheDocument();
  });

  it('keeps Telegram out of the integrations hub when an artist destination already exists', async () => {
    PROFILES.owner.display_name = 'Vladimir Vishar';
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    expect(await screen.findByRole('heading', { level: 2, name: 'WhatsApp' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Telegram' })).not.toBeInTheDocument();
  });
});
