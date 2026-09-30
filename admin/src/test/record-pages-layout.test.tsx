import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { CLIENT_ID, PROJECT_ID, renderWithSession } from './fixtures';

describe('project page order', () => {
  it('lists booked sessions first and keeps the booking form closed below them', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });

    const booking = await screen.findByRole('heading', { level: 2, name: 'Book a session' });
    const sessions = document.getElementById('project-sessions') as HTMLElement;
    expect(sessions.compareDocumentPosition(booking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The fixture project already has a session, so the form is not the next step.
    expect(booking.closest('details')).not.toHaveAttribute('open');
  });

  it('keeps a different deposit amount behind one closed line', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });

    const input = await screen.findByLabelText('Use a different amount');
    expect(input.closest('details')).not.toHaveAttribute('open');
  });
});

describe('client page', () => {
  it('makes each contact detail a link', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    const header = (await screen.findByRole('heading', { level: 2, name: 'Fixture Client' })).closest('section') as HTMLElement;
    expect(within(header).getByRole('link', { name: 'fixture@example.test' })).toHaveAttribute('href', 'mailto:fixture@example.test');
    expect(within(header).getByRole('link', { name: '@fixture' })).toHaveAttribute('href', 'https://instagram.com/fixture');
    expect(header.querySelector('a[href="tel:+447700900000"]')).not.toBeNull();
  });

  it('keeps the booking form closed', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    const booking = await screen.findByRole('heading', { level: 2, name: 'Book a session' });
    expect(booking.closest('details')).not.toHaveAttribute('open');
  });
});

describe('calendar page', () => {
  it('does not show the storage-architecture notice to operators', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/appointments' });

    await screen.findByRole('heading', { level: 2, name: 'Calendar' });
    expect(screen.queryByText(/Supabase/)).not.toBeInTheDocument();
  });
});
