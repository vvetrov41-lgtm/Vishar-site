import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { renderWithSession } from './fixtures';

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
      'Sessions',
      'Clients',
    ]);
    expect(within(tabbar as HTMLElement).getByRole('button', { name: 'More' })).toBeInTheDocument();
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
