// Communications inbox behaviour.
//
// The assertions here are about the product rules that matter operationally:
// every channel appears in one list, an unknown sender is never silently
// promoted to an enquiry, and no browser-supplied artist, provider account or
// recipient reaches the server.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import {
  CLIENT_ID,
  CONVERSATION_ID,
  LINKED_CONVERSATION_ID,
  renderWithSession,
} from './fixtures';
import {
  createCommunicationsApi,
  participantLabel,
} from '../lib/communications-api';
import {
  createInstagramConnectionsApi,
  readInstagramConnectorOrigin,
} from '../lib/instagram-connections-api';
import type { CrmClient } from '../lib/api';

describe('inbox list', () => {
  it('shows every channel in one list, with a preview and an unread marker', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/inbox' });

    expect(await screen.findByText('Can we move Friday?')).toBeInTheDocument();
    expect(screen.getByText('Thanks, see you then')).toBeInTheDocument();
    expect(screen.getAllByText('Instagram').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WhatsApp').length).toBeGreaterThan(0);
    expect(screen.getByText('Unread')).toBeInTheDocument();

    // The stranger who messaged the studio number is not in the working list,
    // and nothing here says the operator owes them anything.
    expect(screen.queryByText('Do you do cover ups?')).not.toBeInTheDocument();
    expect(screen.queryByText('Not linked')).not.toBeInTheDocument();
  });

  it('asks the server for linked conversations rather than filtering strangers out afterwards', async () => {
    const { rpcCalls } = renderWithSession(<App />, { role: 'booking_manager', path: '/inbox' });
    await screen.findByText('Can we move Friday?');

    // A page of 50 spent on unknown senders would push real conversations off
    // the end of the list before any browser-side filter could see them.
    const listed = rpcCalls.filter((call) => call.name === 'list_communication_conversations');
    expect(listed.at(-1)?.args?.p_link_state).toBe('linked');
  });

  it('filters by channel through the server, not in the browser', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/inbox',
    });
    await screen.findByText('Can we move Friday?');

    fireEvent.click(screen.getByRole('tab', { name: 'Instagram' }));
    await waitFor(() => expect(screen.queryByText('Thanks, see you then')).not.toBeInTheDocument());
    expect(screen.getByText('Can we move Friday?')).toBeInTheDocument();

    const listed = rpcCalls.filter((call) => call.name === 'list_communication_conversations');
    expect(listed.at(-1)?.args?.p_channel).toBe('instagram');
    // A bounded page size is always requested, so a busy account cannot pull
    // an unbounded history into the inbox.
    expect(listed.at(-1)?.args?.p_limit).toBe(50);
  });

  it('filters WhatsApp separately', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/inbox',
    });
    await screen.findByText('Thanks, see you then');

    fireEvent.click(screen.getByRole('tab', { name: 'WhatsApp' }));
    await waitFor(() => expect(screen.queryByText('Can we move Friday?')).not.toBeInTheDocument());
    expect(
      rpcCalls.filter((call) => call.name === 'list_communication_conversations').at(-1)?.args?.p_channel,
    ).toBe('whatsapp');
  });

  it('has no view that brings unknown senders into the queue', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: '/inbox',
    });
    await screen.findByText('Can we move Friday?');

    // The link-state filters are gone. This screen is the studio's work queue,
    // and there is no click that turns it into something else.
    expect(screen.queryByRole('button', { name: 'Unknown senders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unmatched' })).not.toBeInTheDocument();
    expect(screen.queryByText('Do you do cover ups?')).not.toBeInTheDocument();
    expect(
      rpcCalls.filter((call) => call.name === 'list_communication_conversations').at(-1)?.args?.p_link_state,
    ).toBe('linked');
  });

  it('offers email as a channel now that there is something behind it', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/inbox' });
    await screen.findByText('Can we move Friday?');

    // The tab used to return a hard-coded empty list and an apology, which is
    // why it was removed. It is back because email_messages is a real,
    // RLS-granted read: drafts waiting for approval and sends that failed.
    expect(screen.getByRole('tab', { name: 'Email' })).toBeInTheDocument();
  });

  it('separates who is waiting on a reply from what has merely been read', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/inbox' });
    await screen.findByText('Can we move Friday?');

    // The Instagram client wrote last; the WhatsApp thread was answered.
    expect(screen.getAllByText('Needs reply')).toHaveLength(2); // the filter and the badge
    expect(screen.getByText('You replied last')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Needs reply' }));

    await waitFor(() => expect(screen.queryByText('Thanks, see you then')).not.toBeInTheDocument());
    expect(screen.getByText('Can we move Friday?')).toBeInTheDocument();
    // Needs reply is a queue of work, so an unknown sender who happens to have
    // written last does not enter it either.
    expect(screen.queryByText('Do you do cover ups?')).not.toBeInTheDocument();
  });
});

describe('conversation detail', () => {
  it('offers linking actions for an unmatched sender and creates nothing on its own', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
    });

    expect(await screen.findByText('This sender is not linked to a client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link an existing client' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a client' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create an enquiry' })).toBeInTheDocument();

    // Opening a conversation must never create a client or an enquiry.
    expect(rpcCalls.some((call) => call.name === 'create_manual_enquiry')).toBe(false);
    expect(rpcCalls.some((call) => call.name === 'create_enquiry_from_communication')).toBe(false);
    expect(rpcCalls.some((call) => call.name === 'create_client_from_communication')).toBe(false);
  });

  it('links an existing client by id only', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Link an existing client' }));

    const search = await screen.findByLabelText('Search clients by name');
    fireEvent.change(search, { target: { value: 'Fixture' } });

    const link = await screen.findByRole('button', { name: 'Link' }, { timeout: 3000 });
    fireEvent.click(link);

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'link_communication_conversation_client');
      expect(call).toBeTruthy();
      expect(call?.args?.p_conversation_id).toBe(CONVERSATION_ID);
      // No artist id and no provider account travel with the request.
      expect(Object.keys(call?.args ?? {})).toEqual(['p_conversation_id', 'p_client_id']);
    });
  });

  it('creates a client without inventing contact details', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${CONVERSATION_ID}`,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a client' }));

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Instagram Walk-in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'create_client_from_communication');
      expect(call?.args?.p_full_name).toBe('Instagram Walk-in');
      expect(call?.args?.p_email).toBeNull();
      expect(call?.args?.p_phone).toBeNull();
    });
  });

  it('requires an email and a privacy acknowledgement before an enquiry can be created', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/inbox/${CONVERSATION_ID}` });
    fireEvent.click(await screen.findByRole('button', { name: 'Create an enquiry' }));

    const submitButton = screen.getByRole('button', { name: 'Create the enquiry' });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Real Enquiry' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'real@example.test' } });
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/acknowledged the current privacy notice/i));
    expect(submitButton).not.toBeDisabled();
  });

  it('queues a reply against the conversation, never a recipient', async () => {
    const { rpcCalls } = renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
    });

    const composer = await screen.findByPlaceholderText('Write a reply…');
    fireEvent.change(composer, { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const call = rpcCalls.find((entry) => entry.name === 'queue_communication_message');
      expect(call?.args?.p_body).toBe('On my way');
      expect(Object.keys(call?.args ?? {}).sort()).toEqual([
        'p_body', 'p_conversation_id', 'p_request_id',
      ]);
    });
  });

  it('tells the operator that the provider messaging window applies', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: `/inbox/${LINKED_CONVERSATION_ID}` });
    expect(await screen.findByText(/provider messaging window/i)).toBeInTheDocument();
  });

  it('carries the client\'s booking and deposit state into the conversation', async () => {
    renderWithSession(<App />, {
      role: 'booking_manager',
      path: `/inbox/${LINKED_CONVERSATION_ID}`,
    });

    // Replying used to mean leaving the thread to find out whether they were
    // booked or had paid. Both answers are now on the screen being replied on.
    const name = await screen.findByRole('link', { name: 'Fixture Client' });
    expect(name).toHaveAttribute('href', `#/clients/${CLIENT_ID}`);
    expect(await screen.findByText('Raven sleeve')).toBeInTheDocument();
    expect(await screen.findByText(/Deposit: requested/)).toBeInTheDocument();
  });

  it('gives a read-only session history but no composer', async () => {
    renderWithSession(<App />, { role: 'read_only', path: `/inbox/${LINKED_CONVERSATION_ID}` });

    expect(await screen.findByText('You can read this conversation but not reply to it.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write a reply…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link an existing client' })).not.toBeInTheDocument();
  });
});

describe('participant labelling', () => {
  it('prefers a linked client, then a provider label, then says the sender is unknown', () => {
    expect(participantLabel({
      client_name: 'Fixture Client',
      external_username: 'someone',
      external_display_label: 'Someone',
      channel: 'instagram',
    }, 'Unknown sender')).toBe('Fixture Client');

    expect(participantLabel({
      client_name: null,
      external_username: 'someone',
      external_display_label: null,
      channel: 'instagram',
    }, 'Unknown sender')).toBe('@someone');

    // A raw provider identifier is never shown as if it were a person.
    expect(participantLabel({
      client_name: null,
      external_username: null,
      external_display_label: null,
      channel: 'instagram',
    }, 'Unknown sender')).toBe('Unknown sender');
  });
});

describe('communications API guards', () => {
  function clientFor(rows: unknown) {
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    return { rpc } as unknown as CrmClient;
  }

  it('refuses a malformed conversation row rather than rendering half of it', async () => {
    const api = createCommunicationsApi(clientFor([{ id: 'not-a-uuid' }]));
    await expect(api.listConversations()).rejects.toThrow(/Could not load the inbox/);
  });

  it('refuses an unknown channel value', async () => {
    const api = createCommunicationsApi(clientFor([{
      id: '99999999-9999-4999-8999-999999999999',
      artist_id: 'a1111111-1111-4111-8111-111111111111',
      channel: 'telegram',
      link_state: 'unmatched',
      state: 'open',
      has_unread: false,
    }]));
    await expect(api.listConversations()).rejects.toThrow(/Could not load the inbox/);
  });
});

describe('Instagram connector configuration', () => {
  it('accepts only a reviewed connector origin', () => {
    expect(readInstagramConnectorOrigin({
      VITE_INSTAGRAM_CONNECTOR_ORIGIN: 'https://instagram.vishartattoo.com',
    })).toBe('https://instagram.vishartattoo.com');
    expect(readInstagramConnectorOrigin({})).toBe('');

    for (const value of [
      'https://instagram.example.com',
      'http://instagram.vishartattoo.com',
      'https://instagram.vishartattoo.com/path',
      'https://user:pass@instagram.vishartattoo.com',
      'https://instagram.vishartattoo.com:8443',
      'not a url',
    ]) {
      expect(() => readInstagramConnectorOrigin({ VITE_INSTAGRAM_CONNECTOR_ORIGIN: value })).toThrow();
    }
  });

  it('sends the operator session and only an artist id to the connector', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ authorize_url: 'https://www.instagram.com/oauth/authorize?x=1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = {
      auth: { getSession: async () => ({ data: { session: { access_token: 'session-token-value' } }, error: null }) },
    } as unknown as CrmClient;

    const api = createInstagramConnectionsApi(client, {
      connectorOrigin: 'https://instagram.vishartattoo.com',
      fetcher: fetcher as unknown as typeof globalThis.fetch,
    });
    await api.startInstagramConnection('a1111111-1111-4111-8111-111111111111');

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://instagram.vishartattoo.com/v1/connections/start');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer session-token-value');
    expect(JSON.parse(String(init.body))).toEqual({
      artist_id: 'a1111111-1111-4111-8111-111111111111',
    });
  });

  it('refuses to act without a live CRM session', async () => {
    const client = {
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    } as unknown as CrmClient;
    const api = createInstagramConnectionsApi(client, {
      connectorOrigin: 'https://instagram.vishartattoo.com',
      fetcher: (async () => new Response('{}')) as unknown as typeof globalThis.fetch,
    });
    await expect(api.startInstagramConnection('a1111111-1111-4111-8111-111111111111'))
      .rejects.toThrow(/session has expired/i);
  });


  it('keeps a backend-only permission RPC outage distinct from a generic connector failure', async () => {
    const client = {
      auth: { getSession: async () => ({ data: { session: { access_token: 'session-token-value' } }, error: null }) },
    } as unknown as CrmClient;
    const api = createInstagramConnectionsApi(client, {
      connectorOrigin: 'https://instagram.vishartattoo.com',
      fetcher: (async () => new Response(JSON.stringify({
        error: 'authorization_backend_unavailable',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch,
    });

    await expect(api.startInstagramConnection('a1111111-1111-4111-8111-111111111111'))
      .rejects.toThrow(/permission check/i);
  });

  it('reports a Worker-to-Auth request failure without blaming the CRM session', async () => {
    const client = {
      auth: { getSession: async () => ({ data: { session: { access_token: 'session-token-value' } }, error: null }) },
    } as unknown as CrmClient;
    const api = createInstagramConnectionsApi(client, {
      connectorOrigin: 'https://instagram.vishartattoo.com',
      fetcher: (async () => new Response(JSON.stringify({
        error: 'session_verification_request_failed',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch,
    });

    await expect(api.startInstagramConnection('a1111111-1111-4111-8111-111111111111'))
      .rejects.toThrow(/could not reach its session verification service/i);
  });
});
