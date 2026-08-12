// Role-visibility and access-gate tests, rendered against a fake client that
// models the same denials the database applies.

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { renderWithSession, PROJECT_ID, ENQUIRY_ID } from './fixtures';

describe('access gate', () => {
  it('shows the sign-in form when signed out', async () => {
    renderWithSession(<App />, { role: 'signed_out' });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('refuses an account that has no CRM profile', async () => {
    renderWithSession(<App />, { role: 'no_profile' });
    expect(await screen.findByText(/no CRM access/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('refuses a deactivated profile', async () => {
    // A deactivated account cannot read its own profile row either, because
    // `profiles_select_self` is gated on `is_active`. So it is refused as an
    // account with no CRM access — which denies just as completely.
    renderWithSession(<App />, { role: 'deactivated' });
    expect(await screen.findByText(/no CRM access/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('lets an active profile in', async () => {
    renderWithSession(<App />, { role: 'owner' });
    expect(await screen.findByRole('navigation', { name: /sections/i })).toBeInTheDocument();
  });
});

describe('navigation by role', () => {
  it('shows Users and Activity to the owner', async () => {
    renderWithSession(<App />, { role: 'owner' });
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activity' })).toBeInTheDocument();
  });

  it('hides Users from a booking manager', async () => {
    renderWithSession(<App />, { role: 'booking_manager' });
    expect((await screen.findAllByRole('link', { name: 'Enquiries' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('hides Users and Activity from read_only', async () => {
    renderWithSession(<App />, { role: 'read_only' });
    expect((await screen.findAllByRole('link', { name: 'Clients' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument();
  });
});

describe('route protection', () => {
  it('refuses /users to a booking manager who navigates there directly', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/users' });
    expect(await screen.findByText(/Not available for your role/i)).toBeInTheDocument();
  });

  it('refuses /activity to read_only who navigates there directly', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/activity' });
    expect(await screen.findByText(/Not available for your role/i)).toBeInTheDocument();
  });

  it('serves /users to the owner, with a role control per person', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users' });
    expect(await screen.findByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('Reader')).toBeInTheDocument();
    // One role selector per staff member, and a deactivate control for each.
    // The separate language selector is intentionally excluded.
    expect(screen.getAllByRole('combobox', { name: /Role for/i }).length).toBe(4);
    expect(screen.getAllByRole('button', { name: /deactivate|reactivate/i }).length).toBe(4);
  });

  it('will not let the owner deactivate their own account', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users' });
    await screen.findByText('Manager');
    // Located by the row's own accessible label: "Owner" also appears in the
    // header and in every role dropdown.
    const ownRow = screen.getByLabelText('Role for Owner').closest('.row') as HTMLElement;
    expect(within(ownRow).getByRole('button', { name: /deactivate/i })).toBeDisabled();
  });
});

describe('finance isolation', () => {
  it('shows the owner the rate and total on a project', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Hourly rate')).toBeInTheDocument();
    });
    expect(screen.getByText(/£140\.00/)).toBeInTheDocument();
    expect(screen.getByText(/£2,520\.00/)).toBeInTheDocument();
  });

  it('shows a booking manager the project without any money', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    expect(screen.queryByText('Hourly rate')).not.toBeInTheDocument();
    expect(screen.queryByText(/£140/)).not.toBeInTheDocument();
    expect(screen.queryByText(/£2,520/)).not.toBeInTheDocument();
    expect(screen.getByText(/owner-only/i)).toBeInTheDocument();
  });

  it('shows read_only the project without any money either', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    expect(screen.queryByText(/£140/)).not.toBeInTheDocument();
  });

  it('keeps deposit STATE visible to a manager while the amount is not', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    expect(screen.getAllByText(/Deposit: requested/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/£150/)).not.toBeInTheDocument();
  });
});

describe('enquiry detail by role', () => {
  it('offers a manager the allowed status transitions', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByText('ENQ-2026-0001')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reviewing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Declined' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Convert to project/i })).not.toBeInTheDocument();
  });

  it('offers conversion only after the enquiry is accepted', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/enquiries/${ENQUIRY_ID}`,
      enquiryStatus: 'accepted',
    });
    expect(await screen.findByRole('button', { name: /Convert to project/i })).toBeInTheDocument();
  });

  it('offers read_only no status control, no notes and no images', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByText('ENQ-2026-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reviewing' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reference images')).not.toBeInTheDocument();
    expect(screen.queryByText('Internal notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Convert to a project')).not.toBeInTheDocument();
  });

  it('shows reference images to a manager', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByText('Reference images')).toBeInTheDocument();
    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toContain('token=short-lived');
  });
});

describe('dashboard by role', () => {
  it('shows failed integration jobs to the owner only', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    expect(await screen.findByText('Failed integration jobs')).toBeInTheDocument();
  });

  it('hides failed integration jobs from a booking manager', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Enquiries' })).toBeInTheDocument();
    expect(screen.queryByText('Failed integration jobs')).not.toBeInTheDocument();
  });

  it('hides the activity feed from read_only', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Enquiries' })).toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
  });
});
