import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryWhatsAppPanel } from '../components/EnquiryWhatsAppPanel';
import { RouterProvider } from '../lib/router';
import type { Api } from '../lib/api';

const ENQUIRY_ID = 'e1111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'c1111111-1111-4111-8111-111111111111';
const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '91111111-1111-4111-8111-111111111111';

const conversation = {
  id: CONVERSATION_ID,
  artist_id: ARTIST_ID,
  client_id: CLIENT_ID,
  integration_key: 'vladimir-whatsapp',
  contact_wa_id: '447700900123',
  last_message_at: null,
};

function apiStub(overrides: Partial<Api> = {}): Api {
  return {
    getWhatsAppConversationForClient: vi.fn().mockResolvedValue(null),
    listWhatsAppMessages: vi.fn().mockResolvedValue([]),
    ensureWhatsAppConversationForEnquiry: vi.fn().mockResolvedValue({ conversation_id: CONVERSATION_ID }),
    queueWhatsAppMessage: vi.fn().mockResolvedValue({ message_id: 'm1', conversation_id: CONVERSATION_ID, status: 'queued' }),
    ...overrides,
  } as unknown as Api;
}

function renderPanel(api: Api, options: { phone?: string | null; role?: 'owner' | 'booking_manager' | 'read_only' } = {}) {
  return render(
    <RouterProvider initialPath={`/enquiries/${ENQUIRY_ID}`}>
      <EnquiryWhatsAppPanel
        api={api}
        enquiryId={ENQUIRY_ID}
        clientId={CLIENT_ID}
        artistId={ARTIST_ID}
        phone={options.phone ?? '+44 7700 900123'}
        role={options.role ?? 'booking_manager'}
        language="en"
      />
    </RouterProvider>
  );
}

describe('WhatsApp enquiry panel', () => {
  it('builds the direct WhatsApp link from an international client number', async () => {
    const api = apiStub();
    renderPanel(api);

    const link = await screen.findByRole('link', { name: 'Open in WhatsApp' });
    expect(link).toHaveAttribute('href', 'https://wa.me/447700900123');
    expect(api.getWhatsAppConversationForClient).toHaveBeenCalledWith(CLIENT_ID, ARTIST_ID);
  });

  it('normalizes a UK local mobile number for the direct WhatsApp link', async () => {
    const api = apiStub();
    renderPanel(api, { phone: '07700 900123' });

    const link = await screen.findByRole('link', { name: 'Open in WhatsApp' });
    expect(link).toHaveAttribute('href', 'https://wa.me/447700900123');
    expect(screen.queryByText(/requires an international number or a UK mobile/i)).not.toBeInTheDocument();
  });

  it('still fails closed for an ambiguous local phone number', async () => {
    const api = apiStub();
    renderPanel(api, { phone: '020 7946 0958' });

    expect(await screen.findByText(/requires an international number or a UK mobile/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in WhatsApp' })).not.toBeInTheDocument();
  });

  it('creates a CRM conversation using the enquiry id, then links into it', async () => {
    const getConversation = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(conversation);
    const ensureConversation = vi.fn().mockResolvedValue({ conversation_id: CONVERSATION_ID });
    const api = apiStub({
      getWhatsAppConversationForClient: getConversation as Api['getWhatsAppConversationForClient'],
      ensureWhatsAppConversationForEnquiry: ensureConversation as Api['ensureWhatsAppConversationForEnquiry'],
    });

    renderPanel(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect conversation to CRM' }));

    await waitFor(() => expect(ensureConversation).toHaveBeenCalledWith(ENQUIRY_ID));

    const openConversation = await screen.findByRole('link', { name: 'Open conversation' });
    expect(openConversation).toHaveAttribute('href', `#/inbox/${CONVERSATION_ID}`);
  });

  it('carries no second WhatsApp thread or composer of its own', async () => {
    const api = apiStub({
      getWhatsAppConversationForClient: vi.fn().mockResolvedValue(conversation) as Api['getWhatsAppConversationForClient'],
    });

    renderPanel(api);
    await screen.findByRole('link', { name: 'Open conversation' });

    // Two places to reply to one person meant two sets of behaviour to learn
    // and no single answer to "has this client been answered?".
    expect(screen.queryByLabelText('WhatsApp message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send via CRM' })).not.toBeInTheDocument();
    expect(api.listWhatsAppMessages).not.toHaveBeenCalled();
  });

  it('lets read-only staff reach the conversation but exposes no connect control', async () => {
    const api = apiStub({
      getWhatsAppConversationForClient: vi.fn().mockResolvedValue(conversation) as Api['getWhatsAppConversationForClient'],
    });

    renderPanel(api, { role: 'read_only' });

    expect(await screen.findByRole('link', { name: 'Open conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect conversation to CRM' })).not.toBeInTheDocument();
  });
});
