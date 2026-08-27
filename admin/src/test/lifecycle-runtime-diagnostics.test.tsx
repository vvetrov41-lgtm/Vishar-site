import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import { LifecycleAutomationStudioPage } from '../pages/LifecycleAutomationStudioPage';

vi.mock('../lib/session', () => ({ useApi: vi.fn() }));
vi.mock('../lib/artist-scope', () => ({ useArtistScope: vi.fn() }));
vi.mock('../lib/i18n', () => ({ useLanguage: vi.fn() }));
vi.mock('../pages/LifecycleAutomationPage', () => ({
  LifecycleAutomationPage: () => <div>Base automation UI</div>,
}));

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';

function health(overrides: Record<string, unknown> = {}) {
  return {
    artist_id: ARTIST_ID,
    health_status: 'healthy',
    automation_enabled: true,
    active_rule_count: 4,
    disabled_rule_count: 1,
    attention_item_count: 0,
    missing_template_rule_count: 0,
    invalid_rule_count: 0,
    integration_available: true,
    recent_failed_job_count: 1,
    blocker_codes: [],
    pending_job_count: 3,
    overdue_pending_job_count: 0,
    next_scheduled_at: '2026-08-27T10:00:00Z',
    oldest_overdue_pending_at: null,
    last_completed_at: '2026-08-26T09:00:00Z',
    last_failed_at: '2026-08-25T09:00:00Z',
    scheduler_last_succeeded_at: '2026-08-27T09:55:00Z',
    scheduler_stale: false,
    ...overrides,
  } as any;
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1',
    rule_id: 'rule-1',
    rule_name: 'Post-session check-in',
    rule_version: 1,
    session_id: 'session-1',
    client_name: 'History Client',
    appointment_type: 'tattoo_session',
    message_purpose: 'post_session_checkin',
    scheduled_at: '2026-08-26T10:00:00Z',
    lifecycle_status: 'failed',
    job_status: 'failed',
    email_status: null,
    outbox_status: null,
    failure_reason: 'automation_failed',
    retryable: false,
    attempt_count: 2,
    created_at: '2026-08-25T10:00:00Z',
    updated_at: '2026-08-26T10:05:00Z',
    ...overrides,
  } as any;
}

function artistScope(selectedArtistId: string | null) {
  return {
    artists: [{ id: ARTIST_ID, display_name: 'Artist One' }],
    selectedArtistId,
    loading: false,
    error: false,
    setSelectedArtistId: vi.fn(),
  } as any;
}

function runtimeApi({
  healthValue = health(),
  rows = [],
  canManage = false,
}: {
  healthValue?: any;
  rows?: any[];
  canManage?: boolean;
} = {}) {
  const getLifecycleAutomationHealth = vi.fn(async () => healthValue);
  const listClientLifecycleExecutionHistory = vi.fn(async () => rows);
  const listCapabilities = vi.fn(async () => [
    {
      artist_id: ARTIST_ID,
      capability: 'view_automations',
      domain: 'automations',
      is_write: false,
    },
    ...(canManage ? [{
      artist_id: ARTIST_ID,
      capability: 'manage_automations',
      domain: 'automations',
      is_write: true,
    }] : []),
  ]);
  const retryClientLifecycleJob = vi.fn(async (jobId: string) => ({
    job_id: jobId,
    job_status: 'pending',
    attempt_count: 2,
    scheduled_at: '2026-08-26T10:00:00Z',
  }));

  return {
    api: {
      getLifecycleAutomationHealth,
      listClientLifecycleExecutionHistory,
      listCapabilities,
      retryClientLifecycleJob,
    } as any,
    getLifecycleAutomationHealth,
    listClientLifecycleExecutionHistory,
    listCapabilities,
    retryClientLifecycleJob,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLanguage).mockReturnValue({ language: 'en', t: (key: string) => key } as any);
  vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
});

describe('Lifecycle runtime diagnostics', () => {
  it('shows overdue runtime state in human language while diagnostics remain read-only', async () => {
    const runtime = runtimeApi({
      healthValue: health({
        pending_job_count: 4,
        overdue_pending_job_count: 2,
        oldest_overdue_pending_at: '2026-08-26T08:00:00Z',
      }),
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Queue and execution')).toBeInTheDocument();
    expect(screen.getByText('The scheduler is active.')).toBeInTheDocument();
    expect(screen.getByText('Last successful scheduler run')).toBeInTheDocument();
    expect(screen.getByText('2 tasks are more than 15 minutes late.')).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
    expect(screen.getByText('overdue >15 min')).toBeInTheDocument();
    expect(screen.getByText('Oldest overdue task')).toBeInTheDocument();
    expect(screen.getByText('Next scheduled task')).toBeInTheDocument();
    expect(screen.getByText('Last completed task')).toBeInTheDocument();
    expect(screen.getByText('Last failed task')).toBeInTheDocument();
    expect(screen.getByText(/Diagnostics are read-only and aggregated/)).toBeInTheDocument();
    expect(await screen.findByText('No failures are safe to retry')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry safely' })).not.toBeInTheDocument();
  });

  it('explains a healthy waiting queue in Russian without an overdue warning', async () => {
    vi.mocked(useLanguage).mockReturnValue({ language: 'ru', t: (key: string) => key } as any);
    const runtime = runtimeApi({
      healthValue: health({
        pending_job_count: 3,
        overdue_pending_job_count: 0,
        oldest_overdue_pending_at: null,
      }),
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Очередь и выполнение')).toBeInTheDocument();
    expect(screen.getByText('Планировщик работает.')).toBeInTheDocument();
    expect(screen.getByText('3 задачи ждут своего времени. Просроченных нет.')).toBeInTheDocument();
    expect(screen.queryByText('Самая старая просроченная задача')).not.toBeInTheDocument();
    expect(screen.getByText(/Диагностика только читает агрегированные данные/)).toBeInTheDocument();
    expect(await screen.findByText('Нет ошибок для безопасного повтора')).toBeInTheDocument();
  });

  it('warns about a missing scheduler heartbeat even when the queue is empty', async () => {
    const runtime = runtimeApi({
      healthValue: health({
        pending_job_count: 0,
        overdue_pending_job_count: 0,
        next_scheduled_at: null,
        scheduler_last_succeeded_at: null,
        scheduler_stale: true,
      }),
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('A successful scheduler run has not been confirmed yet.')).toBeInTheDocument();
    expect(screen.getByText(/After 15 minutes without a successful run/)).toBeInTheDocument();
    expect(screen.getByText('The queue is empty. There are no overdue tasks.')).toBeInTheDocument();
    expect(screen.getByText('Last successful scheduler run')).toBeInTheDocument();
    expect(screen.getAllByText('None yet').length).toBeGreaterThan(0);
  });

  it('refreshes the same bounded health RPC on demand', async () => {
    const runtime = runtimeApi();
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    await screen.findByText('3 tasks are waiting for the scheduled time. None are overdue.');
    expect(runtime.getLifecycleAutomationHealth).toHaveBeenCalledTimes(1);

    const refreshButtons = screen.getAllByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButtons[0]);
    await waitFor(() => expect(runtime.getLifecycleAutomationHealth).toHaveBeenCalledTimes(2));
    expect(runtime.getLifecycleAutomationHealth).toHaveBeenLastCalledWith(ARTIST_ID);
  });

  it('shows a retry action only for server-authorized retryable failures and requeues through the dedicated RPC', async () => {
    const runtime = runtimeApi({
      rows: [historyRow({ retryable: true })],
      canManage: true,
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Safe failure recovery')).toBeInTheDocument();
    expect(screen.getByText('Retryable')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry safely' });
    fireEvent.click(retry);

    await waitFor(() => expect(runtime.retryClientLifecycleJob).toHaveBeenCalledWith('job-1'));
    expect(await screen.findByText(/The task was returned to the queue/)).toBeInTheDocument();
    await waitFor(() => expect(runtime.listClientLifecycleExecutionHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(runtime.getLifecycleAutomationHealth).toHaveBeenCalledTimes(2));
  });

  it('never offers lifecycle requeue for a delivery failure after an email exists', async () => {
    const runtime = runtimeApi({
      rows: [historyRow({
        job_status: 'completed',
        email_status: 'queued',
        outbox_status: 'dead',
        failure_reason: 'provider_delivery_failed',
        retryable: false,
      })],
      canManage: true,
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('No failures are safe to retry')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry safely' })).not.toBeInTheDocument();
    expect(runtime.retryClientLifecycleJob).not.toHaveBeenCalled();
  });

  it('does not expose the write action to a read-only user even when the server marks a failure retryable', async () => {
    const runtime = runtimeApi({
      rows: [historyRow({ retryable: true })],
      canManage: false,
    });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText(/Managing automations permission is required/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry safely' })).not.toBeInTheDocument();
  });

  it('does not request diagnostics or recovery while no exact artist is selected', () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(null));
    const runtime = runtimeApi();
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(screen.getByText('Base automation UI')).toBeInTheDocument();
    expect(screen.queryByText('Queue and execution')).not.toBeInTheDocument();
    expect(screen.queryByText('Safe failure recovery')).not.toBeInTheDocument();
    expect(runtime.getLifecycleAutomationHealth).not.toHaveBeenCalled();
    expect(runtime.listClientLifecycleExecutionHistory).not.toHaveBeenCalled();
  });

  it('fails closed when the health RPC returns no authorized row', async () => {
    const runtime = runtimeApi({ healthValue: null });
    vi.mocked(useApi).mockReturnValue(runtime.api);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Diagnostics unavailable')).toBeInTheDocument();
    expect(screen.getByText(/requires access to the selected artist’s automations/)).toBeInTheDocument();
  });
});
