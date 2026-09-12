import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryAiPanel } from '../components/EnquiryAiPanel';
import { createAiIntakeApi, type AiIntakeApi } from '../lib/ai-intake-api';

const ENQUIRY_ID = 'e1111111-1111-4111-8111-111111111111';
const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'c1111111-1111-4111-8111-111111111111';

function apiStub(): AiIntakeApi {
  return {
    getEnquiryAiResult: vi.fn(),
    getClientAiState: vi.fn(),
    retryEnquiryAi: vi.fn(),
    editEmailDraft: vi.fn(),
  };
}

describe('enquiry AI panel', () => {
  it('is fully absent from the CRM while the feature is paused', () => {
    const api = apiStub();
    const { container } = render(
      <EnquiryAiPanel enquiryId={ENQUIRY_ID} api={api} language="en" mayEdit />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(api.getEnquiryAiResult).not.toHaveBeenCalled();
    expect(api.retryEnquiryAi).not.toHaveBeenCalled();
  });
});

describe('enquiry AI browser API boundary', () => {
  it('passes only the draft id, body and expected version to the mutation RPC', async () => {
    const draft = {
      id: 'd1111111-1111-4111-8111-111111111111',
      subject: 'Re: enquiry',
      body: 'Original',
      status: 'draft',
      updated_at: '2026-09-08T12:00:00.000Z',
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ...draft, body: 'Changed' }, error: null });
    const api = createAiIntakeApi({ rpc } as never);
    await api.editEmailDraft(draft, 'Changed');
    expect(rpc).toHaveBeenCalledWith('edit_email_draft', {
      p_message_id: draft.id,
      p_body: 'Changed',
      p_expected_updated_at: draft.updated_at,
    });
  });

  it('reads the existing Five Pillars summary without queuing or retrying model work', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        status: 'ready',
        enabled: true,
        summary: 'Large-scale sleeve enquiry with references.',
        is_stale: false,
      },
      error: null,
    });
    const api = createAiIntakeApi({ rpc } as never);

    await expect(api.getClientAiState(ARTIST_ID, CLIENT_ID)).resolves.toEqual({
      status: 'ready',
      enabled: true,
      summary: 'Large-scale sleeve enquiry with references.',
      is_stale: false,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_client_ai_state', {
      p_artist_id: ARTIST_ID,
      p_client_id: CLIENT_ID,
    });
  });
});
