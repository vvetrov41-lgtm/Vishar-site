import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useApi } from '../lib/session';
import { LifecycleAutomationPage } from '../pages/LifecycleAutomationPage';

vi.mock('../lib/session', () => ({ useApi: vi.fn() }));
vi.mock('../lib/artist-scope', () => ({ useArtistScope: vi.fn() }));
vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}));

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'b1111111-1111-4111-8111-111111111111';

function artistScope(selectedArtistId: string | null) {
  return {
    artists: [{
      id: ARTIST_ID,
      display_name: 'Artist One',
      slug: 'artist-one',
      timezone: 'Europe/London',
      default_currency: 'GBP',
      is_active: true,
    }],
    selectedArtistId,
    loading: false,
    error: false,
    setSelectedArtistId: vi.fn(),
  } as any;
}

function api(canManage = false) {
  return {
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
    listClientLifecycleTemplates: vi.fn(async () => [{
      id: 'template-1',
      workspace_id: WORKSPACE_ID,
      artist_id: ARTIST_ID,
      template_scope: 'artist',
      purpose: 'session_reminder_24h',
      classification: 'service',
      purpose_description: '24 hour reminder',
      channel: 'email',
      locale: 'en',
      version: 1,
      status: 'active',
      subject: 'Your appointment',
      body: 'Hello {{client_first_name}}',
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
    listCapabilities: vi.fn(async () => canManage ? [{
      artist_id: ARTIST_ID,
      capability: 'manage_automations',
      domain: 'automations',
      is_write: true,
    }] : [{
      artist_id: ARTIST_ID,
      capability: 'view_automations',
      domain: 'automations',
      is_write: false,
    }]),
    artistControlPlaneContext: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    createClientLifecycleRule: vi.fn(async () => 'new-rule'),
    setAutomationRuleEnabled: vi.fn(async () => true),
    upsertMessageTemplate: vi.fn(async () => 'new-template'),
    setMessageTemplateActive: vi.fn(async () => true),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Lifecycle automation control plane', () => {
  it('requires one exact artist rather than authoring against the combined scope', () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(null));
    vi.mocked(useApi).mockReturnValue(api(true));

    render(<LifecycleAutomationPage />);

    expect(screen.getByText('Choose an artist')).toBeInTheDocument();
  });

  it('lets view_automations read rules and templates without exposing write controls', async () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(api(false));

    render(<LifecycleAutomationPage />);

    expect(await screen.findByText('24 hour reminder')).toBeInTheDocument();
    expect(screen.getByText('Your appointment')).toBeInTheDocument();
    expect(screen.getByText('You can view these automations but cannot change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create disabled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });

  it('creates a new rule disabled through the existing narrow RPC payload', async () => {
    const lifecycle = api(true);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);
    await screen.findByText('New rule');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Healing check-in' } });
    fireEvent.change(screen.getByLabelText('Message purpose'), { target: { value: 'session_reminder_24h' } });
    fireEvent.change(screen.getByLabelText('Offset, minutes'), { target: { value: '-2880' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create disabled' }));

    await waitFor(() => expect(lifecycle.createClientLifecycleRule).toHaveBeenCalledWith({
      artistId: ARTIST_ID,
      name: 'Healing check-in',
      appointmentType: 'tattoo_session',
      messagePurpose: 'session_reminder_24h',
      scheduleAnchor: 'session_start',
      anchorOffsetMinutes: -2880,
      locale: 'en',
    }));
  });

  it('saves artist template copy as a draft and does not activate it implicitly', async () => {
    const lifecycle = api(true);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);
    await screen.findByText('New template draft');

    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'session_reminder_24h' } });
    fireEvent.change(screen.getByLabelText('Email subject'), { target: { value: 'Reminder' } });
    fireEvent.change(screen.getByLabelText('Email body'), { target: { value: 'Hello {{client_first_name}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(lifecycle.upsertMessageTemplate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      artistId: ARTIST_ID,
      purpose: 'session_reminder_24h',
      body: 'Hello {{client_first_name}}',
      locale: 'en',
      subject: 'Reminder',
    }));
    expect(lifecycle.setMessageTemplateActive).not.toHaveBeenCalled();
  });
});
