import { describe, expect, it, vi } from 'vitest';
import {
  conversationTitle,
  createWhatsappApi,
  maskContact,
  withinCustomerServiceWindow,
} from '../lib/whatsapp-api';
import { messageLabelKey, statusBadgeClass } from '../pages/WhatsappPage';
import type { CrmClient } from '../lib/api';

const CONVERSATION_ID = '9c111111-1111-4111-8111-111111111111';

describe('WhatsApp send boundary', () => {
  it('sends through the named RPC with a conversation, never a phone number', async () => {
    const rpc = vi.fn(async () => ({
      data: { message_id: 'm1', conversation_id: CONVERSATION_ID, status: 'queued', replayed: false },
      error: null,
    }));
    const api = createWhatsappApi({ rpc } as unknown as CrmClient);

    await api.sendWhatsappMessage(CONVERSATION_ID, '  Hello there  ');

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe('queue_whatsapp_message');
    expect(args.p_conversation_id).toBe(CONVERSATION_ID);
    expect(args.p_body).toBe('Hello there');
    // The browser cannot address a destination, an artist or a provider.
    expect(Object.keys(args).sort()).toEqual(['p_body', 'p_conversation_id', 'p_request_id']);
  });

  it('uses a fresh idempotency key per send', async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const api = createWhatsappApi({ rpc } as unknown as CrmClient);

    await api.sendWhatsappMessage(CONVERSATION_ID, 'one');
    await api.sendWhatsappMessage(CONVERSATION_ID, 'two');

    const first = (rpc.mock.calls[0] as unknown as [string, Record<string, string>])[1].p_request_id;
    const second = (rpc.mock.calls[1] as unknown as [string, Record<string, string>])[1].p_request_id;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an empty or oversized message before calling the database', async () => {
    const rpc = vi.fn();
    const api = createWhatsappApi({ rpc } as unknown as CrmClient);

    await expect(api.sendWhatsappMessage(CONVERSATION_ID, '   ')).rejects.toThrow();
    await expect(api.sendWhatsappMessage(CONVERSATION_ID, 'x'.repeat(4097))).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('turns a permission denial into an actionable message', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '42501' } }));
    const api = createWhatsappApi({ rpc } as unknown as CrmClient);

    await expect(api.sendWhatsappMessage(CONVERSATION_ID, 'hello'))
      .rejects.toThrow(/do not have permission/i);
  });
});

describe('customer service window', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');

  it('is open within 24 hours of the last client message', () => {
    expect(withinCustomerServiceWindow('2026-08-15T11:00:00Z', now)).toBe(true);
    expect(withinCustomerServiceWindow('2026-08-14T12:30:00Z', now)).toBe(true);
  });

  it('is closed after 24 hours, or when the client has never written', () => {
    expect(withinCustomerServiceWindow('2026-08-14T11:00:00Z', now)).toBe(false);
    expect(withinCustomerServiceWindow(null, now)).toBe(false);
    expect(withinCustomerServiceWindow('not a date', now)).toBe(false);
  });
});

describe('conversation presentation', () => {
  it('masks a contact number rather than showing it in full', () => {
    expect(maskContact('447700900123')).toBe('+44 ••• 0123');
    expect(maskContact('nonsense')).toBe('—');
  });

  it('prefers the contact label and falls back to the masked number', () => {
    const base = {
      id: CONVERSATION_ID,
      artist_id: 'a1',
      client_id: null,
      contact_wa_id: '447700900123',
      last_message_at: null,
      last_inbound_at: null,
    };
    expect(conversationTitle({ ...base, contact_label: 'Alex' })).toBe('Alex');
    expect(conversationTitle({ ...base, contact_label: '   ' })).toBe('+44 ••• 0123');
    expect(conversationTitle({ ...base, contact_label: null })).toBe('+44 ••• 0123');
  });
});

describe('coexistence attribution', () => {
  it('distinguishes a CRM send from a WhatsApp Business app send', () => {
    expect(messageLabelKey({ direction: 'inbound', origin: 'contact' })).toBe('whatsapp.fromClient');
    expect(messageLabelKey({ direction: 'outbound', origin: 'crm' })).toBe('whatsapp.fromCrm');
    expect(messageLabelKey({ direction: 'outbound', origin: 'business_app' }))
      .toBe('whatsapp.fromBusinessApp');
    expect(messageLabelKey({ direction: 'outbound', origin: 'automation' }))
      .toBe('whatsapp.fromAutomation');
  });

  it('shows delivery state distinctly, with failure standing out', () => {
    expect(statusBadgeClass('failed')).toBe('badge danger');
    expect(statusBadgeClass('read')).toBe('badge ok');
    expect(statusBadgeClass('delivered')).toBe('badge ok');
    expect(statusBadgeClass('queued')).toBe('badge warn');
    expect(statusBadgeClass('sent')).toBe('badge');
  });
});

describe('conversation reads', () => {
  it('scopes the conversation list to the selected artist when one is chosen', async () => {
    const eq = vi.fn(() => ({ error: null, data: [] }));
    const limit = vi.fn(() => ({ eq, error: null, data: [] }));
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn((_columns: string) => ({ order }));
    const from = vi.fn(() => ({ select }));
    const api = createWhatsappApi({ from } as unknown as CrmClient);

    await api.listWhatsappConversations('a1111111-1111-4111-8111-111111111111');

    expect(from).toHaveBeenCalledWith('whatsapp_conversations');
    expect(eq).toHaveBeenCalledWith('artist_id', 'a1111111-1111-4111-8111-111111111111');
    // No credential-bearing column is ever requested.
    const columns = String(select.mock.calls[0]?.[0] ?? '');
    for (const forbidden of ['token', 'secret', 'phone_number_id', 'integration_key']) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
