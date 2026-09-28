-- Unified GPT v2: Communications remainder, Notifications/Templates and
-- Automations operator parity.
--
-- Templates and lifecycle rules decide what clients are sent, so they need the
-- dedicated automations ceiling (profile-bound client only) plus the human's
-- automations capability. Consent and suppression stay enforced by the send
-- pipeline; nothing here edits sent history.

-- ----------------------------------------------------------- Communications

create or replace function public.gpt_edit_email_draft(p_message_id uuid, p_body text, p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('communications', 'manage_communications');
  select m.artist_id into v_artist from public.email_messages m where m.id = p_message_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'email draft');
  return public.edit_email_draft(p_message_id, p_body, p_expected_updated_at);
end;
$$;

create or replace function public.gpt_dismiss_failed_email(p_email_message_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('communications', 'manage_communications');
  select m.artist_id into v_artist from public.email_messages m where m.id = p_email_message_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'email');
  perform public.dismiss_failed_email_message(p_email_message_id);
  return jsonb_build_object('email_message_id', p_email_message_id, 'dismissed', true);
end;
$$;

create or replace function public.gpt_get_conversation_link_suggestion(p_conversation_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('communications', 'view_communications');
  select c.artist_id into v_artist from public.communication_conversations c where c.id = p_conversation_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'conversation');
  return public.get_conversation_link_suggestion(p_conversation_id);
end;
$$;

-- ------------------------------------------------------------ Notifications

create or replace function public.gpt_snooze_follow_up(p_follow_up_id uuid, p_until timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_notifications');
  select f.artist_id into v_artist from public.follow_ups f where f.id = p_follow_up_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'follow-up');
  return public.snooze_follow_up(p_follow_up_id, p_until);
end;
$$;

-- The notification inbox belongs to the signed-in person. The GPT shows the
-- active Artist's items plus Artist-less system items, so switching Artist
-- never surfaces the previous Artist's alerts.
create or replace function public.gpt_list_notifications(p_status public.notification_status default null, p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_notifications');
  return coalesce((
    select jsonb_agg(to_jsonb(n))
    from public.list_notifications(p_status, least(greatest(coalesce(p_limit, 50), 1), 100)) n
    where n.artist_id is null or n.artist_id = v_ctx.artist_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_mark_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid; v_recipient uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'view_notifications');
  select n.artist_id, n.recipient_profile_id into v_artist, v_recipient
  from public.notifications n where n.id = p_notification_id;
  if v_recipient is distinct from auth.uid() or (v_artist is not null and v_artist <> v_ctx.artist_id) then
    raise exception 'notification is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  return jsonb_build_object('notification_id', p_notification_id, 'marked', public.mark_notification_read(p_notification_id));
end;
$$;

create or replace function public.gpt_mark_all_notifications_read()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_domain_context('crm', 'view_notifications');
  return jsonb_build_object('marked', public.mark_all_notifications_read());
end;
$$;

create or replace function public.gpt_get_notification_preferences()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('crm_read');
  return coalesce((
    select jsonb_agg(jsonb_build_object('channel', p.channel, 'is_enabled', p.is_enabled, 'updated_at', p.updated_at) order by p.channel)
    from public.notification_preferences p where p.profile_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_set_notification_preference(p_channel public.notification_channel, p_is_enabled boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('crm');
  return jsonb_build_object('channel', p_channel, 'is_enabled', public.set_notification_preference(p_channel, p_is_enabled));
end;
$$;

create or replace function public.gpt_list_attention_acknowledgements()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_notifications');
  return coalesce((select jsonb_agg(to_jsonb(a)) from public.list_attention_acknowledgements(v_ctx.artist_id) a), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_acknowledge_attention_item(p_item_kind text, p_entity_id uuid, p_observed_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm', 'manage_notifications');
  return public.acknowledge_attention_item(v_ctx.artist_id, p_item_kind, p_entity_id, p_observed_at);
end;
$$;

create or replace function public.gpt_list_message_templates()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(t)) from public.list_client_lifecycle_templates(v_ctx.artist_id) t), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_template_purposes()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(t)) from public.list_client_lifecycle_template_purposes(v_ctx.artist_id) t), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_template_variables()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(t)) from public.list_client_lifecycle_template_variables(v_ctx.artist_id) t), '[]'::jsonb);
end;
$$;

-- p_scope 'artist' edits the active Artist's own template; 'workspace' edits
-- the default of the workspace that owns the active Artist (the CRM RPC then
-- requires workspace management).
create or replace function public.gpt_upsert_message_template(
  p_scope text,
  p_purpose text,
  p_channel public.message_template_channel,
  p_body text,
  p_locale text default 'en',
  p_subject text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  if p_scope not in ('artist', 'workspace') then
    raise exception 'template scope must be artist or workspace' using errcode = '22023';
  end if;
  select * into v_ctx from crm_private.require_gpt_context_workspace('automations', 'manage_automations');
  return jsonb_build_object('template_id', public.upsert_message_template(
    v_ctx.workspace_id, p_purpose, p_channel, p_body, p_locale, p_subject,
    case when p_scope = 'artist' then v_ctx.artist_id else null end));
end;
$$;

create or replace function public.gpt_set_message_template_active(p_template_id uuid, p_is_active boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_template public.message_templates%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('automations', 'manage_automations');
  select t.* into v_template from public.message_templates t where t.id = p_template_id;
  if v_template.id is null
     or v_template.workspace_id is distinct from v_ctx.workspace_id
     or (v_template.artist_id is not null and v_template.artist_id <> v_ctx.artist_id) then
    raise exception 'template is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  return jsonb_build_object('template_id', p_template_id, 'is_active', public.set_message_template_active(p_template_id, p_is_active));
end;
$$;

-- -------------------------------------------------------------- Automations

create or replace function crm_private.gpt_automation_rule(p_rule_id uuid, p_capability text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', p_capability);
  select r.artist_id into v_artist from public.automation_rules r where r.id = p_rule_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'automation rule');
  return v_ctx.artist_id;
end;
$$;
revoke all on function crm_private.gpt_automation_rule(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.gpt_list_lifecycle_rules()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(r)) from public.list_client_lifecycle_rules(v_ctx.artist_id) r), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_create_lifecycle_rule(
  p_name text,
  p_appointment_type public.appointment_type,
  p_message_purpose text,
  p_schedule_anchor public.automation_schedule_anchor,
  p_anchor_offset_minutes integer,
  p_locale text default 'en'
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'manage_automations');
  return jsonb_build_object('rule_id', public.create_client_lifecycle_rule(v_ctx.artist_id, p_name,
    p_appointment_type, p_message_purpose, p_schedule_anchor, p_anchor_offset_minutes, p_locale));
end;
$$;

create or replace function public.gpt_update_lifecycle_rule_timing(p_rule_id uuid, p_timing_direction text, p_amount integer, p_unit text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_automation_rule(p_rule_id, 'manage_automations');
  return coalesce((select jsonb_agg(to_jsonb(t))
    from public.update_client_lifecycle_rule_timing(p_rule_id, p_timing_direction, p_amount, p_unit) t), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_set_lifecycle_rule_enabled(p_rule_id uuid, p_is_enabled boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_automation_rule(p_rule_id, 'manage_automations');
  return jsonb_build_object('rule_id', p_rule_id, 'is_enabled', public.set_automation_rule_enabled(p_rule_id, p_is_enabled));
end;
$$;

create or replace function public.gpt_list_lifecycle_preview_sessions(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(s))
    from public.list_client_lifecycle_preview_sessions(v_ctx.artist_id, least(greatest(coalesce(p_limit, 50), 1), 100)) s), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_preview_lifecycle_rule(p_rule_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_artist uuid; v_session_artist uuid;
begin
  v_artist := crm_private.gpt_automation_rule(p_rule_id, 'view_automations');
  select s.artist_id into v_session_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_session_artist, v_artist, 'session');
  return coalesce((select jsonb_agg(to_jsonb(p))
    from public.preview_client_lifecycle_rule(v_artist, p_rule_id, p_session_id) p), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_lifecycle_execution_history(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(h))
    from public.list_client_lifecycle_execution_history(v_ctx.artist_id, least(greatest(coalesce(p_limit, 50), 1), 100)) h), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_lifecycle_configuration_history(
  p_limit integer default 50,
  p_before_occurred_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(h))
    from public.list_lifecycle_configuration_history(v_ctx.artist_id, least(greatest(coalesce(p_limit, 50), 1), 100),
      p_before_occurred_at, p_before_id) h), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_get_lifecycle_health()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(h)) from public.get_lifecycle_automation_health(v_ctx.artist_id) h), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_retry_lifecycle_job(p_job_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'manage_automations');
  select j.artist_id into v_artist from public.automation_jobs j where j.id = p_job_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'automation job');
  return coalesce((select jsonb_agg(to_jsonb(r)) from public.retry_client_lifecycle_job(p_job_id) r), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_workspace_automation_defaults()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('automations', 'view_automations');
  return coalesce((select jsonb_agg(to_jsonb(d)) from public.list_workspace_automation_defaults(v_ctx.workspace_id) d), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_apply_workspace_automation_defaults()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('automations', 'manage_automations');
  return jsonb_build_object('applied', public.apply_workspace_automation_defaults_to_artist(v_ctx.artist_id));
end;
$$;

-- --------------------------------------------------------------------- grants

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.gpt_edit_email_draft(uuid,text,timestamptz)',
    'public.gpt_dismiss_failed_email(uuid)',
    'public.gpt_get_conversation_link_suggestion(uuid)',
    'public.gpt_snooze_follow_up(uuid,timestamptz)',
    'public.gpt_list_notifications(public.notification_status,integer)',
    'public.gpt_mark_notification_read(uuid)',
    'public.gpt_mark_all_notifications_read()',
    'public.gpt_get_notification_preferences()',
    'public.gpt_set_notification_preference(public.notification_channel,boolean)',
    'public.gpt_list_attention_acknowledgements()',
    'public.gpt_acknowledge_attention_item(text,uuid,timestamptz)',
    'public.gpt_list_message_templates()',
    'public.gpt_list_template_purposes()',
    'public.gpt_list_template_variables()',
    'public.gpt_upsert_message_template(text,text,public.message_template_channel,text,text,text)',
    'public.gpt_set_message_template_active(uuid,boolean)',
    'public.gpt_list_lifecycle_rules()',
    'public.gpt_create_lifecycle_rule(text,public.appointment_type,text,public.automation_schedule_anchor,integer,text)',
    'public.gpt_update_lifecycle_rule_timing(uuid,text,integer,text)',
    'public.gpt_set_lifecycle_rule_enabled(uuid,boolean)',
    'public.gpt_list_lifecycle_preview_sessions(integer)',
    'public.gpt_preview_lifecycle_rule(uuid,uuid)',
    'public.gpt_list_lifecycle_execution_history(integer)',
    'public.gpt_list_lifecycle_configuration_history(integer,timestamptz,uuid)',
    'public.gpt_get_lifecycle_health()',
    'public.gpt_retry_lifecycle_job(uuid)',
    'public.gpt_list_workspace_automation_defaults()',
    'public.gpt_apply_workspace_automation_defaults()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
