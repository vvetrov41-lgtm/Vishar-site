// The enquiry page, read the way an artist reads it: top down, on a phone.
//
// Three things are asserted here because all three used to be wrong. The page
// opened with a card per fact and the tattoo below the fold. Booking a session
// demanded a project that the operator had to go and create first. And a
// contact difference was announced without ever saying what differed.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { nextEnquiryAction } from '../lib/enquiry-next-action';
import { CLIENT_ID, ENQUIRY_ID, VLADIMIR_ARTIST_ID, renderWithSession } from './fixtures';

describe('what the enquiry is waiting for', () => {
  const base = { intakeComplete: true, hasUpcomingAppointment: false } as const;

  it('asks for a first reply while nobody has answered', () => {
    expect(nextEnquiryAction({ ...base, status: 'new' })).toBe('reply');
    expect(nextEnquiryAction({ ...base, status: 'reviewing' })).toBe('reply');
  });

  it('asks for a session once the talking is done', () => {
    expect(nextEnquiryAction({ ...base, status: 'accepted' })).toBe('bookSession');
    expect(nextEnquiryAction({ ...base, status: 'converted' })).toBe('bookSession');
  });

  it('waits for the client rather than the operator where it should', () => {
    expect(nextEnquiryAction({ ...base, status: 'waiting_for_client' })).toBe('chase');
    expect(nextEnquiryAction({ ...base, status: 'deposit_requested' })).toBe('awaitDeposit');
    expect(nextEnquiryAction({ ...base, status: 'new', intakeComplete: false })).toBe('awaitIntake');
  });

  it('lets a booked time outrank a status nobody pressed', () => {
    // The production shape: an enquiry still `new` because no status button was
    // pressed, with a session already in the diary.
    expect(nextEnquiryAction({ ...base, status: 'new', hasUpcomingAppointment: true }))
      .toBe('awaitAppointment');
  });

  it('has nothing to ask of a finished enquiry', () => {
    expect(nextEnquiryAction({ ...base, status: 'declined' })).toBe('none');
    expect(nextEnquiryAction({ ...base, status: 'closed' })).toBe('none');
  });
});

describe('the enquiry summary', () => {
  it('carries the whole recognisable enquiry before any other card', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    const reference = await screen.findByRole('heading', { level: 2, name: 'ENQ-2026-0001' });
    const summary = reference.closest('section');
    expect(summary).not.toBeNull();

    // Who, how to reach them, and what they want - without scrolling.
    expect(within(summary!).getByText('Fixture Client')).toBeInTheDocument();
    expect(within(summary!).getByText('+44 7700 900 000')).toBeInTheDocument();
    expect(within(summary!).getByText('@fixture')).toBeInTheDocument();
    expect(within(summary!).getByText(/Waiting on:/)).toBeInTheDocument();
  });

  it('collapses the sections that are usually empty to a heading and a count', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    const notes = await screen.findByText('Internal notes');
    const section = notes.closest('details');
    expect(section).not.toBeNull();
    expect(section).not.toHaveAttribute('open');

    // Reference images are not one of them: they are what the artist came for.
    const references = screen.getByRole('heading', { level: 2, name: 'Reference images' });
    expect(references.closest('details')).toBeNull();
  });
});

describe('booking a tattoo session from an enquiry', () => {
  it('sends the enquiry and no project, and lets the database make one', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    fireEvent.click(await screen.findByText('Book a session'));

    // No "choose a project" barrier, and no instruction to go and create one.
    expect(screen.queryByText(/belongs to a project/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find free times' }));

    const slots = await screen.findAllByRole('button', { name: /free here/ });
    fireEvent.click(slots[0]);
    const summary = await screen.findByRole('group', { name: 'Booking summary' });
    fireEvent.click(within(summary).getByRole('button', { name: 'Book it' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'schedule_appointment');
      expect(call?.args?.p_enquiry_id).toBe(ENQUIRY_ID);
      expect(call?.args?.p_project_id).toBeNull();
      expect(call?.args?.p_artist_id).toBe(VLADIMIR_ARTIST_ID);
      expect(call?.args?.p_client_id).toBe(CLIENT_ID);
    });
  });
});

describe('a contact difference the operator can act on', () => {
  it('updates only the fields that were ticked, and never the enquiry', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    // The phone number is what differs in the fixture.
    expect(await screen.findByText('Enquiry:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use the enquiry value' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update the ticked fields' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'update_client_details');
      expect(call).toBeDefined();
      const client = call!.args?.p_client as Record<string, unknown>;
      // The ticked field takes the enquiry's value...
      expect(client.phone).toBe('+447700900099');
      // ...and everything else keeps the card's.
      expect(client.full_name).toBe('Fixture Client');
      expect(client.email).toBe('fixture@example.test');
    });

    // The submitted enquiry data is evidence, not a draft: nothing writes it.
    expect(rpcCalls.find((entry) => entry.name === 'update_enquiry_details')).toBeUndefined();
  });
});
