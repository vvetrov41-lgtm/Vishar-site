import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { App } from '../App';
import { createApi } from '../lib/api';
import { summariseClientWorkspace } from '../lib/client-workspace';
import type { Enquiry, Project } from '../lib/types';
import {
  CLIENT_ID,
  ENQUIRY,
  PROJECT,
  createFakeClient,
  renderWithSession,
} from './fixtures';

function trackedApi() {
  const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
  return { api: createApi(createFakeClient({ role: 'owner', queryCalls })), queryCalls };
}

function archivePredicate(calls: { table: string; method: string; args: unknown[] }[], table: string) {
  return calls.some((call) => call.table === table && call.method === 'is'
    && call.args[0] === 'archived_at' && call.args[1] === null);
}

describe('Phase 4: active lists and scoped archive history', () => {
  it('never widens the active enquiry queue and permits archive history only for a known client', async () => {
    const { api, queryCalls } = trackedApi();
    await api.listEnquiries();
    expect(archivePredicate(queryCalls, 'enquiries')).toBe(true);

    queryCalls.length = 0;
    await api.listEnquiries({ includeArchived: true });
    expect(archivePredicate(queryCalls, 'enquiries')).toBe(true);

    queryCalls.length = 0;
    await api.listEnquiries({ clientId: CLIENT_ID, includeArchived: true });
    expect(queryCalls).toContainEqual({ table: 'enquiries', method: 'eq', args: ['client_id', CLIENT_ID] });
    expect(archivePredicate(queryCalls, 'enquiries')).toBe(false);
  });

  it('applies the same archive boundary to projects', async () => {
    const { api, queryCalls } = trackedApi();
    await api.listProjects();
    expect(archivePredicate(queryCalls, 'projects')).toBe(true);

    queryCalls.length = 0;
    await api.listProjects(undefined, undefined, true);
    expect(archivePredicate(queryCalls, 'projects')).toBe(true);

    queryCalls.length = 0;
    await api.listProjects(CLIENT_ID, undefined, true);
    expect(queryCalls).toContainEqual({ table: 'projects', method: 'eq', args: ['client_id', CLIENT_ID] });
    expect(archivePredicate(queryCalls, 'projects')).toBe(false);
  });

  it('does not recommend work or request a deposit for an archived item still marked active', () => {
    const snapshot = summariseClientWorkspace({
      clientId: CLIENT_ID,
      enquiries: [{ ...ENQUIRY, archived_at: '2026-08-01T12:00:00Z' } as Enquiry],
      projects: [{ ...PROJECT, archived_at: '2026-08-01T12:00:00Z' } as Project],
      appointments: [],
      followUps: [],
      conversations: [],
      now: new Date('2026-08-31T12:00:00Z'),
    });
    expect(snapshot.openEnquiries).toHaveLength(0);
    expect(snapshot.activeProjects).toHaveLength(0);
    expect(snapshot.depositProject).toBeNull();
    expect(snapshot.nextAction.kind).toBe('none');
  });

  it('shows archived enquiry history on the client card and labels it clearly', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      queryCalls,
      extraEnquiries: [{
        id: 'e9999999-9999-4999-8999-999999999999',
        reference_number: 'ENQ-ARCHIVED-0002',
        status: 'reviewing',
        archived_at: '2026-08-01T12:00:00Z',
      }],
    });

    const work = (await screen.findByRole('heading', { name: 'What they want' })).closest('section') as HTMLElement;
    const archived = await within(work).findByText('ENQ-ARCHIVED-0002');
    expect(archived.closest('a')).toHaveAttribute('href', '#/enquiries/e9999999-9999-4999-8999-999999999999');
    expect(within(work).getByText(/Archived/)).toBeInTheDocument();
    const scoped = queryCalls.some((call) => call.table === 'enquiries' && call.method === 'eq'
      && call.args[0] === 'client_id' && call.args[1] === CLIENT_ID);
    expect(scoped).toBe(true);
    expect(archivePredicate(queryCalls, 'enquiries')).toBe(false);
  });
});

describe('Phase 4: project search without repeat API calls', () => {
  it('filters by client, project title and description locally and preserves the list on clearing', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
    renderWithSession(<App />, { role: 'booking_manager', path: '/projects', queryCalls });

    const search = await screen.findByRole('searchbox', { name: 'Search projects' });
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    const originalRequests = queryCalls.filter((call) => call.table === 'projects' && call.method === 'select').length;

    fireEvent.change(search, { target: { value: 'fixture client' } });
    expect(screen.getByText('Raven sleeve')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'rAvEn' } });
    expect(screen.getByText('Raven sleeve')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'nothing matches' } });
    expect(screen.queryByText('Raven sleeve')).not.toBeInTheDocument();
    expect(screen.getByText('No matching projects')).toBeInTheDocument();
    expect(screen.queryByText('How to create a project')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText('Raven sleeve')).toBeInTheDocument();
    expect(queryCalls.filter((call) => call.table === 'projects' && call.method === 'select')).toHaveLength(originalRequests);
  });
});
