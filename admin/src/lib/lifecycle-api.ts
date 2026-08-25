import { ApiError, type CrmClient } from './api';

export type LifecycleAppointmentType =
  | 'tattoo_session'
  | 'in_person_consultation'
  | 'video_consultation'
  | 'touch_up';

export type LifecycleScheduleAnchor = 'session_start' | 'session_end';
export type LifecycleLocale = 'en' | 'ru';
export type LifecycleSessionStatus =
  | 'draft'
  | 'proposed'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';
export type LifecycleAutomationJobStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
export type MessageTemplateStatus = 'draft' | 'active' | 'retired';

export interface ClientLifecycleRule {
  id: string;
  artist_id: string;
  name: string;
  appointment_type: LifecycleAppointmentType;
  message_purpose: string;
  message_channel: 'email';
  message_locale: LifecycleLocale;
  schedule_anchor: LifecycleScheduleAnchor;
  anchor_offset_minutes: number;
  is_enabled: boolean;
  version: number;
  workspace_default_id: string | null;
  workspace_default_version: number | null;
  workspace_override: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClientLifecycleTemplate {
  id: string;
  workspace_id: string;
  artist_id: string | null;
  template_scope: 'workspace' | 'artist';
  purpose: string;
  classification: 'service';
  purpose_description: string;
  channel: 'email';
  locale: LifecycleLocale;
  version: number;
  status: MessageTemplateStatus;
  subject: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface ClientLifecyclePurpose {
  purpose: string;
  classification: 'service';
  description: string;
}

export interface ClientLifecycleVariable {
  variable: string;
  description: string;
}

export interface ClientLifecyclePreviewSession {
  session_id: string;
  client_name: string;
  appointment_type: LifecycleAppointmentType;
  session_status: LifecycleSessionStatus;
  start_at: string;
  end_at: string;
}

export interface ClientLifecyclePreview {
  rule_id: string;
  rule_name: string;
  rule_version: number;
  rule_enabled: boolean;
  session_id: string;
  client_name: string;
  appointment_type: LifecycleAppointmentType;
  session_status: LifecycleSessionStatus;
  scheduled_at: string;
  template_id: string | null;
  template_version: number | null;
  template_scope: 'workspace' | 'artist' | null;
  rendered_subject: string | null;
  rendered_body: string | null;
  suppression_reason: string | null;
  integration_available: boolean;
  existing_job_id: string | null;
  existing_job_status: LifecycleAutomationJobStatus | null;
  eligible: boolean;
  blocker: string | null;
}

function unwrap<T>(result: { data: unknown; error: unknown }, action: string): T {
  if (result.error) throw new ApiError(`Could not ${action}.`, result.error);
  return (result.data ?? []) as T;
}

export function createLifecycleApi(client: CrmClient) {
  return {
    async listClientLifecycleRules(artistId: string): Promise<ClientLifecycleRule[]> {
      return unwrap<ClientLifecycleRule[]>(
        await client.rpc('list_client_lifecycle_rules', { p_artist_id: artistId }),
        'load lifecycle rules',
      );
    },

    async createClientLifecycleRule(input: {
      artistId: string;
      name: string;
      appointmentType: LifecycleAppointmentType;
      messagePurpose: string;
      scheduleAnchor: LifecycleScheduleAnchor;
      anchorOffsetMinutes: number;
      locale: LifecycleLocale;
    }): Promise<string> {
      const result = await client.rpc('create_client_lifecycle_rule', {
        p_artist_id: input.artistId,
        p_name: input.name,
        p_appointment_type: input.appointmentType,
        p_message_purpose: input.messagePurpose,
        p_schedule_anchor: input.scheduleAnchor,
        p_anchor_offset_minutes: input.anchorOffsetMinutes,
        p_locale: input.locale,
      });
      if (result.error) throw new ApiError('Could not create lifecycle rule.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('The lifecycle rule was not created.', null);
      return result.data;
    },

    async setAutomationRuleEnabled(ruleId: string, enabled: boolean): Promise<boolean> {
      const result = await client.rpc('set_automation_rule_enabled', {
        p_rule_id: ruleId,
        p_is_enabled: enabled,
      });
      if (result.error) throw new ApiError('Could not change lifecycle rule state.', result.error);
      return result.data === true;
    },

    async listClientLifecycleTemplates(artistId: string): Promise<ClientLifecycleTemplate[]> {
      return unwrap<ClientLifecycleTemplate[]>(
        await client.rpc('list_client_lifecycle_templates', { p_artist_id: artistId }),
        'load lifecycle templates',
      );
    },

    async listClientLifecycleTemplatePurposes(artistId: string): Promise<ClientLifecyclePurpose[]> {
      return unwrap<ClientLifecyclePurpose[]>(
        await client.rpc('list_client_lifecycle_template_purposes', { p_artist_id: artistId }),
        'load lifecycle template purposes',
      );
    },

    async listClientLifecycleTemplateVariables(artistId: string): Promise<ClientLifecycleVariable[]> {
      return unwrap<ClientLifecycleVariable[]>(
        await client.rpc('list_client_lifecycle_template_variables', { p_artist_id: artistId }),
        'load lifecycle template variables',
      );
    },

    async listClientLifecyclePreviewSessions(
      artistId: string,
      limit = 50,
    ): Promise<ClientLifecyclePreviewSession[]> {
      return unwrap<ClientLifecyclePreviewSession[]>(
        await client.rpc('list_client_lifecycle_preview_sessions', {
          p_artist_id: artistId,
          p_limit: limit,
        }),
        'load lifecycle preview sessions',
      );
    },

    async previewClientLifecycleRule(
      artistId: string,
      ruleId: string,
      sessionId: string,
    ): Promise<ClientLifecyclePreview | null> {
      const rows = unwrap<ClientLifecyclePreview[]>(
        await client.rpc('preview_client_lifecycle_rule', {
          p_artist_id: artistId,
          p_rule_id: ruleId,
          p_session_id: sessionId,
        }),
        'preview lifecycle rule',
      );
      return rows[0] ?? null;
    },

    async upsertMessageTemplate(input: {
      workspaceId: string;
      artistId: string;
      purpose: string;
      body: string;
      locale: LifecycleLocale;
      subject: string | null;
    }): Promise<string> {
      const result = await client.rpc('upsert_message_template', {
        p_workspace_id: input.workspaceId,
        p_purpose: input.purpose,
        p_channel: 'email',
        p_body: input.body,
        p_locale: input.locale,
        p_subject: input.subject,
        p_artist_id: input.artistId,
      });
      if (result.error) throw new ApiError('Could not save lifecycle template draft.', result.error);
      if (typeof result.data !== 'string') throw new ApiError('The lifecycle template draft was not saved.', null);
      return result.data;
    },

    async setMessageTemplateActive(templateId: string, active: boolean): Promise<boolean> {
      const result = await client.rpc('set_message_template_active', {
        p_template_id: templateId,
        p_is_active: active,
      });
      if (result.error) throw new ApiError('Could not change lifecycle template state.', result.error);
      return result.data === true;
    },
  };
}

export type LifecycleApi = ReturnType<typeof createLifecycleApi>;
