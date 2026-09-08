import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectDepositPanel } from '../components/ProjectDepositPanel';
import { RouterProvider } from '../lib/router';
import type { Project } from '../lib/types';

const apiMocks = vi.hoisted(() => ({
  listProjectPaymentRequests: vi.fn(),
  previewProjectDeposit: vi.fn(),
}));

vi.mock('../lib/session', () => ({
  useApi: () => ({
    listProjectPaymentRequests: apiMocks.listProjectPaymentRequests,
    previewProjectDeposit: apiMocks.previewProjectDeposit,
  }),
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({
    language: 'en' as const,
    label: (_kind: string, value: string) => value,
  }),
}));

const PROJECT = {
  id: 'project-1',
  artist_id: 'artist-1',
  client_id: 'client-1',
  enquiry_id: 'enquiry-1',
  status: 'active',
  title: 'Fixture project',
  description: null,
  estimated_sessions: 3,
  estimated_hours: 7,
  deposit_status: 'requested',
  currency: 'GBP',
  created_at: '2026-09-01T09:00:00Z',
  updated_at: '2026-09-01T09:00:00Z',
  archived_at: null,
} as Project;

function renderPanel() {
  return render(
    <RouterProvider initialPath={`/projects/${PROJECT.id}`}>
      <ProjectDepositPanel
        project={PROJECT}
        finance={null}
        appointments={[]}
        onChanged={() => {}}
      />
    </RouterProvider>
  );
}

beforeEach(() => {
  apiMocks.listProjectPaymentRequests.mockReset();
  apiMocks.previewProjectDeposit.mockReset();
  apiMocks.listProjectPaymentRequests.mockResolvedValue([]);
  apiMocks.previewProjectDeposit.mockResolvedValue({
    project_id: PROJECT.id,
    artist_id: PROJECT.artist_id,
    currency: 'GBP',
    estimate_total: 2800,
    estimated_hours: 7,
    estimated_sessions: 3,
    policy_configured: true,
    calculable: true,
    mode: 'percentage_of_estimate',
    percentage: 25,
    suggested_amount: 700,
    override_amount: null,
    amount: 700,
    reusable_destination_configured: true,
    open_payment_request_id: null,
    open_payment_request_status: null,
  });
});

describe('compact project deposit controls', () => {
  it('keeps guidance and the manual settlement path collapsed by default', async () => {
    renderPanel();

    expect(await screen.findByText('Current deposit amount')).toBeInTheDocument();

    const workflow = screen.getByText('How deposits work').closest('details');
    expect(workflow).not.toBeNull();
    expect(workflow).not.toHaveAttribute('open');

    const manual = screen.getByText('Confirm deposit manually').closest('details');
    expect(manual).not.toBeNull();
    expect(manual).not.toHaveAttribute('open');
  });

  it('links straight to Payments when the artist has no deposit policy', async () => {
    apiMocks.previewProjectDeposit.mockResolvedValue({
      project_id: PROJECT.id,
      artist_id: PROJECT.artist_id,
      currency: 'GBP',
      estimate_total: 2800,
      estimated_hours: 7,
      estimated_sessions: 3,
      policy_configured: false,
      calculable: false,
      override_amount: null,
      open_payment_request_id: null,
      open_payment_request_status: null,
    });

    renderPanel();

    expect(await screen.findByText(/no project deposit policy yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure in Payments' })).toHaveAttribute(
      'href',
      '#/payments'
    );
  });
});