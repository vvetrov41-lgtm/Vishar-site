import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { ARTIST_SCOPE_STORAGE_KEY } from '../lib/artist-scope';
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
    await screen.findByRole('heading', { level: 2, name: 'Enquiries' });

    const tabbar = container.querySelector('.tabbar');
    expect(tabbar).not.toBeNull();
    const links = within(tabbar as HTMLElement).getAllByRole('link');

    expect(links.map((link) => link.textContent)).toEqual([
      'Dashboard',
      'Enquiries',
      'Appointments',
      'Clients',
    ]);
    expect(within(tabbar as HTMLElement).getByRole('link', { name: 'Appointments' }))
      .toHaveAttribute('href', '#/appointments');
    expect(within(tabbar as HTMLElement).getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('keeps /sessions as an artist-scoped compatibility alias', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/sessions' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Appointments' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Artist' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Appointments' }).some(
      (link) => link.getAttribute('aria-current') === 'page'
    )).toBe(true);
  });

  it('groups owner overflow destinations by task area', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    await screen.findByRole('heading', { level: 2, name: 'Enquiries' });

    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'true'));

    const dialog = screen.getByRole('dialog', { name: 'Sections' });
    const operations = within(dialog).getByRole('group', { name: 'Operations' });
    const administration = within(dialog).getByRole('group', { name: 'Administration' });

    expect(within(operations).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Projects',
      'Activity',
    ]);
    expect(within(administration).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Users',
    ]);
  });

  it('does not render empty overflow groups for restricted roles', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/' });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sections' });
    const operations = within(dialog).getByRole('group', { name: 'Operations' });

    expect(within(operations).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Projects',
    ]);
    expect(within(dialog).queryByRole('group', { name: 'Administration' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Finance' })).not.toBeInTheDocument();
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
    const contact = screen.getByRole('heading', { level: 2, name: 'Contact submitted with this enquiry' });
    expect(actions.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('links an overdue dashboard follow-up directly to its enquiry', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/' });
    const followUp = await screen.findByRole('link', { name: /Chase references/ });
    expect(followUp).toHaveAttribute('href', `#/enquiries/${ENQUIRY_ID}`);
  });
});
