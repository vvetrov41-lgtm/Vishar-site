import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useLanguage } from '../lib/i18n';
import type { ClientLifecyclePurpose } from '../lib/lifecycle-api';
import { useApi } from '../lib/session';
import { LifecycleAutomationPage, lifecyclePurposeLabel } from '../pages/LifecycleAutomationPage';

vi.mock('../lib/session', () => ({ useApi: vi.fn() }));
vi.mock('../lib/artist-scope', () => ({ useArtistScope: vi.fn() }));
vi.mock('../lib/i18n', () => ({ useLanguage: vi.fn() }));

const ARTIST_ID = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'b1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'c1111111-1111-4111-8111-111111111111';

const PURPOSES: ClientLifecyclePurpose[] = [
  { purpose: 'consultation_reminder', classification: 'service', description: 'Reminds a client of a booked consultation.' },
  { purpose: 'deposit_confirmation', classification: 'service', description: 'Confirms receipt of a deposit.' },
  { purpose: 'deposit_policy', classification: 'service', description: 'Explains the deposit policy.' },
  { purpose: 'deposit_request', classification: 'service', description: 'Requests a deposit.' },
  { purpose: 'new_enquiry_ack', classification: 'service', description: 'Acknowledges a new enquiry.' },
  { purpose: 'no_response_followup', classification: 'service', description: 'Follows up when there is no reply.' },
  { purpose: 'post_session_checkin', classification: 'service', description: 'Checks in after a session.' },
  { purpose: 'session_reminder_24h', classification: 'service', description: 'Reminds a client 24 hours before a session.' },
  { purpose: 'session_reminder_72h', classification: 'service', description: 'Reminds a client 72 hours before a session.' },
  { purpose: 'session_reminder_7d', classification: 'service', description: 'Reminds a client 7 days before a session.' },
];

function lifecycleApi() {
  const capabilities = [
    'view_automations',
    'view_sessions',
    'view_clients',
    'view_enquiries',
    'view_integrations',
    'view_finance',
    'manage_automations',
  ].map((capability) => ({
    artist_id: ARTIST_ID,
    capability,
    domain: 'automations',
    is_write: capability === 'manage_automations',
  }));

  return {
    getLifecycleAutomationHealth: vi.fn(async () => ({
      artist_id: ARTIST_ID,
      health_status: 'healthy',
      automation_enabled: true,
      active_rule_count: 1,
      disabled_rule_count: 0,
      attention_item_count: 0,
      missing_template_rule_count: 0,
      invalid_rule_count: 0,
      integration_available: true,
      recent_failed_job_count: 0,
      blocker_codes: [],
    })),
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
      subject: null,
      body: 'Hello {{client_first_name}}',
      created_at: '2026-08-25T00:00:00Z',
      updated_at: '2026-08-25T00:00:00Z',
    }]),
    listClientLifecycleTemplatePurposes: vi.fn(async () => PURPOSES),
    listClientLifecycleTemplateVariables: vi.fn(async () => []),
    listClientLifecyclePreviewSessions: vi.fn(async () => [{
      session_id: SESSION_ID,
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      session_status: 'confirmed',
      start_at: '2026-11-07T11:00:00Z',
      end_at: '2026-11-07T18:00:00Z',
    }]),
    listClientLifecycleExecutionHistory: vi.fn(async () => [{
      job_id: 'job-1',
      rule_id: 'rule-1',
      rule_name: '24 hour reminder',
      rule_version: 1,
      session_id: SESSION_ID,
      client_name: 'History Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'session_reminder_24h',
      scheduled_at: '2026-11-06T11:00:00Z',
      lifecycle_status: 'scheduled',
      job_status: 'pending',
      email_status: null,
      outbox_status: null,
      failure_reason: null,
      attempt_count: 0,
      retryable: false,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
    }]),
    listLifecycleConfigurationHistory: vi.fn(async () => []),
    listCapabilities: vi.fn(async () => capabilities),
    artistControlPlaneContext: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    previewClientLifecycleRule: vi.fn(),
    createClientLifecycleRule: vi.fn(),
    setAutomationRuleEnabled: vi.fn(),
    updateClientLifecycleRuleTiming: vi.fn(),
    upsertMessageTemplate: vi.fn(),
    setMessageTemplateActive: vi.fn(),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLanguage).mockReturnValue({ language: 'ru', t: (key: string) => key } as any);
  vi.mocked(useArtistScope).mockReturnValue({
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
  } as any);
});

describe('lifecycle purpose localisation', () => {
  it('maps the complete production service-purpose catalogue to operator-facing Russian labels', () => {
    const expected: Record<string, string> = {
      consultation_reminder: 'Напоминание о консультации',
      deposit_confirmation: 'Подтверждение депозита',
      deposit_policy: 'Условия депозита',
      deposit_request: 'Запрос депозита',
      new_enquiry_ack: 'Подтверждение новой заявки',
      no_response_followup: 'Напоминание без ответа',
      post_session_checkin: 'Сообщение после сеанса',
      session_reminder_24h: 'Напоминание о сеансе за 24 часа',
      session_reminder_72h: 'Напоминание о сеансе за 72 часа',
      session_reminder_7d: 'Напоминание о сеансе за 7 дней',
    };

    for (const purpose of PURPOSES) {
      expect(lifecyclePurposeLabel(purpose.purpose, PURPOSES, true)).toBe(expected[purpose.purpose]);
    }
  });

  it('fails closed in Russian for a future unknown purpose instead of leaking a raw code or English description', () => {
    const future = [
      ...PURPOSES,
      { purpose: 'future_service_event', classification: 'service', description: 'Future English description.' },
    ] as ClientLifecyclePurpose[];

    expect(lifecyclePurposeLabel('future_service_event', future, true)).toBe('Сервисное сообщение');
    expect(lifecyclePurposeLabel('future_service_event', future, false)).toBe('Future English description.');
  });

  it('renders rules, execution history, templates and authoring selects without raw purpose codes in Russian', async () => {
    vi.mocked(useApi).mockReturnValue(lifecycleApi());

    render(<LifecycleAutomationPage />);

    expect(await screen.findAllByText('Напоминание о сеансе за 24 часа')).not.toHaveLength(0);
    expect(screen.queryByText('session_reminder_24h')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'Напоминание о сеансе за 24 часа' })).toHaveLength(2);
  });
});
