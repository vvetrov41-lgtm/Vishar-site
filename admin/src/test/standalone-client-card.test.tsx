// A client card that exists without an enquiry or project.
//
// Creating a client from an inbox conversation must leave the operator on a
// card they can actually use: it shows its artist, takes internal notes and
// records a staff-confirmed privacy acknowledgement, all without first
// inventing an enquiry or project for it.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  CONVERSATION_ID,
  VLADIMIR_ARTIST_ID,
  renderWithSession,
} from './fixtures';

const STANDALONE = {
  enquiries: [],
  projects: [],
  client_artist_links: [{ client_id: CLIENT_ID, artist_id: VLADIMIR_ARTIST_ID }],
};

describe('standalone client card', () => {
  it('creates a client from a conversation with the privacy acknowledgement and opens the card', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a client' }));

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Fixture Client' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'adelino.example@live.co.uk' } });
    fireEvent.click(screen.getByLabelText(/acknowledged the current privacy notice/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'create_client_from_communication');
      expect(call?.args).toEqual({
        p_conversation_id: CONVERSATION_ID,
        p_full_name: 'Fixture Client',
        p_email: 'adelino.example@live.co.uk',
        p_phone: null,
        p_instagram: '@synthetic.sender',
        p_privacy_acknowledged: true,
      });
    });
    // No enquiry is minted to make the card work.
    expect(rpcCalls.some((entry) => entry.name === 'create_enquiry_from_communication')).toBe(false);
    // The operator lands on the new card.
    expect(await screen.findByRole('heading', { name: 'Fixture Client' })).toBeInTheDocument();
  });

  it('does not acknowledge privacy unless the operator ticks it', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a client' }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Walk-in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'create_client_from_communication');
      expect(call?.args?.p_privacy_acknowledged).toBe(false);
    });
  });

  it('explains a duplicate instead of a generic failure', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
      failRpc: 'create_client_from_communication',
      failRpcError: { code: '23505', message: 'a client with this email or phone already exists' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a client' }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Walk-in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/already exists\. Link that client/)).toBeInTheDocument();
  });

  it('shows the artist of a card with no enquiry or project', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      tableRows: STANDALONE,
    });

    const header = (await screen.findByRole('heading', { name: 'Fixture Client' })).closest('section');
    expect(await within(header as HTMLElement).findByLabelText('Artist: Vladimir Vishar')).toBeInTheDocument();
  });

  it('adds an internal note to the client itself', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/clients/${CLIENT_ID}`,
      tableRows: STANDALONE,
    });

    const composer = await screen.findByLabelText('Add a note');
    fireEvent.change(composer, { target: { value: 'Prefers evenings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'create_internal_note');
      expect(call?.args).toEqual({
        p_body: 'Prefers evenings',
        p_client_id: CLIENT_ID,
        p_enquiry_id: null,
        p_project_id: null,
      });
    });
  });

  it('records a privacy acknowledgement on an existing card', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/clients/${CLIENT_ID}`,
      tableRows: STANDALONE,
    });

    expect(await screen.findByText('Not recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'The client acknowledged the privacy notice' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'record_client_privacy_acknowledgement');
      expect(call?.args).toEqual({ p_client_id: CLIENT_ID, p_artist_id: VLADIMIR_ARTIST_ID });
    });
  });

  it('shows an existing acknowledgement instead of offering to record it again', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      tableRows: {
        ...STANDALONE,
        client_privacy_acknowledgements: [{
          id: 'ack-1',
          artist_id: VLADIMIR_ARTIST_ID,
          privacy_notice_version: '2026-07-29',
          acknowledged_at: '2026-10-19T19:30:00Z',
          source: 'communication_client_created',
        }],
      },
    });

    expect(await screen.findByText(/Client acknowledged it · confirmed by staff/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'The client acknowledged the privacy notice' })).not.toBeInTheDocument();
  });

  it('does not present an old acknowledgement as current when the version check fails', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      failRpc: 'get_privacy_notice_version',
      tableRows: {
        ...STANDALONE,
        client_privacy_acknowledgements: [{
          id: 'ack-1',
          artist_id: VLADIMIR_ARTIST_ID,
          privacy_notice_version: '2026-07-29',
          acknowledged_at: '2026-10-19T19:30:00Z',
          source: 'communication_client_created',
        }],
      },
    });

    expect(await screen.findByText(/Could not check the current privacy notice/)).toBeInTheDocument();
    expect(screen.queryByText(/Client acknowledged it · confirmed by staff/)).not.toBeInTheDocument();
  });

  it('offers to record a new notice version when only an earlier one was acknowledged', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'owner',
      path: `/clients/${CLIENT_ID}`,
      privacyNoticeVersion: '2026-11-01',
      tableRows: {
        ...STANDALONE,
        client_privacy_acknowledgements: [{
          id: 'ack-1',
          artist_id: VLADIMIR_ARTIST_ID,
          privacy_notice_version: '2026-07-29',
          acknowledged_at: '2026-10-19T19:30:00Z',
          source: 'communication_client_created',
        }],
      },
    });

    expect(await screen.findByText(/for an earlier notice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'The client acknowledged the privacy notice' }));
    await waitFor(() => {
      expect(rpcCalls.some((entry) => entry.name === 'record_client_privacy_acknowledgement')).toBe(true);
    });
  });
});
