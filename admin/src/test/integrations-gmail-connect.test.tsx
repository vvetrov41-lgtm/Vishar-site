import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { gmailOAuthStartUrl } from '../pages/IntegrationsPage';
import type { IntegrationStatus } from '../lib/platform-api';
import {
  INTEGRATION_STATUS,
  KRISTINA_ARTIST_ID,
  VLADIMIR_ARTIST_ID,
  MANAGER_ID,
  MEMBERSHIPS,
  renderWithSession,
} from './fixtures';

const kristinaGmail: IntegrationStatus = {
  ...INTEGRATION_STATUS[1],
  integration_id: 'i4444444-4444-4444-8444-444444444444',
  owner_kind: 'artist',
  owner_id: KRISTINA_ARTIST_ID,
  owner_label: 'Kristina Vishar',
  integration_type: 'email',
  provider: 'google',
  display_label: 'kristina@example.test',
  is_enabled: false,
  connected_at: null,
  last_error_at: null,
  last_error_category: 'none',
  is_selected_route: false,
};

const vladimirGmail: IntegrationStatus = {
  ...kristinaGmail,
  integration_id: 'i5555555-5555-4555-8555-555555555555',
  owner_id: VLADIMIR_ARTIST_ID,
  owner_label: 'Vladimir Vishar',
  display_label: 'vladimir@example.test',
  is_enabled: true,
};

describe('Gmail OAuth actions in CRM integrations', () => {
  it('shows the correct Kristina connection action to her integration manager, not another artist', async () => {
    const kristinaMembership = {
      ...MEMBERSHIPS.find((membership) => membership.profile_id === MANAGER_ID)!,
      artist_id: KRISTINA_ARTIST_ID,
      can_manage_integrations: true,
    };
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/integrations',
      accessibleArtistIds: [KRISTINA_ARTIST_ID],
      membershipOverrides: [kristinaMembership],
      integrationStatuses: [kristinaGmail, vladimirGmail],
    });

    const emailSection = (await screen.findByRole('heading', { level: 2, name: 'Email' }))
      .closest('section') as HTMLElement;
    const link = within(emailSection).getByRole('link', {
      name: 'Connect Gmail: Kristina Vishar',
    });
    expect(link).toHaveAttribute(
      'href',
      'https://gmail.vishartattoo.com/oauth/google/start/kristina',
    );
    expect(within(emailSection).queryByText('Vladimir Vishar')).not.toBeInTheDocument();
    expect(within(emailSection).queryByText('vladimir@example.test')).not.toBeInTheDocument();
  });

  it('offers a reconnect action for an enabled Gmail integration', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/integrations',
      accessibleArtistIds: [KRISTINA_ARTIST_ID],
      membershipOverrides: [{
        ...MEMBERSHIPS.find((membership) => membership.profile_id === MANAGER_ID)!,
        artist_id: KRISTINA_ARTIST_ID,
        can_manage_integrations: true,
      }],
      integrationStatuses: [{ ...kristinaGmail, is_enabled: true }],
    });
    expect(await screen.findByRole('link', { name: 'Reconnect Gmail: Kristina Vishar' }))
      .toHaveAttribute('href', 'https://gmail.vishartattoo.com/oauth/google/start/kristina');
  });

  it('never invents a Gmail OAuth target for another provider, workspace, or unknown artist', () => {
    expect(gmailOAuthStartUrl(kristinaGmail))
      .toBe('https://gmail.vishartattoo.com/oauth/google/start/kristina');
    expect(gmailOAuthStartUrl({ ...kristinaGmail, owner_id: 'unknown' })).toBeNull();
    expect(gmailOAuthStartUrl({ ...kristinaGmail, owner_kind: 'workspace' })).toBeNull();
    expect(gmailOAuthStartUrl({ ...kristinaGmail, provider: 'other' })).toBeNull();
    expect(gmailOAuthStartUrl({ ...kristinaGmail, integration_type: 'calendar' })).toBeNull();
  });
});
