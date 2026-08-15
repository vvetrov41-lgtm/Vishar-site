import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryWhatsAppPanel } from '../components/EnquiryWhatsAppPanel';
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
    <EnquiryWhatsAppPanel
      api={api}
      enquiryId={ENQUIRY_ID}
      clientId={CLIENT_ID}
      artistId={ARTIST_ID}
      phone={options.phone ?? '+44 7700 900123'}
      role={options.role ?? 'booking_manager'}
      language="en"
    />
  );
}

describe('WhatsApp enquiry panel', () => {
  it('builds the direct WhatsApp link only from an already-international client number', async () => {
    const api = apiStub();
    renderPanel(api);

    const link = await screen.findByRole('link', { name: 'Open in WhatsApp' });
    expect(link).toHaveAttribute('href', 'https://wa.me/447700900123');
    expect(api.getWhatsAppConversationForClient).toHaveBeenCalledWith(CLIENT_ID, ARTIST_ID);
  });

  it('fails the direct-link UI closed for a local-format phone number', async () => {
    const api = apiStub();
    renderPanel(api, { phone: '07700 900123' });

    expect(await screen.findByText(/requires an international phone number/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in WhatsApp' })).not.toBeInTheDocument();
  });

  it('creates a CRM conversation using the enquiry id, then queues through the stored conversation id', async () => {
    const getConversation = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(conversation);
    const ensureConversation = vi.fn().mockResolvedValue({ conversation_id: CONVERSATION_ID });
    const queueMessage = vi.fn().mockResolvedValue({
      message_id: 'm1111111-1111-4111-8111-111111111111',
      conversation_id: CONVERSATION_ID,
      status: 'queued',
    });
    const api = apiStub({
      getWhatsAppConversationForClient: getConversation as Api['getWhatsAppConversationForClient'],
      ensureWhatsAppConversationForEnquiry: ensureConversation as Api['ensureWhatsAppConversationForEnquiry'],
      queueWhatsAppMessage: queueMessage as Api['queueWhatsAppMessage'],
    });

    renderPanel(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect conversation to CRM' }));

    await waitFor(() => expect(ensureConversation).toHaveBeenCalledWith(ENQUIRY_ID));
    const composer = await screen.findByLabelText('WhatsApp message');
    expect(composer).toHaveAttribute('maxlength', '4096');

    fireEvent.change(composer, { target: { value: 'Hello from the CRM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send via CRM' }));

    await waitFor(() => {
      expect(queueMessage).toHaveBeenCalledWith(
        CONVERSATION_ID,
        'Hello from the CRM',
        expect.any(String)
      );
    });
  });

  it('lets read-only staff view artist-scoped history but exposes no CRM send control', async () => {
    const api = apiStub({
      getWhatsAppConversationForClient: vi.fn().mockResolvedValue(conversation) as Api['getWhatsAppConversationForClient'],
      listWhatsAppMessages: vi.fn().mockResolvedValue([
        {
          id: 'm2111111-1111-4111-8111-111111111111',
          direction: 'inbound',
          origin: 'contact',
          status: 'received',
          message_type: 'text',
          body: 'Hello from the client',
          created_at: '2026-08-15T08:00:00.000Z',
        },
        {
          id: 'm3111111-1111-4111-8111-111111111111',
          direction: 'outbound',
          origin: 'crm',
          status: 'read',
          message_type: 'text',
          body: 'Previous CRM reply',
          created_at: '2026-08-15T08:01:00.000Z',
        },
      ]) as Api['listWhatsAppMessages'],
    });

    renderPanel(api, { role: 'read_only' });

    expect(await screen.findByText('Hello from the client')).toBeInTheDocument();
    expect(screen.getByText('Previous CRM reply')).toBeInTheDocument();
    expect(screen.getByText(/← received/)).toBeInTheDocument();
    expect(screen.getByText(/→ read/)).toBeInTheDocument();
    expect(screen.queryByLabelText('WhatsApp message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send via CRM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect conversation to CRM' })).not.toBeInTheDocument();
  });
});
