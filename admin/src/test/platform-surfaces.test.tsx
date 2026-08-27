// The integrations hub and the notification centre.
//
// Two properties are worth a test rather than a look:
//
//   * a card's health is derived, and the derivation has to distinguish "the
//     artist can fix this in a minute" from "something is broken", because
//     calling an expired token an error sends people to a developer instead of
//     to the reconnect button;
//   * a notification is addressed to a person, and the screen must not invent
//     an action for a notification that has nothing to act on.

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { App } from '../App';
import {
  integrationHealth,
  snoozeUntil,
  type IntegrationStatus,
} from '../lib/platform-api';
import { describeDue, notificationCopy } from '../pages/NotificationsPage';
import { renderWithSession, VLADIMIR_ARTIST_ID } from './fixtures';

function status(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    integration_id: 'i0000000-0000-4000-8000-000000000000',
    owner_kind: 'artist',
    owner_id: VLADIMIR_ARTIST_ID,
    owner_label: 'Vladimir Vishar',
    integration_type: 'telegram',
    provider: 'telegram',
    display_label: null,
    is_enabled: true,
    connected_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error_category: 'none',
    assigned_artist_ids: [],
    is_selected_route: false,
    ...overrides,
  };
}

describe('integration health', () => {
  it('reads a disabled integration as not connected whatever the error says', () => {
    expect(integrationHealth(status({ is_enabled: false, last_error_category: 'unknown' })))
      .toBe('not_connected');
  });

  it('reads an enabled integration with no error as connected', () => {
    expect(integrationHealth(status())).toBe('connected');
  });

  it('treats a credential the owner can renew as needing attention, not as an error', () => {
    for (const category of ['credential_expired', 'credential_rejected', 'permission_revoked'] as const) {
      expect(integrationHealth(status({ last_error_category: category }))).toBe('needs_attention');
    }
  });

  it('does not escalate a provider outage that has since recovered', () => {
    expect(integrationHealth(status({
      last_error_category: 'provider_unavailable',
      last_error_at: '2026-08-20T10:00:00Z',
      last_success_at: '2026-08-20T10:05:00Z',
    }))).toBe('connected');
  });

  it('does escalate an outage that nothing has succeeded since', () => {
    expect(integrationHealth(status({
      last_error_category: 'rate_limited',
      last_error_at: '2026-08-20T10:00:00Z',
      last_success_at: '2026-08-20T09:00:00Z',
    }))).toBe('error');
  });

  it('treats an unrecognised category as an error rather than as healthy', () => {
    expect(integrationHealth(status({ last_error_category: 'unknown' }))).toBe('error');
  });
});

describe('snooze offsets', () => {
  const from = new Date('2026-08-21T14:00:00Z');

  it('moves fifteen minutes and an hour forward exactly', () => {
    expect(snoozeUntil('15m', from).toISOString()).toBe('2026-08-21T14:15:00.000Z');
    expect(snoozeUntil('1h', from).toISOString()).toBe('2026-08-21T15:00:00.000Z');
  });

  it('always moves forward, even when tomorrow morning has already passed', () => {
    // A device whose clock sits after tomorrow 09:00 local must not produce a
    // snooze in the past: the database refuses one, and the user would see an
    // error for choosing a normal option.
    const late = new Date('2026-08-21T23:30:00Z');
    expect(snoozeUntil('tomorrow', late).getTime()).toBeGreaterThan(late.getTime());
  });
});

describe('due description', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('counts overdue in the largest useful unit', () => {
    expect(describeDue('2026-08-21T11:30:00Z', 'en', now)).toBe('Overdue by 30m');
    expect(describeDue('2026-08-21T09:00:00Z', 'en', now)).toBe('Overdue by 3h');
    expect(describeDue('2026-08-19T12:00:00Z', 'en', now)).toBe('Overdue by 2d');
  });

  it('counts forward for something not yet due', () => {
    expect(describeDue('2026-08-21T12:30:00Z', 'en', now)).toBe('Due in 30m');
    expect(describeDue('2026-08-21T15:00:00Z', 'en', now)).toBe('Due in 3h');
  });
});

describe('integrations hub', () => {
  it('groups every visible channel under one screen', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Telegram' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'WhatsApp' })).toBeInTheDocument();
  });

  it('labels a workspace-owned connection as the studio, not an artist', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    const whatsapp = (await screen.findByRole('heading', { level: 2, name: 'WhatsApp' }))
      .closest('section') as HTMLElement;
    expect(within(whatsapp).getByText('Studio · Example Studio')).toBeInTheDocument();
    expect(within(whatsapp).getByText('Not connected')).toBeInTheDocument();
  });

  it('shows an expired credential as needing attention rather than as an error', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/integrations' });

    const calendar = (await screen.findByRole('heading', { level: 2, name: 'Calendar' }))
      .closest('section') as HTMLElement;
    expect(within(calendar).getByText('Needs attention')).toBeInTheDocument();
  });

  it('never renders a raw owner identifier', async () => {
    const { container } = renderWithSession(<App />, { role: 'owner', path: '/integrations' });
    await screen.findByRole('heading', { level: 2, name: 'Telegram' });
    expect(container.textContent).not.toContain(VLADIMIR_ARTIST_ID);
  });
});

describe('notification centre', () => {
  it('separates what the person has not read yet', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/notifications' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Unread (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Read' })).toBeInTheDocument();
    expect(screen.getByText('Reply to Charlie')).toBeInTheDocument();
  });

  it('offers snooze only for a reminder that has a follow-up behind it', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/notifications' });

    const unread = (await screen.findByRole('heading', { level: 2, name: 'Unread (1)' }))
      .closest('section') as HTMLElement;
    expect(within(unread).getByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();

    const read = screen.getByRole('heading', { level: 2, name: 'Read' })
      .closest('section') as HTMLElement;
    expect(within(read).queryByRole('button', { name: 'Tomorrow' })).not.toBeInTheDocument();
  });

  it('snoozes through the follow-up, not through the notification', async () => {
    const { rpcCalls } = renderWithSession(<App />, { role: 'owner', path: '/notifications' });

    const unread = (await screen.findByRole('heading', { level: 2, name: 'Unread (1)' }))
      .closest('section') as HTMLElement;
    fireEvent.click(within(unread).getByRole('button', { name: '1 hour' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'snooze_follow_up')).toBe(true);
    });
    const call = rpcCalls.find((entry) => entry.name === 'snooze_follow_up');
    expect(call?.args?.p_follow_up_id).toBe('fu111111-1111-4111-8111-111111111111');
  });

  it('marks a notification read on request', async () => {
    const { rpcCalls } = renderWithSession(<App />, { role: 'owner', path: '/notifications' });

    const unread = (await screen.findByRole('heading', { level: 2, name: 'Unread (1)' }))
      .closest('section') as HTMLElement;
    fireEvent.click(within(unread).getByRole('button', { name: 'Mark read' }));

    await waitFor(() => {
      expect(rpcCalls.some((call) => call.name === 'mark_notification_read')).toBe(true);
    });
  });

  it('is reachable by a read-only account, because it shows only their own rows', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/notifications' });
    expect(await screen.findByRole('heading', { level: 2, name: /Unread/ })).toBeInTheDocument();
  });
});

describe('lifecycle failure notification copy', () => {
  it.each(['execution', 'delivery'])('localizes the %s alert without copying provider details', (category) => {
    const notification = { notification_type: `automation.lifecycle_${category}_failed`, title: 'English title', body: 'English body' };
    const ru = notificationCopy(notification, 'ru');
    expect(ru.title).toMatch(/пись|писем/);
    expect(ru.body).toContain('24 часа');
    expect(ru.body).toContain('3 пис');
    expect(ru.body).toContain('«Автоматизации»');
    expect(notificationCopy(notification, 'en')).toEqual({ title: 'English title', body: 'English body' });
  });
  it('preserves ordinary notification copy', () => {
    expect(notificationCopy({ notification_type: 'followup.due', title: 'Call client', body: null }, 'ru'))
      .toEqual({ title: 'Call client', body: null });
  });
});
