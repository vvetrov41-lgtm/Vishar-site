import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { App } from '../App';
import { ENQUIRY_ID, PROJECT_ID, renderWithSession } from './fixtures';

describe('CRM IA phase 1', () => {
  it('project page: one tap to each part, money grouped after sessions', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });
    const jump = await screen.findByRole('navigation', { name: 'Project sections' });
    const buttons = within(jump).getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Sessions', 'Money', 'Notes', 'Activity']);
    // Buttons, not #links: the CRM routes with the hash.
    expect(within(jump).queryAllByRole('link')).toHaveLength(0);

    const sessions = document.getElementById('project-sessions');
    const money = document.getElementById('project-money');
    expect(sessions).not.toBeNull();
    expect(money).not.toBeNull();
    expect(sessions!.compareDocumentPosition(money!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(jump).getByRole('button', { name: 'Money' }));
  });

  it('record header: Back and the artist share one row', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });
    const header = await screen.findByRole('navigation', { name: 'Record navigation' });
    expect(within(header).getByRole('link', { name: /Back/ })).toBeInTheDocument();
    expect(within(header).getByRole('status')).toHaveTextContent(/^Artist: /);
  });

  it('enquiries: one compact toolbar with labelled search and status', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/enquiries' });
    const search = await screen.findByLabelText('Search enquiries');
    const status = screen.getByLabelText('Status');
    const toolbar = search.closest('.enquiry-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar).toContainElement(status);
    expect(within(toolbar as HTMLElement).getByRole('group', { name: 'Enquiry view' })).toBeInTheDocument();
  });
});
