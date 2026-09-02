// What the interface calls the person whose name is in the corner.
//
// Production found this the honest way: a tattoo artist signed up, got their
// own solo organization and their own artist, and the CRM told them they were
// a "Booking manager". That word is the authorization role migration 0130
// deliberately gives every self-service founder - `owner` is the legacy
// installation-wide role and a public form may not hand it out - and it was
// never meant to be a label.
//
// So the label comes from public.account_overview, which derives it from the
// membership rows authorization itself reads. These tests pin the four answers
// that matter and the fallback when the server does not answer at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { LanguageProvider } from '../lib/i18n';
import {
  MANAGER_ID,
  MEMBERSHIPS,
  READER_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

/** The shape production actually has: the global role is `booking_manager`,
 *  and the artist seat on their own artist is what makes them an artist. */
const FOUNDER_MEMBERSHIPS = [
  {
    profile_id: MANAGER_ID,
    artist_id: VLADIMIR_ARTIST_ID,
    access_level: 'artist' as const,
    can_view_finance: true,
    can_manage_finance: true,
    can_manage_sessions: true,
    can_manage_integrations: true,
    is_active: true,
  },
];

/** Somebody invited to handle bookings for an artist they are not. */
const BOOKING_ONLY_MEMBERSHIPS = MEMBERSHIPS.filter(
  (membership) => membership.profile_id === MANAGER_ID
);

const READ_ONLY_MEMBERSHIPS = MEMBERSHIPS.filter(
  (membership) => membership.profile_id === READER_ID
);

async function profileTrigger() {
  return screen.findByRole('button', { name: /your account|ваш аккаунт/i });
}

describe('the role the interface prints', () => {
  it('calls a self-service artist founder an Artist, not a Booking manager', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      membershipOverrides: FOUNDER_MEMBERSHIPS,
      selfServiceFounder: true,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Artist')).toBeInTheDocument();
    expect(within(trigger).queryByText('Booking manager')).not.toBeInTheDocument();
  });

  it('and calls them Мастер in Russian', async () => {
    window.localStorage.setItem('vishar-crm-language', 'ru');
    renderWithSession(<LanguageProvider><App /></LanguageProvider>, {
      role: 'booking_manager',
      membershipOverrides: FOUNDER_MEMBERSHIPS,
      selfServiceFounder: true,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Мастер')).toBeInTheDocument();
    expect(within(trigger).queryByText('Менеджер записей')).not.toBeInTheDocument();
  });

  it('still calls booking-only staff a Booking manager', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      membershipOverrides: BOOKING_ONLY_MEMBERSHIPS,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Booking manager')).toBeInTheDocument();
    expect(within(trigger).queryByText('Artist')).not.toBeInTheDocument();
  });

  it('and Менеджер записей in Russian', async () => {
    window.localStorage.setItem('vishar-crm-language', 'ru');
    renderWithSession(<LanguageProvider><App /></LanguageProvider>, {
      role: 'booking_manager',
      membershipOverrides: BOOKING_ONLY_MEMBERSHIPS,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Менеджер записей')).toBeInTheDocument();
  });

  // The installation operator holds an `owner` seat on every artist, because
  // 0015's owner-sync puts one there. Describing them from the seat alone
  // would make the person who administers the installation look like somebody
  // in a studio.
  it('never describes the installation operator as an artist', async () => {
    renderWithSession(<App />, { role: 'owner' });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Operator')).toBeInTheDocument();
    expect(within(trigger).queryByText('Artist')).not.toBeInTheDocument();
  });

  it('calls a read-only seat read only', async () => {
    renderWithSession(<App />, {
      role: 'read_only',
      membershipOverrides: READ_ONLY_MEMBERSHIPS,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Read only')).toBeInTheDocument();
  });

  // The point of reading it from the server: the browser holds no flag it
  // could flip. When the server does not answer, the interface says what it
  // said before this existed rather than guessing something friendlier.
  it('falls back to the authorization role when the server does not answer', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      membershipOverrides: FOUNDER_MEMBERSHIPS,
      selfServiceFounder: true,
      failAccountOverview: true,
    });

    const trigger = await profileTrigger();
    expect(await within(trigger).findByText('Booking manager')).toBeInTheDocument();
    expect(within(trigger).queryByText('Artist')).not.toBeInTheDocument();
  });
});

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { window.localStorage.clear(); });
