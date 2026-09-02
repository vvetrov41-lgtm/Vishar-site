import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { groupNavItems, navGroupFor } from '../components/AppShell';
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
    const money = within(dialog).getByRole('group', { name: 'Money' });
    const setup = within(dialog).getByRole('group', { name: 'Setup' });

    expect(within(work).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Enquiries',
      'Projects',
    ]);
    expect(within(money).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Payments',
    ]);
    expect(within(setup).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Time off',
      'Automatic messages',
      // Organizations is absent here on purpose: it is appended from
      // public.control_plane_access(), and this session belongs to none.
      'Integrations',
      'Notifications',
      'Users',
      'Activity',
    ]);
  });

  it('does not render empty overflow groups for restricted roles', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/' });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sections' });

    expect(within(dialog).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Enquiries',
      'Projects',
      'Time off',
      'Automatic messages',
      'Notifications',
    ]);
    // A read-only account reaches no money and no administration destination,
    // so neither group is rendered as an empty shell.
    expect(within(dialog).queryByRole('group', { name: 'Money' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Setup' })).toBeInTheDocument();
  });

  it('shows artist scope only where it affects the page', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/clients' });
    await screen.findByText('Fixture Client');

    expect(screen.queryByRole('combobox', { name: 'Artist' })).not.toBeInTheDocument();
    expect(screen.getByText('Shared records')).toBeInTheDocument();
    expect(screen.getByText('Clients are not filtered by the selected artist.')).toBeInTheDocument();
  });

  it('marks owner administration as global instead of artist-scoped', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users' });
    await screen.findByText('Manager');

    expect(screen.queryByRole('combobox', { name: 'Artist' })).not.toBeInTheDocument();
    expect(screen.getByText('Global section')).toBeInTheDocument();
    expect(screen.getByText('This section is not filtered by artist.')).toBeInTheDocument();
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

    const actions = await screen.findByRole('heading', { level: 2, name: 'Enquiry actions' });
    const contact = screen.getByRole('heading', { level: 2, name: 'Current client details' });
    expect(actions.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      .toEqual(['Work', 'Money', 'Setup']);
    // The group label is a divider, not part of the document outline: three
    // headings above every page's own would bury the page title.
    expect(within(sidebar).queryAllByRole('heading')).toHaveLength(0);
  });
});