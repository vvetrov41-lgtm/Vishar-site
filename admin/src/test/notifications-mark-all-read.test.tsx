import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  snoozeFollowUp: vi.fn(),
}));
const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'ru' }));

vi.mock('../lib/session', () => ({ useApi: () => mocks }));
vi.mock('../components/PersonalTelegramNotifications', () => ({
  PersonalTelegramNotifications: () => null,
}));
vi.mock('../lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('../lib/i18n')>('../lib/i18n');
  return {
    ...actual,
    useLanguage: () => ({
      language: language.current,
      t: (key: string, params?: Record<string, string | number>) => actual.translate(language.current, key, params),
    }),
  };
});

import { NotificationsPage } from '../pages/NotificationsPage';

function row(id: string, status: 'delivered' | 'pending' | 'read' | 'dismissed') {
  return {
    id,
    artist_id: null,
    artist_label: null,
    notification_type: 'follow_up.due',
    title: `Title ${id}`,
    body: null,
    entity_type: null,
    entity_id: null,
    priority: 'normal' as const,
    status,
    scheduled_at: new Date().toISOString(),
    read_at: status === 'read' ? new Date().toISOString() : null,
  };
}

// The page asks for the newest page plus one pending and one delivered row.
function serve(pages: ReturnType<typeof row>[][]) {
  let load = 0;
  mocks.listNotifications.mockImplementation(async (status?: string, limit?: number) => {
    const page = pages[Math.min(load, pages.length - 1)];
    if (status === undefined) return page;
    const matching = page.filter((item) => item.status === status).slice(0, limit ?? 50);
    if (status === 'pending') load += 1;
    return matching;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  language.current = 'en';
});

describe('Notifications: mark all as read', () => {
  it('marks everything read with one server call and reloads', async () => {
    serve([
      [row('n1', 'delivered'), row('n2', 'pending'), row('n3', 'read')],
      [row('n1', 'read'), row('n2', 'read'), row('n3', 'read')],
    ]);
    mocks.markAllNotificationsRead.mockResolvedValue(2);

    render(<NotificationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => expect(mocks.markAllNotificationsRead).toHaveBeenCalledTimes(1));
    expect(mocks.markNotificationRead).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument());
    expect(mocks.listNotifications).toHaveBeenCalledTimes(6);
  });

  it('is offered when an unread row is older than the loaded page', async () => {
    mocks.listNotifications.mockImplementation(async (status?: string) => {
      if (status === 'delivered') return [row('old', 'delivered')];
      if (status === 'pending') return [];
      return [row('n3', 'read')];
    });
    render(<NotificationsPage />);
    expect(await screen.findByRole('button', { name: 'Mark all as read' })).toBeInTheDocument();
  });

  it('is not offered when nothing is unread', async () => {
    serve([[row('n3', 'read')]]);
    render(<NotificationsPage />);
    expect(await screen.findByText('Title n3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument();
  });

  it('uses Russian copy in Russian mode and never lists dismissed rows', async () => {
    language.current = 'ru';
    serve([[row('n1', 'delivered'), row('n9', 'dismissed')]]);
    render(<NotificationsPage />);
    expect(await screen.findByRole('button', { name: 'Отметить всё прочитанным' })).toBeInTheDocument();
    expect(screen.getByText('Новые (1)')).toBeInTheDocument();
    expect(screen.queryByText('Title n9')).not.toBeInTheDocument();
  });
});
