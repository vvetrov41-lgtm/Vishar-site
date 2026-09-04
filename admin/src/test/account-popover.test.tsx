// The account popover behaves like a popover.
//
// It used to be a native `<details>`, which has no notion of "outside": the
// panel stayed open over whatever you tapped next, and on a phone that means
// the first tap is spent closing a menu you thought you had already left.
//
// These tests pin the four things that make it a menu rather than a box that
// happens to open, plus the one thing the old markup could not do at all: the
// person's name being a real link to their account.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { LanguageProvider } from '../lib/i18n';
import { MANAGER_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

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

function renderShell(path = '/', localised = false) {
  return renderWithSession(localised ? <LanguageProvider><App /></LanguageProvider> : <App />, {
    role: 'booking_manager',
    membershipOverrides: FOUNDER_MEMBERSHIPS,
    selfServiceFounder: true,
    path,
  });
}

// The shell keeps loading after the trigger first appears, so a node captured
// by `findByRole` can be replaced by a later render before the click reaches
// it. Clicking a detached node silently does nothing and the panel never opens,
// which is why this always re-queries immediately before clicking and then
// waits for the panel rather than asserting on the same tick.
async function accountTrigger() {
  return screen.findByRole('button', { name: /your account/i });
}

async function openPopover() {
  const trigger = await accountTrigger();
  fireEvent.click(trigger);
  await waitFor(() => expect(panel()).not.toBeNull());
  return trigger;
}

function panel() {
  return document.getElementById('profile-panel');
}

describe('the account popover', () => {
  it('starts closed and opens on the trigger', async () => {
    renderShell();
    expect(await accountTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();

    const trigger = await openPopover();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('stays open when the pointer lands on a control inside it', async () => {
    renderShell();
    await openPopover();

    const open = panel();
    expect(open).not.toBeNull();
    const languageSelect = within(open as HTMLElement).getByRole('combobox');
    fireEvent.pointerDown(languageSelect);

    expect(panel()).not.toBeNull();
  });

  it('closes when the pointer lands outside it', async () => {
    renderShell();
    await openPopover();
    expect(panel()).not.toBeNull();

    fireEvent.pointerDown(document.body);

    expect(panel()).toBeNull();
  });

  it('closes on Escape', async () => {
    renderShell();
    await openPopover();
    expect(panel()).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(panel()).toBeNull();
  });

  it('still changes language from inside it', async () => {
    renderShell('/', true);
    await openPopover();

    const open = panel() as HTMLElement;
    fireEvent.change(within(open).getByRole('combobox'), { target: { value: 'ru' } });

    expect(await screen.findByRole('button', { name: /ваш аккаунт/i })).toBeInTheDocument();
  });

  it('still signs out from inside it', async () => {
    renderShell();
    await openPopover();

    const open = panel() as HTMLElement;
    fireEvent.click(within(open).getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('makes the name a real link that opens the account and leaves the popover closed', async () => {
    renderShell();
    await openPopover();

    const open = panel() as HTMLElement;
    const accountLink = within(open).getByRole('link', { name: /manager.*open account/is });
    expect(accountLink).toHaveAttribute('href', '#/account');

    fireEvent.click(accountLink);

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(panel()).toBeNull();
  });

  it('removes its document listeners when it closes', async () => {
    renderShell();
    await openPopover();
    fireEvent.pointerDown(document.body);
    expect(panel()).toBeNull();

    // A leaked listener would keep answering after the panel is gone. Nothing
    // should react to either event now.
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(panel()).toBeNull();
    expect(await screen.findByRole('button', { name: /your account/i }))
      .toHaveAttribute('aria-expanded', 'false');
  });
});
