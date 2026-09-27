import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { RouterProvider, matchRoute, useQueryState, useRouter } from '../lib/router';
import { ENQUIRY_ID, renderWithSession } from './fixtures';
import { confirmEnquiryTransition } from '../lib/enquiry-transition-confirm';

function Probe() {
  const { path, fullPath, canGoBack, goBack, navigate } = useRouter();
  const [q, setQ] = useQueryState('q');
  return (
    <div>
      <span data-testid="path">{path}</span>
      <span data-testid="full">{fullPath}</span>
      <span data-testid="back">{String(canGoBack)}</span>
      <input aria-label="q" value={q} onChange={(event) => setQ(event.target.value)} />
      <button type="button" onClick={() => navigate('/clients/abc')}>open</button>
      <button type="button" onClick={() => goBack('/clients')}>back</button>
    </div>
  );
}

describe('router context', () => {
  it('keeps the query out of route matching and in the address', () => {
    expect(matchRoute('/enquiries/:id', '/enquiries/abc?tab=notes')).toEqual({ id: 'abc' });
    render(<RouterProvider initialPath="/clients?q=anna"><Probe /></RouterProvider>);
    expect(screen.getByTestId('path')).toHaveTextContent('/clients');
    expect(screen.getByLabelText('q')).toHaveValue('anna');
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'bob' } });
    expect(screen.getByTestId('full')).toHaveTextContent('/clients?q=bob');
    fireEvent.change(screen.getByLabelText('q'), { target: { value: '' } });
    expect(screen.getByTestId('full').textContent).toBe('/clients');
  });

  it('goes back to the filtered list, and falls back on direct entry', () => {
    render(<RouterProvider initialPath="/clients?q=anna"><Probe /></RouterProvider>);
    expect(screen.getByTestId('back')).toHaveTextContent('false');
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('path')).toHaveTextContent('/clients/abc');
    expect(screen.getByTestId('back')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('full')).toHaveTextContent('/clients?q=anna');
    expect(screen.getByTestId('back')).toHaveTextContent('false');
    // Back at the first screen: going back again uses the fallback route
    // instead of leaving the CRM.
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('path')).toHaveTextContent('/clients');
  });
});

describe('list filters survive opening a record', () => {
  it('returns from an enquiry to the same filtered enquiry list', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/enquiries' });
    const status = await screen.findByLabelText('Status');
    fireEvent.change(status, { target: { value: 'new' } });
    const link = await screen.findByRole('link', { name: /ENQ-2026-0001/ });
    fireEvent.click(link);
    const back = await screen.findByRole('link', { name: '← Back' });
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('new'));
  });

  it('a direct link to an enquiry offers the section as the way back', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByRole('link', { name: /Back to Enquiries/ })).toBeInTheDocument();
  });
});

describe('reply to client without a thread', () => {
  it('offers the client channels instead of an empty inbox', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}`, conversations: [] });
    const hint = await screen.findByText(/No conversation with this client yet/);
    const block = hint.closest('.reply-fallback') as HTMLElement;
    expect(within(block).getByRole('link', { name: 'Message on WhatsApp' })).toBeInTheDocument();
    expect(within(block).getByRole('link', { name: 'Email the client' })).toHaveAttribute('href', expect.stringMatching(/^mailto:/));
    expect(screen.queryByRole('link', { name: 'Reply to client' })).not.toBeInTheDocument();
  });
});

describe('consequential enquiry moves', () => {
  it('asks before declining, closing or marking the deposit paid, not before routine moves', async () => {
    await expect(confirmEnquiryTransition('reviewing', 'en')).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    const pending = confirmEnquiryTransition('declined', 'en', 'Anna');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Decline this enquiry?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    await expect(pending).resolves.toBe(false);
  });
});
