import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BookingCardStatus } from '../lib/session-pricing';
import { bookingCardChannelLabel } from '../lib/session-pricing';

let current: Partial<BookingCardStatus> = {};

vi.mock('../lib/session', () => ({
  useApi: () => ({
    getSessionBookingCardStatus: async () => ({ ...base(), ...current }),
  }),
}));

const { BookingCardStatusLine } = await import('../components/BookingCardStatusLine');

function base(): BookingCardStatus {
  return {
    session_id: 'session-1',
    eligible: true,
    reason: 'ready',
    card_kind: 'consultation_booked',
    currency: 'GBP',
    session_price: null,
    deposit_paid: null,
    remaining_balance: null,
    deposit_source: null,
    email_enabled: true,
    whatsapp_enabled: true,
    channels_enabled: true,
    in_rollout_window: true,
    rollout_starts_at: null,
    card: null,
    channel: 'whatsapp',
    channel_outcome: 'selected',
    channel_evidence_source: 'whatsapp_message',
    channel_evidence_at: '2026-09-20T10:00:00Z',
    channel_decided_at: null,
    deliveries: [],
  };
}

async function line(status: Partial<BookingCardStatus>) {
  current = status;
  const view = render(<BookingCardStatusLine sessionId="session-1" />);
  const text = await screen.findByText(/Booking card/);
  const content = text.textContent;
  view.unmount();
  return content;
}

describe('booking card status line', () => {
  it('names the one channel the card goes to', async () => {
    expect(await line({})).toBe('Booking card · WhatsApp · will be sent');
    expect(await line({ channel: 'email', channel_evidence_source: 'gmail_thread' }))
      .toBe('Booking card · Email · will be sent');
  });

  it('says plainly when there is no conversation to send it in', async () => {
    expect(await line({ channel: null, channel_outcome: 'no_conversation_channel' }))
      .toBe('Booking card: no conversation channel yet');
  });

  it('does not fall back from an Instagram conversation', async () => {
    const text = await line({ channel: 'instagram', channel_outcome: 'conversation_channel_unsupported' });
    expect(text).toBe("Booking card: the latest conversation is on Instagram, where cards can't be sent yet");
    expect(text).not.toMatch(/Email|WhatsApp/);
  });

  it('shows the delivery state of the single channel', async () => {
    expect(await line({
      deliveries: [{
        channel: 'whatsapp', status: 'sent', skip_reason: null,
        queued_at: null, sent_at: '2026-09-20T10:05:00Z', failed_at: null,
      }],
    })).toBe('Booking card · WhatsApp · WhatsApp: sent');
  });

  it('keeps eligibility reasons ahead of the channel', async () => {
    expect(await line({
      eligible: false,
      reason: 'session_price_missing',
      channel: null,
      channel_outcome: 'no_conversation_channel',
    })).toMatch(/^Booking card: No session price yet/);
  });
});

describe('booking card channel labels', () => {
  it('covers every blocked outcome in both languages', () => {
    expect(bookingCardChannelLabel('selected', 'email', 'en')).toBe('');
    expect(bookingCardChannelLabel('no_conversation_channel', null, 'ru')).toBe('пока нет канала переписки');
    expect(bookingCardChannelLabel('conversation_channel_disabled', 'whatsapp', 'en'))
      .toBe('card sending to WhatsApp is off');
    expect(bookingCardChannelLabel('conversation_channel_unreachable', 'email', 'ru'))
      .toBe('клиент недоступен в Email');
    expect(bookingCardChannelLabel('delivery_unavailable', 'whatsapp', 'en'))
      .toBe('the WhatsApp card could not be prepared');
  });
});
