import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { entityLink } from '../pages/NotificationsPage';
import type { CrmNotification } from '../lib/platform-api';
import { PROJECT_ID, SESSION_ID, renderWithSession } from './fixtures';

function sessionNotification(entityId = SESSION_ID): CrmNotification {
  return {
    id: 'n3333333-3333-4333-8333-333333333333',
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    artist_label: 'Vladimir Vishar',
    notification_type: 'appointment.reschedule_requested',
    title: 'Client requested a reschedule',
    body: 'The appointment time has not changed.',
    entity_type: 'session',
    entity_id: entityId,
    priority: 'high',
    status: 'delivered',
    scheduled_at: '2026-08-24T20:00:00Z',
    read_at: null,
  };
}

describe('appointment notification deep links', () => {
  it('keeps the exact session identity in the notification destination', () => {
    expect(entityLink(sessionNotification())).toBe(`/appointments/${SESSION_ID}`);
    expect(entityLink(sessionNotification('session/id with spaces')))
      .toBe('/appointments/session%2Fid%20with%20spaces');
  });

  it('opens only the exact RLS-authorized appointment and reuses its operator controls', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/appointments/${SESSION_ID}`,
    });

    expect(await screen.findByRole('heading', { level: 2, name: 'Appointment from notification' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All appointments' }))
      .toHaveAttribute('href', '#/appointments');
    expect(screen.getByRole('link', { name: 'Project: Raven sleeve' }))
      .toHaveAttribute('href', `#/projects/${PROJECT_ID}`);
    expect(document.querySelector(`[data-focused-appointment-id="${SESSION_ID}"]`))
      .not.toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'New appointment' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Confirm:/ })).toBeInTheDocument();
  });

  it('fails closed when the notification points at an inaccessible or missing appointment', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/appointments/00000000-0000-4000-8000-000000000000',
    });

    expect(await screen.findByText('Appointment unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Confirm:/ })).not.toBeInTheDocument();
  });
});
