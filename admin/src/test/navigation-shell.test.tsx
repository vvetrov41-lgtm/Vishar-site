import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { compactOverflowGroups, groupNavItems, navGroupFor } from '../components/AppShell';
import { ARTIST_SCOPE_STORAGE_KEY } from '../lib/artist-scope';
import { NAV_ITEMS } from '../lib/permissions';
import {
  ENQUIRY_ID,
  KRISTINA_ARTIST_ID,
  PROJECT_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  document.body.style.overflow = '';
});

describe('responsive navigation shell', () => {
  it('keeps the mobile task order explicit', async () => {
    const { container } = renderWithSession(<App />, { role: 'owner', path: '/' });
    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    const tabbar = container.querySelector('.tabbar');
    expect(tabbar).not.toBeNull();
    const links = within(tabbar as HTMLElement).getAllByRole('link');

    // What a day is actually spent on: what needs me, who is waiting, when,
    // and who this is. Enquiries and Projects are reached from those, so neither
    // holds a thumb slot any more.
    expect(links.map((link) => link.textContent)).toEqual([
      'Today',
      'Inbox',
      'Calendar',
      'Clients',
    ]);
    expect(within(tabbar as HTMLElement).getByRole('link', { name: 'Calendar' }))
      .toHaveAttribute('href', '#/appointments');
    expect(within(tabbar as HTMLElement).getByRole('link', { name: 'Inbox' }))
      .toHaveAttribute('href', '#/inbox');
    expect(within(tabbar as HTMLElement).getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('keeps /sessions as an artist-scoped compatibility alias', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/sessions' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Artist' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Calendar' }).some(
      (link) => link.getAttribute('aria-current') === 'page'
    )).toBe(true);
  });

  it('groups owner overflow destinations by task area', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'true'));

    const dialog = screen.getByRole('dialog', { name: 'Sections' });
    const work = within(dialog).getByRole('group', { name: 'Work' });
    const manage = within(dialog).getByRole('group', { name: 'Manage' });

    expect(within(work).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Enquiries',
      'Follow-ups',
      'Projects',
      // Statistics is work, not setup: it is read every week rather than
      // configured once.
      'Statistics',
    ]);
    // Eight money and setup screens became two hub entries: the sheet lists
    // six links instead of twelve.
    expect(within(manage).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Money',
      'Settings',
    ]);
    expect(within(manage).getByRole('link', { name: 'Money' })).toHaveAttribute('href', '#/money');
    expect(within(manage).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/settings');
    expect(within(dialog).queryByRole('group', { name: 'Money' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('lists every screen a hub stands for on the hub page, and nothing more', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/settings' });
    const section = (await screen.findByRole('heading', { level: 2, name: 'Settings' })).closest('section') as HTMLElement;
    expect(within(section).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '#/availability',
      '#/automations',
      // Organizations is absent here on purpose: it is appended from
      // public.control_plane_access(), and this session belongs to none.
      '#/integrations',
      '#/notifications',
      '#/users',
      '#/activity',
    ]);
  });

  it('shows the money hub with invoices and payments for the owner', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/money' });
    // An index of screens reads no records, so no artist-filter notice.
    expect(await screen.findByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('This section covers every artist.')).not.toBeInTheDocument();
    const section = (await screen.findByRole('heading', { level: 2, name: 'Money' })).closest('section') as HTMLElement;
    expect(within(section).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '#/invoices',
      '#/payments',
    ]);
  });

  it('refuses a hub with nothing behind it for this role', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/money' });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('marks the hub entry current while on one of its screens', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/payments' });
    const more = await screen.findByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-current', 'page');
    fireEvent.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Sections' });
    expect(within(dialog).getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not render empty overflow groups for restricted roles', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/' });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sections' });

    expect(within(dialog).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Enquiries',
      'Follow-ups',
      'Projects',
      'Statistics',
      // Time off, Automatic messages and Notifications behind one hub.
      'Settings',
    ]);
    // A read-only account reaches no money destination, so no Money entry is
    // offered as an empty hub.
    expect(within(dialog).queryByRole('link', { name: 'Money' })).not.toBeInTheDocument();
  });

  it('shows artist scope only where it affects the page', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/clients' });
    await screen.findByText('Fixture Client');

    expect(screen.queryByRole('combobox', { name: 'Artist' })).not.toBeInTheDocument();
    expect(screen.getByText('All artists')).toBeInTheDocument();
    expect(screen.getByText('Clients are shared: the list does not depend on the selected artist.')).toBeInTheDocument();
  });

  it('marks owner administration as global instead of artist-scoped', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users' });
    await screen.findByText('Manager');

    expect(screen.queryByRole('combobox', { name: 'Artist' })).not.toBeInTheDocument();
    expect(screen.getByText('All artists')).toBeInTheDocument();
    expect(screen.getByText('This section covers every artist.')).toBeInTheDocument();
  });

  it('retains artist selection on artist-owned queues', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/enquiries' });
    expect(await screen.findByRole('combobox', { name: 'Artist' })).toBeInTheDocument();
  });

  it('treats lifecycle automations as artist-scoped', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/automations' });
    expect(await screen.findByRole('combobox', { name: 'Artist' })).toBeInTheDocument();
  });

  it('contains focus in More, locks scrolling and restores the trigger on dismissal', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    const more = await screen.findByRole('button', { name: 'More' });
    more.focus();
    fireEvent.click(more);

    const dialog = await screen.findByRole('dialog', { name: 'Sections' });
    const links = within(dialog).getAllByRole('link');

    await waitFor(() => expect(links[0]).toHaveFocus());
    expect(document.body.style.overflow).toBe('hidden');

    links[links.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(links[0]).toHaveFocus();

    links[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(links[links.length - 1]).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sections' })).not.toBeInTheDocument());
    expect(more).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('detail-route continuity', () => {
  it('provides a stable contextual return link', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });
    const back = await screen.findByRole('link', { name: /Back to Projects/ });
    expect(back).toHaveAttribute('href', '#/projects');
  });

  it('shows a record artist mismatch and deliberately switches the filter', async () => {
    window.localStorage.setItem(ARTIST_SCOPE_STORAGE_KEY, KRISTINA_ARTIST_ID);
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });

    expect(await screen.findByText('Artist: Vladimir Vishar')).toBeInTheDocument();
    expect(screen.getByText('The CRM filter is currently set to Kristina Vishar.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Vladimir Vishar' }));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Artist' })).toHaveValue(VLADIMIR_ARTIST_ID);
    });
  });

  it('places enquiry workflow actions before long record content', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });

    const actions = await screen.findByRole('heading', { level: 2, name: 'Next action' });
    const record = screen.getByRole('heading', { level: 2, name: 'The project' });
    expect(actions.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Every contact detail sits in the summary above the workflow; there is no
    // second client block further down.
    const email = screen.getByText('fixture@example.test');
    expect(email.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Current client details')).not.toBeInTheDocument();
  });

  it('links an overdue dashboard follow-up directly to its enquiry', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    const followUp = await screen.findByRole('link', { name: /Chase references/ });
    expect(followUp).toHaveAttribute('href', `#/enquiries/${ENQUIRY_ID}`);
  });
});
describe('one navigation grouping', () => {
  it('places every navigation destination in a group, in a stable order', () => {
    const groups = groupNavItems(NAV_ITEMS);
    expect(groups.map((group) => group.id)).toEqual(['work', 'money', 'setup']);
    expect(groups.flatMap((group) => group.items).length).toBe(NAV_ITEMS.length);
  });

  it('groups by how often a destination is opened, not by which table it reads', () => {
    // Time off reads the same schedule as the diary and is still setup: it is
    // configured once and then left alone.
    expect(navGroupFor('/appointments')).toBe('work');
    expect(navGroupFor('/availability')).toBe('setup');
    expect(navGroupFor('/payments')).toBe('money');
    expect(navGroupFor('/integrations/calendar')).toBe('setup');
    expect(navGroupFor('/workspaces/anything')).toBe('setup');
  });

  it('gives the desktop sidebar the same groups as the phone overflow sheet', async () => {
    const { container } = renderWithSession(<App />, { role: 'owner', path: '/' });
    await screen.findByRole('heading', { level: 2, name: 'Needs you now' });

    const sidebar = container.querySelector('.sidebar-nav') as HTMLElement;
    expect(within(sidebar).getAllByRole('group').map((group) => group.getAttribute('aria-label')))
      .toEqual(['Work', 'Money', 'Settings']);
    // The group label is a divider, not part of the document outline: three
    // headings above every page's own would bury the page title.
    expect(within(sidebar).queryAllByRole('heading')).toHaveLength(0);
    // The desktop keeps every screen one click away and also names the hubs.
    expect(within(sidebar).getByRole('link', { name: 'Money' })).toHaveAttribute('href', '#/money');
    expect(within(sidebar).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/settings');
    expect(within(sidebar).getByRole('link', { name: 'Payments' })).toBeInTheDocument();
  });

  it('links a hub with a single screen straight to that screen', () => {
    const only = NAV_ITEMS.filter((item) => ['/enquiries', '/invoices', '/notifications', '/users'].includes(item.path));
    const groups = compactOverflowGroups(only);
    expect(groups.map((group) => [group.id, group.items.map((item) => item.path)])).toEqual([
      ['work', ['/enquiries']],
      ['manage', ['/invoices', '/settings']],
    ]);
  });
});