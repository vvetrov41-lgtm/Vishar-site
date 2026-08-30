// Lists identify a person, not a record.
//
// The enquiry queue led with a reference number, the project list and project
// page led with a project title, and the dashboard's upcoming sessions showed a
// date with two badges. None of them told the operator who the row was about,
// so every triage decision cost a navigation. The record's own identifier is
// kept as supporting detail rather than removed.

import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { CLIENT_ID, PROJECT_ID, SESSION, renderWithSession } from './fixtures';

// The shared fixture session is `proposed`; a confirmed one shows what today's
// schedule looks like when the booking is firm.
const CONFIRMED_SESSION = {
  ...SESSION,
  id: '77777777-7777-4777-8777-777777777777',
  client_id: CLIENT_ID,
  status: 'confirmed' as const,
};

describe('client identity in lists', () => {
  it('leads the enquiry queue with the client and keeps the reference', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/enquiries' });

    const row = (await screen.findByText('Fixture Client')).closest('a') as HTMLElement;
    expect(row).toHaveAttribute('href', expect.stringContaining('#/enquiries/'));
    expect(row.querySelector('.title')?.textContent).toBe('Fixture Client');
    expect(within(row).getByText('ENQ-2026-0001')).toBeInTheDocument();
  });

  it('leads the project list with the client and keeps the project title', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/projects' });

    const row = (await screen.findByText('Fixture Client')).closest('a') as HTMLElement;
    expect(row).toHaveAttribute('href', `#/projects/${PROJECT_ID}`);
    expect(row.querySelector('.title')?.textContent).toBe('Fixture Client');
    expect(within(row).getByText('Raven sleeve')).toBeInTheDocument();
  });

  it('shows the how-to guide only when there are no projects to read', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/projects' });

    await screen.findByText('Fixture Client');
    expect(screen.queryByText('How to create a project')).not.toBeInTheDocument();
  });

  it('names the client on the project page and keeps the project title beneath', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}` });

    expect(await screen.findByRole('heading', { level: 2, name: 'Fixture Client' })).toBeInTheDocument();
    expect(screen.getByText('Raven sleeve')).toBeInTheDocument();
  });

  it("names the client on today's schedule and links to the appointment", async () => {
    // Pinned to the morning of the fixture booking so "today" means the same
    // thing on every run.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-01T08:00:00Z') });
    try {
      renderWithSession(<App />, {
        role: 'owner',
        path: '/',
        extraSessions: [CONFIRMED_SESSION],
      });

      const heading = await screen.findByRole('heading', { level: 2, name: 'Today' });
      const section = heading.closest('section') as HTMLElement;

      // Both fixture bookings fall on this day, so the row is identified by the
      // appointment it opens rather than by being the only one named.
      const rows = await within(section).findAllByText('Fixture Client');
      const link = rows
        .map((row) => row.closest('a') as HTMLElement)
        .find((candidate) => candidate?.getAttribute('href') === `#/appointments/${CONFIRMED_SESSION.id}`);

      // Previously the row title was the date and the link went to the project.
      expect(link).toBeDefined();
      expect((link as HTMLElement).querySelector('.title')?.textContent).toBe('Fixture Client');
      // The date survives as supporting detail.
      expect((link as HTMLElement).textContent).toContain('2026');
    } finally {
      vi.useRealTimers();
    }
  });
});
