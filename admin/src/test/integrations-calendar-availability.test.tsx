import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { PROFILES, renderWithSession } from './fixtures';

describe('Calendar availability in the integrations hub', () => {
  const originalOwnerDisplayName = PROFILES.owner.display_name;

  beforeEach(() => {
    // The owner fixture has a Kristina Calendar row but the signed-in owner is
    // Vladimir. That reproduces the important boundary: another artist's row
    // must stay hidden while this artist still gets a first-connect action.
    PROFILES.owner.display_name = 'Vladimir Vishar';
  });

  afterEach(() => {
    PROFILES.owner.display_name = originalOwnerDisplayName;
  });

  it('offers Google Calendar before this artist has an integration row', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    const available = (await screen.findByRole('heading', {
      level: 2,
      name: 'Available integrations',
    })).closest('section') as HTMLElement;

    expect(within(available).getByText('Google Calendar')).toBeInTheDocument();
    expect(within(available).getByText('Not connected')).toBeInTheDocument();
    expect(within(available).getByRole('link', { name: 'Connect' }))
      .toHaveAttribute('href', '#/integrations/calendar');

    // A hidden artist's existing Calendar metadata must not leak into the
    // fallback card that makes first-time onboarding possible.
    expect(screen.queryByText('Kristina Vishar')).not.toBeInTheDocument();
    expect(screen.queryByText('kristina@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('No providers connected yet')).not.toBeInTheDocument();
  });
});
