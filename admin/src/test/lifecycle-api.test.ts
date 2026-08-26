import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createLifecycleApi } from '../lib/lifecycle-api';

function clientWithRpc(response: { data: unknown; error: unknown } = { data: [], error: null }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as CrmClient, rpc };
}

describe('lifecycle control-plane API boundary', () => {
  it('reads rules and templates only through named artist-scoped RPCs', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createLifecycleApi(client);

    await api.listClientLifecycleRules('artist-1');
    await api.listClientLifecycleTemplates('artist-1');
    await api.listClientLifecycleTemplatePurposes('artist-1');
    await api.listClientLifecycleTemplateVariables('artist-1');

    expect(rpc).toHaveBeenNthCalledWith(1, 'list_client_lifecycle_rules', {
      p_artist_id: 'artist-1',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'list_client_lifecycle_templates', {
      p_artist_id: 'artist-1',
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'list_client_lifecycle_template_purposes', {
      p_artist_id: 'artist-1',
    });
    expect(rpc).toHaveBeenNthCalledWith(4, 'list_client_lifecycle_template_variables', {
      p_artist_id: 'artist-1',
    });
  });

  it('previews only through the bounded artist/rule/session RPCs', async () => {
    const session = {
      session_id: 'session-1',
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      session_status: 'completed',
      start_at: '2026-08-24T09:00:00Z',
      end_at: '2026-08-24T16:00:00Z',
    };
    const preview = {
      rule_id: 'rule-1',
      rule_name: 'Post-session check-in',
      rule_version: 1,
      rule_enabled: true,
      session_id: 'session-1',
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      session_status: 'completed',
      scheduled_at: '2026-08-25T16:00:00Z',
      template_id: 'template-1',
      template_version: 1,
      template_scope: 'workspace',
      rendered_subject: 'How is your tattoo feeling today?',
      rendered_body: 'Hi Preview, how are you feeling?',
      suppression_reason: null,
      integration_available: true,
      existing_job_id: null,
      existing_job_status: null,
      eligible: true,
      blocker: null,
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [session], error: null })
      .mockResolvedValueOnce({ data: [preview], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const api = createLifecycleApi({ rpc } as unknown as CrmClient);

    await expect(api.listClientLifecyclePreviewSessions('artist-1', 25)).resolves.toEqual([session]);
    await expect(api.previewClientLifecycleRule('artist-1', 'rule-1', 'session-1')).resolves.toEqual(preview);
    await expect(api.previewClientLifecycleRule('artist-1', 'rule-1', 'session-missing')).resolves.toBeNull();

    expect(rpc).toHaveBeenNthCalledWith(1, 'list_client_lifecycle_preview_sessions', {
      p_artist_id: 'artist-1',
      p_limit: 25,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'preview_client_lifecycle_rule', {
      p_artist_id: 'artist-1',
      p_rule_id: 'rule-1',
      p_session_id: 'session-1',
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'preview_client_lifecycle_rule', {
      p_artist_id: 'artist-1',
      p_rule_id: 'rule-1',
      p_session_id: 'session-missing',
    });
  });

  it('reads execution history only through the bounded artist-scoped RPC', async () => {
    const history = [{
      job_id: 'job-1',
      rule_id: 'rule-1',
      rule_name: 'Post-session check-in',
      rule_version: 1,
      session_id: 'session-1',
      client_name: 'Preview Client',
      appointment_type: 'tattoo_session',
      message_purpose: 'post_session_checkin',
      scheduled_at: '2026-08-25T16:00:00Z',
      lifecycle_status: 'scheduled',
      job_status: 'pending',
      email_status: null,
      outbox_status: null,
      failure_reason: null,
      attempt_count: 0,
      created_at: '2026-08-25T10:00:00Z',
      updated_at: '2026-08-25T10:00:00Z',
    }];
    const { client, rpc } = clientWithRpc({ data: history, error: null });
    const api = createLifecycleApi(client);

    await expect(api.listClientLifecycleExecutionHistory('artist-1', 25)).resolves.toEqual(history);

    expect(rpc).toHaveBeenCalledWith('list_client_lifecycle_execution_history', {
      p_artist_id: 'artist-1',
      p_limit: 25,
    });
  });

  it('reads configuration history through the bounded cursor RPC', async () => {
    const history = [{
      activity_id: 'activity-1',
      occurred_at: '2026-08-25T11:00:00Z',
      event_type: 'automation.rule_updated',
      entity_kind: 'rule',
    }];
    const { client, rpc } = clientWithRpc({ data: history, error: null });
    const api = createLifecycleApi(client);

    await expect(api.listLifecycleConfigurationHistory('artist-1')).resolves.toEqual(history);
    expect(rpc).toHaveBeenLastCalledWith('list_lifecycle_configuration_history', {
      p_artist_id: 'artist-1',
      p_limit: 20,
      p_before_occurred_at: null,
      p_before_id: null,
    });

    await api.listLifecycleConfigurationHistory('artist-1', 10, {
      occurredAt: '2026-08-25T11:00:00Z',
      activityId: 'activity-1',
    });
    expect(rpc).toHaveBeenLastCalledWith('list_lifecycle_configuration_history', {
      p_artist_id: 'artist-1',
      p_limit: 10,
      p_before_occurred_at: '2026-08-25T11:00:00Z',
      p_before_id: 'activity-1',
    });
  });

  it('reads automation health only through the bounded Artist-scoped RPC', async () => {
    const health = {
      artist_id: 'artist-1',
      health_status: 'healthy',
      automation_enabled: true,
      active_rule_count: 6,
      disabled_rule_count: 0,
      attention_item_count: 0,
      missing_template_rule_count: 0,
      invalid_rule_count: 0,
      integration_available: true,
      recent_failed_job_count: 0,
      blocker_codes: [],
    };
    const { client, rpc } = clientWithRpc({ data: [health], error: null });
    const api = createLifecycleApi(client);

    await expect(api.getLifecycleAutomationHealth('artist-1')).resolves.toEqual(health);
    expect(rpc).toHaveBeenCalledWith('get_lifecycle_automation_health', {
      p_artist_id: 'artist-1',
    });
  });

  it('creates lifecycle rules through the typed RPC and cannot enable them during creation', async () => {
    const { client, rpc } = clientWithRpc({ data: 'rule-1', error: null });
    const api = createLifecycleApi(client);

    await api.createClientLifecycleRule({
      artistId: 'artist-1',
      name: 'Post-session check-in',
      appointmentType: 'tattoo_session',
      messagePurpose: 'post_session_checkin',
      scheduleAnchor: 'session_end',
      anchorOffsetMinutes: 1440,
      locale: 'en',
    });

    expect(rpc).toHaveBeenCalledWith('create_client_lifecycle_rule', {
      p_artist_id: 'artist-1',
      p_name: 'Post-session check-in',
      p_appointment_type: 'tattoo_session',
      p_message_purpose: 'post_session_checkin',
      p_schedule_anchor: 'session_end',
      p_anchor_offset_minutes: 1440,
      p_locale: 'en',
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain('is_enabled');
  });

  it('changes rule state only through the existing capability-gated RPC', async () => {
    const { client, rpc } = clientWithRpc({ data: true, error: null });
    const api = createLifecycleApi(client);

    await api.setAutomationRuleEnabled('rule-1', true);

    expect(rpc).toHaveBeenCalledWith('set_automation_rule_enabled', {
      p_rule_id: 'rule-1',
      p_is_enabled: true,
    });
  });

  it('changes timing only through the human timing RPC payload', async () => {
    const update = {
      rule_id: 'rule-1',
      schedule_anchor: 'session_start',
      anchor_offset_minutes: -2880,
      rule_version: 2,
      pending_jobs_rescheduled: 1,
    };
    const { client, rpc } = clientWithRpc({ data: [update], error: null });
    const api = createLifecycleApi(client);

    await expect(api.updateClientLifecycleRuleTiming({
      ruleId: 'rule-1',
      timingDirection: 'before_session_start',
      amount: 2,
      unit: 'days',
    })).resolves.toEqual(update);

    expect(rpc).toHaveBeenCalledWith('update_client_lifecycle_rule_timing', {
      p_rule_id: 'rule-1',
      p_timing_direction: 'before_session_start',
      p_amount: 2,
      p_unit: 'days',
    });
  });

  it('saves email templates as drafts through the existing template RPC', async () => {
    const { client, rpc } = clientWithRpc({ data: 'template-1', error: null });
    const api = createLifecycleApi(client);

    await api.upsertMessageTemplate({
      workspaceId: 'workspace-1',
      artistId: 'artist-1',
      purpose: 'post_session_checkin',
      subject: 'How is your tattoo healing?',
      body: 'Hi {{client_first_name}}, how is your tattoo healing?',
      locale: 'en',
    });

    expect(rpc).toHaveBeenCalledWith('upsert_message_template', {
      p_workspace_id: 'workspace-1',
      p_purpose: 'post_session_checkin',
      p_channel: 'email',
      p_body: 'Hi {{client_first_name}}, how is your tattoo healing?',
      p_locale: 'en',
      p_subject: 'How is your tattoo healing?',
      p_artist_id: 'artist-1',
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain('status');
  });

  it('activates or retires a template only through the explicit transition RPC', async () => {
    const { client, rpc } = clientWithRpc({ data: true, error: null });
    const api = createLifecycleApi(client);

    await api.setMessageTemplateActive('template-1', true);

    expect(rpc).toHaveBeenCalledWith('set_message_template_active', {
      p_template_id: 'template-1',
      p_is_active: true,
    });
  });
});
