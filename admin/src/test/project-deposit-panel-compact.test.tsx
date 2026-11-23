import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

function panel(refreshKey = 0) {
  return (
    <RouterProvider initialPath={`/projects/${PROJECT.id}`}>
      <ProjectDepositPanel
        project={PROJECT}
        finance={null}
        appointments={[]}
        refreshKey={refreshKey}
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
    render(panel());

    expect(await screen.findByText('Configured deposit request amount')).toBeInTheDocument();

    const workflow = screen.getByText('How deposits work').closest('details');
    expect(workflow).not.toBeNull();
    expect(workflow).not.toHaveAttribute('open');

    const manual = screen.getByText('Confirm deposit manually').closest('details');
    expect(manual).not.toBeNull();
    expect(manual).not.toHaveAttribute('open');
  });

  it('refreshes the total on the open project and excludes balances from closed requests', async () => {
    const original = { id: 'deposit-1', purpose: 'deposit', amount: 500, currency: 'GBP',
      status: 'paid', net_paid: 500, outstanding_amount: 0 };
    const cancelled = { id: 'deposit-2', purpose: 'deposit', amount: 250, currency: 'GBP',
      status: 'cancelled', net_paid: 0, outstanding_amount: 250 };
    apiMocks.listProjectPaymentRequests.mockResolvedValueOnce([original, cancelled]);
    const view = render(panel());
    const line = await screen.findByText('Deposits received for this project');
    expect(line.nextElementSibling).toHaveTextContent('£500.00');
    expect(within(screen.getByText('£250.00 · cancelled').closest('.row') as HTMLElement)
      .queryByText(/outstanding/i)).not.toBeInTheDocument();

    apiMocks.listProjectPaymentRequests.mockResolvedValueOnce([original, cancelled,
      { ...original, id: 'deposit-3', amount: 300, net_paid: 300 },
      { ...original, id: 'balance-1', purpose: 'session_balance', amount: 470, net_paid: 470 },
    ]);
    view.rerender(panel(1));
    expect(await screen.findByText('£800.00')).toBeInTheDocument();
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

    render(panel());

    expect(await screen.findByText(/no project deposit policy yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure in Payments' })).toHaveAttribute(
      'href',
      '#/payments'
    );
  });
});