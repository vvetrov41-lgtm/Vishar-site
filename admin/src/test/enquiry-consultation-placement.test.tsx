// Booking a consultation is a workflow action, not a record edit.
//
// It used to live inside the "Edit enquiry" panel: reachable only after
// pressing Edit, gone again while the record was being edited, and gated on
// editEnquiry on top of its own manageSessions check. Someone who may book but
// may not edit an enquiry could not book from the enquiry at all.

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { ENQUIRY_ID, renderWithSession } from './fixtures';

describe('scheduling a consultation from an enquiry', () => {
  it('sits with the other enquiry actions, without pressing Edit first', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });

    const actions = await screen.findByRole('heading', { level: 2, name: 'Enquiry actions' });
    const schedule = await screen.findByRole('heading', { name: 'Schedule a consultation' });

    // Inside the actions section, and ahead of the record content it used to
    // be buried in.
    expect(actions.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const project = screen.getByRole('heading', { level: 2, name: 'The project' });
    expect(schedule.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays hidden from a role that may not manage appointments', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/enquiries/${ENQUIRY_ID}` });

    await screen.findByRole('heading', { level: 2, name: 'The project' });
    expect(screen.queryByRole('heading', { name: 'Schedule a consultation' })).not.toBeInTheDocument();
  });
});
