import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryAiPanel } from '../components/EnquiryAiPanel';
import { AI_FIELD_NAMES, createAiIntakeApi, type AiField, type AiFieldName, type AiIntakeApi, type EnquiryAiResult } from '../lib/ai-intake-api';
import { RouterProvider } from '../lib/router';

const ENQUIRY_ID = 'e1111111-1111-4111-8111-111111111111';
const fields = Object.fromEntries(AI_FIELD_NAMES.map((name) => [name, {
  value: null, status: 'missing' as const,
}])) as Record<AiFieldName, AiField>;
fields.client_name = { value: 'Maya', status: 'explicit' };
fields.concept = { value: 'Moth and leaves', status: 'inferred' };

const ready: EnquiryAiResult = {
  enabled: true,
  status: 'succeeded',
  result: {
    fields,
    summary: 'Fine-line moth enquiry.',
    missing_information: AI_FIELD_NAMES.filter((name) => fields[name].status === 'missing'),
    draft_reply: 'Hi Maya, could you share your preferred placement?',
  },
  draft: {
    id: 'd1111111-1111-4111-8111-111111111111',
    subject: 'Re: enquiry',
    body: 'Hi Maya, could you share your preferred placement?',
    status: 'draft',
    updated_at: '2026-09-08T12:00:00.000Z',
  },
};

function apiStub(overrides: Partial<AiIntakeApi> = {}): AiIntakeApi {
  return {
    getEnquiryAiResult: vi.fn().mockResolvedValue(ready),
    retryEnquiryAi: vi.fn().mockResolvedValue(ready),
    editEmailDraft: vi.fn().mockImplementation(async (draft, body) => ({ ...ready.draft!, ...draft, body })),
    ...overrides,
  };
}

function renderPanel(api: AiIntakeApi, mayEdit = true) {
  return render(
    <RouterProvider initialPath={`/enquiries/${ENQUIRY_ID}`}>
      <EnquiryAiPanel enquiryId={ENQUIRY_ID} api={api} language="en" mayEdit={mayEdit} />
    </RouterProvider>,
  );
}

describe('enquiry AI panel', () => {
  it('separates AI suggestions from saved CRM data and says nothing was sent', async () => {
    renderPanel(apiStub());
    expect(await screen.findByText('Fine-line moth enquiry.')).toBeInTheDocument();
    expect(screen.getByText(/AI suggestions below are separate from the saved enquiry fields/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent/i)).toBeInTheDocument();
    expect(screen.getByText('Still needed')).toBeInTheDocument();
    expect(screen.getByText('Fine-line moth enquiry.').closest('section')).not.toHaveAttribute('data-compact-enquiry-ai');
  });

  it('keeps passive pending analysis compact while preserving its live status', async () => {
    const pending: EnquiryAiResult = { enabled: true, status: 'pending' };
    renderPanel(apiStub({ getEnquiryAiResult: vi.fn().mockResolvedValue(pending) }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Waiting for analysis. You can keep working on this enquiry.');
    expect(status.closest('section')).toHaveAttribute('data-compact-enquiry-ai', 'true');
    expect(screen.getByRole('heading', { name: 'Enquiry assistant' })).toBeInTheDocument();
  });

  it('edits the draft using its optimistic version without sending or approving', async () => {
    const editEmailDraft = vi.fn().mockImplementation(async (draft, body) => ({ ...ready.draft!, ...draft, body }));
    const api = apiStub({ editEmailDraft });
    renderPanel(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    fireEvent.change(screen.getByLabelText('Reply draft'), { target: { value: 'Updated reply for artist review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(editEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: ready.draft!.id, updated_at: ready.draft!.updated_at }),
      'Updated reply for artist review.',
    ));
    expect(await screen.findByText('Draft saved. Nothing has been sent.')).toBeInTheDocument();
  });

  it('keeps retry controls hidden from read-only staff', async () => {
    const failed: EnquiryAiResult = { enabled: true, status: 'failed' };
    renderPanel(apiStub({ getEnquiryAiResult: vi.fn().mockResolvedValue(failed) }), false);
    expect(await screen.findByText(/original enquiry is saved/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Analyse enquiry' })).not.toBeInTheDocument();
  });
});

describe('enquiry AI browser API boundary', () => {
  it('passes only the draft id, body and expected version to the mutation RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ...ready.draft, body: 'Changed' }, error: null });
    const api = createAiIntakeApi({ rpc } as never);
    await api.editEmailDraft(ready.draft!, 'Changed');
    expect(rpc).toHaveBeenCalledWith('edit_email_draft', {
      p_message_id: ready.draft!.id,
      p_body: 'Changed',
      p_expected_updated_at: ready.draft!.updated_at,
    });
  });
});
