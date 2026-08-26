import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import { useApi } from '../lib/session';
import { LifecycleAutomationPage } from '../pages/LifecycleAutomationPage';

vi.mock('../lib/session', () => ({ useApi: vi.fn() }));
vi.mock('../lib/artist-scope', () => ({ useArtistScope: vi.fn() }));
vi.mock('../lib/i18n', () => ({ useLanguage: vi.fn() }));

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'b1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'c1111111-1111-4111-8111-111111111111';

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

function api(canManage = false, canPreview = true) {
  const viewCapabilities = canPreview
    ? ['view_automations', 'view_sessions', 'view_clients', 'view_enquiries', 'view_integrations', 'view_finance']
    : ['view_automations'];
  const capabilities = viewCapabilities.map((capability) => ({
    artist_id: ARTIST_ID,
    capability,
    domain: capability.replace('view_', ''),
    is_write: false,
  }));
  if (canManage) {
    capabilities.push({
      artist_id: ARTIST_ID,
      capability: 'manage_automations',
      domain: 'automations',
      is_write: true,
    });
  }

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
    listClientLifecyclePreviewSessions: vi.fn(async () => canPreview ? [{
      session_id: SESSION_ID,
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      session_status: 'confirmed',
      start_at: '2026-08-27T10:00:00Z',
      end_at: '2026-08-27T17:00:00Z',
    }] : []),
    listClientLifecycleExecutionHistory: vi.fn(async () => [{
      job_id: 'job-1',
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      session_id: SESSION_ID,
      client_name: 'History Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      scheduled_at: '2026-08-26T10:00:00Z',
      lifecycle_status: 'scheduled',
      job_status: 'pending',
      email_status: null,
      outbox_status: null,
      failure_reason: null,
      attempt_count: 0,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
    }]),
    previewClientLifecycleRule: vi.fn(async () => ({
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      rule_enabled: true,
      session_id: SESSION_ID,
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      session_status: 'confirmed',
      scheduled_at: '2026-08-26T10:00:00Z',
      template_id: 'template-1',
      template_version: 1,
      template_scope: 'artist',
      rendered_subject: 'Your appointment tomorrow',
      rendered_body: 'Hello Preview, your appointment is tomorrow.',
      suppression_reason: null,
      integration_available: true,
      existing_job_id: null,
      existing_job_status: null,
      eligible: false,
      blocker: 'not_due',
    })),
    listCapabilities: vi.fn(async () => capabilities),
    artistControlPlaneContext: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    createClientLifecycleRule: vi.fn(async () => 'new-rule'),
    setAutomationRuleEnabled: vi.fn(async () => true),
    upsertMessageTemplate: vi.fn(async () => 'new-template'),
    setMessageTemplateActive: vi.fn(async () => true),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLanguage).mockReturnValue({ language: 'en', t: (key: string) => key } as any);
});

describe('Lifecycle automation control plane', () => {
  it('requires one exact artist rather than authoring against the combined scope', () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(null));
    vi.mocked(useApi).mockReturnValue(api(true));

    render(<LifecycleAutomationPage />);

    expect(screen.getByText('Choose an artist')).toBeInTheDocument();
  });

  it('lets read-only capabilities preview rules without exposing write controls', async () => {
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(api(false, true));

    render(<LifecycleAutomationPage />);

    expect(await screen.findByText('24 hour reminder')).toBeInTheDocument();
    expect(screen.getByText('Your appointment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show preview' })).toBeInTheDocument();
    expect(screen.getByText('Execution history')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('History Client')).toBeInTheDocument();
    expect(screen.getByText('You can view these automations but cannot change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create disabled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });

  it('uses only the read-only preview RPC path and renders human-readable blockers', async () => {
    const lifecycle = api(false, true);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);
    await screen.findByRole('button', { name: 'Show preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));

    await waitFor(() => expect(lifecycle.previewClientLifecycleRule).toHaveBeenCalledWith(
      ARTIST_ID,
      'rule-1',
      SESSION_ID,
    ));
    expect(screen.getByText('Would not send')).toBeInTheDocument();
    expect(screen.getByText('Message is not due yet')).toBeInTheDocument();
    expect(screen.getByText('Your appointment tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Hello Preview, your appointment is tomorrow.')).toBeInTheDocument();
    expect(screen.queryByText('not_due')).not.toBeInTheDocument();
    expect(lifecycle.createClientLifecycleRule).not.toHaveBeenCalled();
    expect(lifecycle.upsertMessageTemplate).not.toHaveBeenCalled();
    expect(lifecycle.setAutomationRuleEnabled).not.toHaveBeenCalled();
    expect(lifecycle.setMessageTemplateActive).not.toHaveBeenCalled();
  });

  it('renders only normalized execution-history failures through the bounded read RPC', async () => {
    const lifecycle = api(false, true);
    lifecycle.listClientLifecycleExecutionHistory.mockResolvedValue([{
      job_id: 'job-failed',
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      session_id: SESSION_ID,
      client_name: 'History Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      scheduled_at: '2026-08-26T10:00:00Z',
      lifecycle_status: 'failed',
      job_status: 'completed',
      email_status: 'queued',
      outbox_status: 'dead',
      failure_reason: 'provider_delivery_failed',
      attempt_count: 3,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-26T10:05:00Z',
    }]);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);

    expect(await screen.findByText('Provider delivery failed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('provider_delivery_failed')).not.toBeInTheDocument();
    expect(lifecycle.listClientLifecycleExecutionHistory).toHaveBeenCalledWith(ARTIST_ID);
    expect(lifecycle.createClientLifecycleRule).not.toHaveBeenCalled();
    expect(lifecycle.upsertMessageTemplate).not.toHaveBeenCalled();
    expect(lifecycle.setAutomationRuleEnabled).not.toHaveBeenCalled();
    expect(lifecycle.setMessageTemplateActive).not.toHaveBeenCalled();
  });

  it('fails closed when the operator lacks the complete preview capability set', async () => {
    const lifecycle = api(false, false);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);

    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getByText('History unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show preview' })).not.toBeInTheDocument();
    expect(lifecycle.previewClientLifecycleRule).not.toHaveBeenCalled();
  });

  it('renders the preview controls and blocker copy in Russian', async () => {
    const lifecycle = api(false, true);
    vi.mocked(useLanguage).mockReturnValue({ language: 'ru', t: (key: string) => key } as any);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);
    await screen.findByRole('button', { name: 'Показать предпросмотр' });
    expect(screen.getByText('История выполнения')).toBeInTheDocument();
    expect(screen.getByText('Запланировано')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Показать предпросмотр' }));

    expect(await screen.findByText('Не отправится')).toBeInTheDocument();
    expect(screen.getByText('Время отправки ещё не наступило')).toBeInTheDocument();
    expect(screen.queryByText('not_due')).not.toBeInTheDocument();
  });

  it('creates a new rule disabled through the existing narrow RPC payload', async () => {
    const lifecycle = api(true);
    vi.mocked(useArtistScope).mockReturnValue(artistScope(ARTIST_ID));
    vi.mocked(useApi).mockReturnValue(lifecycle);

    render(<LifecycleAutomationPage />);
    await screen.findByText('New rule');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Healing check-in' } });
    fireEvent.change(screen.getByLabelText('Message purpose'), { target: { value: 'session_reminder_24h' } });
    fireEvent.change(screen.getByLabelText(/Offset, minutes/), { target: { value: '-2880' } });
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
