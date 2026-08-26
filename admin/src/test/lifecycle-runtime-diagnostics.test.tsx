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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLanguage).mockReturnValue({ language: 'en', t: (key: string) => key } as any);
  vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
});

describe('Lifecycle runtime diagnostics', () => {
  it('shows overdue runtime state in human language and keeps the view read-only', async () => {
    const getLifecycleAutomationHealth = vi.fn(async () => health({
      pending_job_count: 4,
      overdue_pending_job_count: 2,
      oldest_overdue_pending_at: '2026-08-26T08:00:00Z',
    }));
    vi.mocked(useApi).mockReturnValue({ getLifecycleAutomationHealth } as any);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Queue and execution')).toBeInTheDocument();
    expect(screen.getByText('2 tasks are more than 15 minutes late.')).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
    expect(screen.getByText('overdue >15 min')).toBeInTheDocument();
    expect(screen.getByText('Oldest overdue task')).toBeInTheDocument();
    expect(screen.getByText('Next scheduled task')).toBeInTheDocument();
    expect(screen.getByText('Last completed task')).toBeInTheDocument();
    expect(screen.getByText('Last failed task')).toBeInTheDocument();
    expect(screen.getByText(/Diagnostics are read-only and aggregated/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry job/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });

  it('explains a healthy waiting queue in Russian without an overdue warning', async () => {
    vi.mocked(useLanguage).mockReturnValue({ language: 'ru', t: (key: string) => key } as any);
    const getLifecycleAutomationHealth = vi.fn(async () => health({
      pending_job_count: 3,
      overdue_pending_job_count: 0,
      oldest_overdue_pending_at: null,
    }));
    vi.mocked(useApi).mockReturnValue({ getLifecycleAutomationHealth } as any);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Очередь и выполнение')).toBeInTheDocument();
    expect(screen.getByText('3 задачи ждёт своего времени. Просроченных нет.')).toBeInTheDocument();
    expect(screen.queryByText('Самая старая просроченная задача')).not.toBeInTheDocument();
    expect(screen.getByText(/Диагностика только читает агрегированные данные/)).toBeInTheDocument();
  });

  it('refreshes the same bounded health RPC on demand', async () => {
    const getLifecycleAutomationHealth = vi.fn(async () => health());
    vi.mocked(useApi).mockReturnValue({ getLifecycleAutomationHealth } as any);

    render(<LifecycleAutomationStudioPage />);

    await screen.findByText('3 tasks are waiting for the scheduled time. None are overdue.');
    expect(getLifecycleAutomationHealth).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getLifecycleAutomationHealth).toHaveBeenCalledTimes(2));
    expect(getLifecycleAutomationHealth).toHaveBeenLastCalledWith(ARTIST_ID);
  });

  it('does not request diagnostics while no exact artist is selected', () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(null));
    const getLifecycleAutomationHealth = vi.fn(async () => health());
    vi.mocked(useApi).mockReturnValue({ getLifecycleAutomationHealth } as any);

    render(<LifecycleAutomationStudioPage />);

    expect(screen.getByText('Base automation UI')).toBeInTheDocument();
    expect(screen.queryByText('Queue and execution')).not.toBeInTheDocument();
    expect(getLifecycleAutomationHealth).not.toHaveBeenCalled();
  });

  it('fails closed when the health RPC returns no authorized row', async () => {
    const getLifecycleAutomationHealth = vi.fn(async () => null);
    vi.mocked(useApi).mockReturnValue({ getLifecycleAutomationHealth } as any);

    render(<LifecycleAutomationStudioPage />);

    expect(await screen.findByText('Diagnostics unavailable')).toBeInTheDocument();
    expect(screen.getByText(/requires access to the selected artist’s automations/)).toBeInTheDocument();
  });
});
