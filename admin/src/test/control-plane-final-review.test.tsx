// Final regressions from the second independent control-plane review.
//
// These are deliberately separate from the broader control-plane suite. They
// pin two server-authoritative decisions that are easy to accidentally derive
// from already-visible workspace rows instead: whether the control plane may be
// opened at all, and whether a new organization may be founded.

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { STUDIO_WORKSPACE_ID, renderWithSession } from './fixtures';

const FIRST_WORKSPACE_ACCESS = {
  workspace_count: 0,
  administers_any: false,
  can_manage_any_team: false,
  can_found_workspace: true,
  can_browse_directory: true,
};

const EXISTING_WORKSPACE = {
  id: STUDIO_WORKSPACE_ID,
  slug: 'ink-collective',
  display_name: 'Ink Collective',
  workspace_type: 'studio' as const,
  timezone: 'Europe/London',
  default_currency: 'GBP',
  is_active: true,
  workspace_role: 'owner' as const,
  can_manage_workspace: true,
  can_manage_team: true,
  can_manage_integrations: true,
  artist_count: 0,
};

describe('final control-plane review regressions', () => {
  it('lets a permitted founder open the control plane with zero workspaces and create the first one', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      workspaces: [],
      controlPlaneAccess: FIRST_WORKSPACE_ACCESS,
      path: '/workspaces',
    });

    expect(await screen.findByText('No organizations')).toBeInTheDocument();
    expect(screen.getByText('Create the first organization below.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New organization' })).toBeInTheDocument();
    expect(screen.queryByText('No organization yet')).not.toBeInTheDocument();
  });

  it('does not invent founding permission from an existing manageable workspace', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      workspaces: [EXISTING_WORKSPACE],
      controlPlaneAccess: {
        ...FIRST_WORKSPACE_ACCESS,
        workspace_count: 1,
        administers_any: true,
        can_manage_any_team: true,
        can_found_workspace: false,
      },
      path: '/workspaces',
    });

    expect(await screen.findByText('Ink Collective')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New organization' })).not.toBeInTheDocument();
  });
});
