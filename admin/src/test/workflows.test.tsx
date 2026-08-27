// Critical workflow tests.
//
// These check that the interface reaches the database through the named
// workflow RPCs with the right arguments — never by writing a table directly —
// and that a refusal is shown to the person rather than swallowed.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { createApi } from '../lib/api';
import {
  createFakeClient,
  renderWithSession,
  CLIENT_ID,
  ENQUIRY_ID,
  PROJECT_ID,
  SESSION_ID,
  MANAGER_ID,
} from './fixtures';

describe('enquiry workflow', () => {
  it('shows the immutable submitted contact and a client-match conflict warning', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/enquiries/${ENQUIRY_ID}`,
    });

    expect(await screen.findByText('+447700900099')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/matched different client cards/i);
    expect(screen.getByText('+447700900000')).toBeInTheDocument();
  });

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
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/enquiries/${ENQUIRY_ID}`,
      enquiryStatus: 'accepted',
      rpcCalls,
    });

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

describe('appointment workflow', () => {
  it('proposes an appointment through schedule_appointment, not as confirmed', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}`, rpcCalls });

    fireEvent.change(await screen.findByLabelText('Proposed start'), {
      target: { value: '2026-09-10T11:00' },
    });
    fireEvent.change(screen.getByLabelText('Proposed end'), {
      target: { value: '2026-09-10T17:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /propose appointment/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'schedule_appointment');
      expect(call).toBeDefined();
      // A proposed appointment must never be created as confirmed: confirming
      // is the separate lifecycle action that may queue a future calendar job.
      expect(call!.args.p_status).toBe('proposed');
      expect(call!.args.p_project_id).toBe(PROJECT_ID);
      expect(call!.args.p_client_id).toBe(CLIENT_ID);
      expect(call!.args.p_appointment_type).toBe('tattoo_session');
    });
  });

  it('requests a project deposit from the server-calculated amount, never a browser amount', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}`, rpcCalls });

    // The panel renders the server preview rather than recomputing the policy.
    expect(await screen.findByText('£700.00')).toBeInTheDocument();
    expect(rpcCalls.some((entry) => entry.name === 'preview_project_deposit')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /create deposit link for £700\.00/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'request_project_deposit');
      expect(call).toBeDefined();
      expect(call!.args.p_project_id).toBe(PROJECT_ID);
      // The authoritative amount is recalculated server-side. The browser must
      // not be able to state an amount, an artist or a policy version.
      expect(call!.args).not.toHaveProperty('p_amount');
      expect(call!.args).not.toHaveProperty('p_artist_id');
      expect(call!.args).not.toHaveProperty('p_policy_id');
    });

    expect(rpcCalls.some((entry) => entry.name === 'update_project_deposit')).toBe(false);
  });

  it('no longer claims the public bank-transfer redirect runtime is dormant', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });

    await screen.findByText('£700.00');
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/redirect runtime is activated/i)).not.toBeInTheDocument();
  });

  it('confirms an appointment through set_appointment_status', async () => {
    const rpcCalls: { name: string; args: any }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}`, rpcCalls });

    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'set_appointment_status');
      expect(call).toBeDefined();
      expect(call!.args.p_appointment_id).toBe(SESSION_ID);
      expect(call!.args.p_status).toBe('confirmed');
    });
  });

  it('shows the appointment actual calendar sync state instead of a stale global warning', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/projects/${PROJECT_ID}` });
    expect(await screen.findByText(/Calendar: not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/no calendar provider is connected/i)).not.toBeInTheDocument();
  });
});

describe('detail query scope', () => {
  it('loads a client enquiry history with a database client_id filter', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/clients/${CLIENT_ID}`,
      queryCalls,
    });

    await screen.findByText('Fixture Client');
    await waitFor(() => {
      expect(queryCalls).toContainEqual({
        table: 'enquiries',
        method: 'eq',
        args: ['client_id', CLIENT_ID],
      });
    });
  });

  it('loads project activity with a database project_id filter', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/projects/${PROJECT_ID}`,
      queryCalls,
    });

    await screen.findByText('Raven sleeve');
    await waitFor(() => {
      expect(queryCalls).toContainEqual({
        table: 'activity_log',
        method: 'eq',
        args: ['project_id', PROJECT_ID],
      });
    });
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

  it('does not disguise owner-only data failures as empty finance or jobs', async () => {
    const financeApi = createApi(createFakeClient({ role: 'owner', failTable: 'projects_finance' }));
    await expect(financeApi.getProjectFinance(PROJECT_ID)).rejects.toThrow(/could not load project finance/i);

    const sessionsApi = createApi(createFakeClient({ role: 'owner', failTable: 'sessions_finance' }));
    await expect(sessionsApi.listSessionFinance(PROJECT_ID)).rejects.toThrow(/could not load session finance/i);

    const jobsApi = createApi(createFakeClient({ role: 'owner', failTable: 'integration_outbox' }));
    await expect(jobsApi.listFailedJobs()).rejects.toThrow(/could not load failed integration jobs/i);
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
