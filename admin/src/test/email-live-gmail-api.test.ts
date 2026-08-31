import { describe, expect, it, vi } from 'vitest';
import { createEmailApi, __testing } from '../lib/email-api';
import type { CrmClient } from '../lib/api';

const enquiryId = '96320000-0000-4000-8000-000000000001';
const token = 'synthetic.supabase.session.token.1234567890';

function clientWithSession(accessToken: string | null = token): CrmClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: accessToken ? { access_token: accessToken } : null },
        error: null,
      })),
    },
  } as unknown as CrmClient;
}

function historyPayload() {
  return {
    enquiry_id: enquiryId,
    threads: [
      {
        thread_context_id: '96340000-0000-4000-8000-000000000001',
        subject: 'Tattoo enquiry',
        message_count: 2,
        messages: [
          {
            from: 'client@example.test',
            to: 'artist@example.test',
            subject: 'Tattoo enquiry',
            timestamp: '2026-08-31T10:00:00.000Z',
            body: 'Hello',
            direction: 'inbound',
            untrusted_content: true,
          },
        ],
        untrusted_content: true,
      },
    ],
    untrusted_content: true,
  } as const;
}

describe('live Gmail CRM API boundary', () => {
  it('calls only the fixed operator gateway with the Supabase session bearer', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(__testing.GMAIL_OPERATOR_ORIGIN);
      expect(url.pathname).toBe(`/v1/operator/enquiries/${enquiryId}/gmail/history`);
      expect(url.searchParams.get('thread_limit')).toBe('4');
      expect(url.searchParams.get('message_limit')).toBe('20');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      return Response.json(historyPayload());
    });
    const api = createEmailApi(clientWithSession(), fetcher as typeof fetch);

    const result = await api.listLiveGmailHistory(enquiryId);

    expect(result).toEqual(historyPayload());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not contact Gmail when the CRM session is absent', async () => {
    const fetcher = vi.fn();
    const api = createEmailApi(clientWithSession(null), fetcher as typeof fetch);

    await expect(api.listLiveGmailHistory(enquiryId)).rejects.toThrow('gmail_live_authentication_required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps provider error detail behind a stable gateway code', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'gmail_reconnect_required', provider_detail: 'do not render' }, { status: 409 }));
    const api = createEmailApi(clientWithSession(), fetcher as typeof fetch);

    await expect(api.listLiveGmailHistory(enquiryId)).rejects.toThrow('gmail_reconnect_required');
  });

  it('rejects malformed success payloads rather than trusting provider-shaped JSON', async () => {
    const fetcher = vi.fn(async () => Response.json({
      ...historyPayload(),
      threads: [{ ...historyPayload().threads[0], messages: [{ provider_message_id: 'leak' }] }],
    }));
    const api = createEmailApi(clientWithSession(), fetcher as typeof fetch);

    await expect(api.listLiveGmailHistory(enquiryId)).rejects.toThrow('gmail_live_invalid_response');
  });

  it('exposes no direct Gmail send primitive', () => {
    const api = createEmailApi(clientWithSession(), vi.fn() as unknown as typeof fetch);
    expect('sendGmail' in api).toBe(false);
    expect('sendEmail' in api).toBe(false);
  });
});
