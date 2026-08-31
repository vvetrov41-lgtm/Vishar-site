import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import { ClientMessagesPage } from '../pages/ClientMessagesPage';

vi.mock('../lib/session', () => ({ useApi: vi.fn() }));
vi.mock('../lib/artist-scope', () => ({ useArtistScope: vi.fn() }));
vi.mock('../lib/i18n', () => ({ useLanguage: vi.fn() }));
vi.mock('../lib/router', () => ({
  Link: ({ to, children }: any) => <a href={to}>{children}</a>,
}));

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'b1111111-1111-4111-8111-111111111111';

function artistScope() {
  return {
    artists: [{
      id: ARTIST_ID,
      display_name: 'Artist One',
      slug: 'artist-one',
      timezone: 'Europe/London',
      default_currency: 'GBP',
      is_active: true,
    }],
    selectedArtistId: ARTIST_ID,
    loading: false,
    error: false,
    setSelectedArtistId: vi.fn(),
  } as any;
}

function api() {
  return {
    listClientLifecycleTemplates: vi.fn(async () => [{
      id: 'template-active',
      workspace_id: WORKSPACE_ID,
      artist_id: ARTIST_ID,
      template_scope: 'artist',
      purpose: 'session_reminder_24h',
      classification: 'service',
      purpose_description: '24 hour reminder',
      channel: 'email',
      locale: 'en',
      version: 3,
      status: 'active',
      subject: 'Your appointment',
      body: 'Hello {{client_first_name}}, see you tomorrow.',
      created_at: '2026-08-25T00:00:00Z',
      updated_at: '2026-08-25T00:00:00Z',
    }]),
    listClientLifecycleTemplatePurposes: vi.fn(async () => [{
      purpose: 'session_reminder_24h',
      classification: 'service',
      description: '24 hour reminder',
    }]),
    listClientLifecycleTemplateVariables: vi.fn(async () => [{
      variable: 'client_first_name',
      description: 'Client first name',
    }]),
    listClientLifecycleRules: vi.fn(async () => [{
      id: 'rule-1',
      artist_id: ARTIST_ID,
      name: '24 hour reminder',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      message_channel: 'email',
      message_locale: 'en',
      schedule_anchor: 'session_start',
      anchor_offset_minutes: -1440,
      is_enabled: true,
      version: 1,
      workspace_default_id: null,
      workspace_default_version: null,
      workspace_override: false,
      created_at: '2026-08-25T00:00:00Z',
      updated_at: '2026-08-25T00:00:00Z',
    }]),
    listCapabilities: vi.fn(async () => [{
      artist_id: ARTIST_ID,
      capability: 'manage_automations',
      domain: 'automations',
      is_write: true,
    }]),
    artistControlPlaneContext: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    upsertMessageTemplate: vi.fn(async () => 'template-new'),
    setMessageTemplateActive: vi.fn(async () => true),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useArtistScope).mockReturnValue(artistScope());
  vi.mocked(useLanguage).mockReturnValue({ language: 'en', t: (key: string) => key } as any);
});

describe('Client messages page', () => {
  it('puts customer-facing message text first and keeps technical controls behind Advanced settings', async () => {
    const lifecycle = api();
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<ClientMessagesPage />);

    expect(await screen.findByRole('heading', { name: 'Automatic messages' })).toBeInTheDocument();
    expect(screen.getByText('Before the appointment')).toBeInTheDocument();
    expect(screen.getByText('24-hour session reminder')).toBeInTheDocument();
    expect(screen.getByText('Hello {{client_first_name}}, see you tomorrow.')).toBeInTheDocument();
    expect(screen.queryByText('Execution history')).not.toBeInTheDocument();
    expect(screen.queryByText('Automation health')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Advanced settings' })).toHaveAttribute('href', '/automations/advanced');
  });

  it('edits an existing message from its current text and saves a new draft version', async () => {
    const lifecycle = api();
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<ClientMessagesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
    expect(screen.getByLabelText('Email subject')).toHaveValue('Your appointment');
    expect(screen.getByLabelText('Message text')).toHaveValue('Hello {{client_first_name}}, see you tomorrow.');

    fireEvent.change(screen.getByLabelText('Message text'), {
      target: { value: 'Hello {{client_first_name}}, your appointment is tomorrow.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(lifecycle.upsertMessageTemplate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      artistId: ARTIST_ID,
      purpose: 'session_reminder_24h',
      body: 'Hello {{client_first_name}}, your appointment is tomorrow.',
      locale: 'en',
      subject: 'Your appointment',
    }));
    expect(lifecycle.setMessageTemplateActive).not.toHaveBeenCalled();
    expect(await screen.findByText('Changes saved as a draft. The active message has not changed yet.')).toBeInTheDocument();
  });

  it('can save and explicitly apply the new version in one action', async () => {
    const lifecycle = api();
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<ClientMessagesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }));
    fireEvent.change(screen.getByLabelText('Email subject'), { target: { value: 'Reminder for tomorrow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply' }));

    await waitFor(() => expect(lifecycle.upsertMessageTemplate).toHaveBeenCalled());
    await waitFor(() => expect(lifecycle.setMessageTemplateActive).toHaveBeenCalledWith('template-new', true));
    expect(await screen.findByText('Changes saved and applied. New messages will use this text.')).toBeInTheDocument();
  });

  it('separates scheduling from message editing instead of showing one long control-plane feed', async () => {
    const lifecycle = api();
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<ClientMessagesPage />);
    await screen.findByText('24-hour session reminder');
    fireEvent.click(screen.getByRole('button', { name: 'When to send' }));

    expect(screen.getByText('1 day before appointment · tattoo session')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
  });
});
