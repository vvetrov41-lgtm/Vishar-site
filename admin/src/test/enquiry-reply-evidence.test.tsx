// The enquiry page says whether the client was answered and from what
// evidence, and lets the operator record a reply the CRM could not see.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EnquiryReplyEvidence } from '../components/EnquiryReplyEvidence';
import type { EnquiryReplyState } from '../lib/api';

const ENQUIRY = '7683e435-fcc2-4e25-b29b-d9b1f53b9a5b';

function state(overrides: Partial<EnquiryReplyState>): EnquiryReplyState {
  return {
    enquiry_id: ENQUIRY,
    answered: false,
    first_reply_at: null,
    first_reply_source: null,
    attestation_source: null,
    outside_crm_channel: null,
    outside_crm_recorded_at: null,
    ...overrides,
  };
}

describe('EnquiryReplyEvidence', () => {
  it('records an Instagram reply sent outside the CRM and shows it', async () => {
    const api = {
      getEnquiryReplyState: vi.fn()
        .mockResolvedValueOnce(state({}))
        .mockResolvedValueOnce(state({
          answered: true, attestation_source: 'operator_recorded_reply', outside_crm_channel: 'instagram',
        })),
      setEnquiryReplyOutsideCrm: vi.fn().mockResolvedValue({}),
    };
    render(<EnquiryReplyEvidence enquiryId={ENQUIRY} role="owner" api={api} language="ru" />);

    expect(await screen.findByText('Ответа клиенту не видно ни в одном канале.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Я уже ответил вне CRM' }));

    await waitFor(() => expect(api.setEnquiryReplyOutsideCrm).toHaveBeenCalledWith(ENQUIRY, 'instagram'));
    expect(await screen.findByText('Ответ был, время первого ответа неизвестно.')).toBeTruthy();
    expect(screen.getByText(/Отмечено: ответ отправлен вне CRM \(Instagram\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Я уже ответил вне CRM' })).toBeNull();
  });

  it('shows the first reply time and its source, with nothing to record', async () => {
    const api = {
      getEnquiryReplyState: vi.fn().mockResolvedValue(state({
        answered: true, first_reply_at: '2026-09-23T19:36:35Z', first_reply_source: 'gmail_mailbox',
      })),
      setEnquiryReplyOutsideCrm: vi.fn(),
    };
    render(<EnquiryReplyEvidence enquiryId={ENQUIRY} role="owner" api={api} language="en" />);
    expect(await screen.findByText(/First reply: .*\(email in Gmail\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I already replied outside the CRM' })).toBeNull();
  });

  it('a read-only operator sees the state but cannot record a reply', async () => {
    const api = {
      getEnquiryReplyState: vi.fn().mockResolvedValue(state({})),
      setEnquiryReplyOutsideCrm: vi.fn(),
    };
    render(<EnquiryReplyEvidence enquiryId={ENQUIRY} role="read_only" api={api} language="en" />);
    expect(await screen.findByText('No reply to the client is visible on any channel.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I already replied outside the CRM' })).toBeNull();
  });
});
