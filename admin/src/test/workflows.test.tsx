// Critical workflow tests.
//
// These check that the interface reaches the database through the named
// workflow RPCs with the right arguments — never by writing a table directly —
// and that a refusal is shown to the person rather than swallowed.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { createApi } from '../lib/api';
import { createFakeClient, renderWithSession, ENQUIRY_ID, PROJECT_ID, MANAGER_ID } from './fixtures';

describe('enquiry workflow', () => {
  it('changes status through transition_enquiry_status', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: 'Reviewing' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'transition_enquiry_status');
      expect(call).toBeDefined();
      expect(call!.args).toEqual({ p_enquiry_id: ENQUIRY_ID, p_to_status: 'reviewing' });
    });
  });

  it('assigns through assign_enquiry', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    const select = await screen.findByLabelText('Assignee');
    fireEvent.change(select, { target: { value: MANAGER_ID } });

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'assign_enquiry');
      expect(call).toBeDefined();
      expect(call!.args).toEqual({ p_enquiry_id: ENQUIRY_ID, p_profile_id: MANAGER_ID });
    });
  });

  it('converts through convert_enquiry_to_project', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: /convert to project/i }));

    await waitFor(() => {
      expect(rpcCalls.some((entry) => entry.name === 'convert_enquiry_to_project')).toBe(true);
    });
  });

  it('saves a note through create_internal_note', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}`, rpcCalls });

    const textarea = await screen.findByLabelText('Add a note');
    fireEvent.change(textarea, { target: { value: 'Asked for a wider placement photo.' } });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'create_internal_note');
      expect(call).toBeDefined();
      expect(call!.args.p_body).toBe('Asked for a wider placement photo.');
      expect(call!.args.p_enquiry_id).toBe(ENQUIRY_ID);
    });
  });

  it('will not save an empty note', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/enquiries/${ENQUIRY_ID}` });
    await screen.findByLabelText('Add a note');
    expect(screen.getByRole('button', { name: /save note/i })).toBeDisabled();
  });
});

describe('session workflow', () => {
  it('proposes a session through schedule_session, not as confirmed', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: /propose a session/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'schedule_session');
      expect(call).toBeDefined();
      // A proposed session must never be created as confirmed: confirming is
      // what queues a calendar entry.
      expect(call!.args.p_status).toBe('proposed');
      expect(call!.args.p_project_id).toBe(PROJECT_ID);
    });
  });

  it('confirms a session through set_session_status', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'set_session_status');
      expect(call).toBeDefined();
      expect(call!.args.p_status).toBe('confirmed');
    });
  });

  it('says plainly that no calendar is connected', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText(/no calendar provider is connected/i)).toBeInTheDocument();
  });
});

describe('user management workflow', () => {
  it('changes a role through set_profile_role', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/users', rpcCalls });

    const select = await screen.findByLabelText('Role for Reader');
    fireEvent.change(select, { target: { value: 'booking_manager' } });

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'set_profile_role');
      expect(call).toBeDefined();
      expect(call!.args.p_role).toBe('booking_manager');
    });
  });

  it('deactivates through set_profile_active', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'owner', path: '/users', rpcCalls });

    await screen.findByLabelText('Role for Reader');
    const row = screen.getByLabelText('Role for Reader').closest('.row') as HTMLElement;
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'set_profile_active');
      expect(call).toBeDefined();
      expect(call!.args.p_is_active).toBe(false);
    });
  });
});

describe('refusals reach the person', () => {
  it('turns an RLS denial into a message that says what to do', async () => {
    const api = createApi(createFakeClient({ role: 'booking_manager' }));
    await expect(api.setProfileRole('someone', 'owner')).rejects.toThrow(/do not have permission/i);
  });

  it('refuses a manager the owner-only finance RPC', async () => {
    const api = createApi(createFakeClient({ role: 'booking_manager' }));
    await expect(api.updateDeposit(PROJECT_ID, 150, 'paid')).rejects.toThrow(/do not have permission/i);
  });

  it('refuses read_only every write it might try', async () => {
    const api = createApi(createFakeClient({ role: 'read_only' }));
    await expect(api.transitionEnquiry(ENQUIRY_ID, 'reviewing')).rejects.toThrow(/permission/i);
    await expect(api.createNote('x', { enquiryId: ENQUIRY_ID })).rejects.toThrow(/permission/i);
    await expect(api.assignEnquiry(ENQUIRY_ID, null)).rejects.toThrow(/permission/i);
  });

  it('reports a failed load instead of returning silently empty', async () => {
    const api = createApi(createFakeClient({ role: 'owner', failTable: 'clients' }));
    await expect(api.listClients()).rejects.toThrow(/could not load clients/i);
  });

  it('shows the error state on screen when a load fails', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/clients', failTable: 'clients' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('no credential ever reaches a screen', () => {
  it('never renders anything resembling a key or token', async () => {
    const { container } = renderWithSession(<App />, { role: 'owner', path: '/users' });
    await screen.findByLabelText('Role for Owner');

    const text = container.textContent ?? '';
    for (const forbidden of ['service_role', 'anon key', 'Bearer ', 'eyJ', 'apikey']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('does not persist a signed URL anywhere in the markup after use', async () => {
    const { container } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/enquiries/${ENQUIRY_ID}`,
    });
    await screen.findByText('Reference images');
    const image = await screen.findByRole('img');

    // The signed URL is on the image element only — it is never written into a
    // copyable link, a data attribute or visible text.
    expect(image.getAttribute('src')).toContain('token=short-lived');
    expect(container.textContent ?? '').not.toContain('token=short-lived');
    expect(container.querySelector('a[href*="token=short-lived"]')).toBeNull();
  });
});
