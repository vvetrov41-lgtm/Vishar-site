-- Auto-complete due tattoo appointments and queue a visual aftercare email.
-- Canonical basis: 2026-10-09 production service_run_automation_tick.
-- Applies to Vladimir and Kristina only, via their enrolled aftercare rules.
-- Scheduler cadence: every five minutes. Gmail outbox drains asynchronously.
-- No historical backfill; no client email is sent by the migration itself.

insert into public.message_template_purposes(purpose,classification,description)
values ('post_session_aftercare','service','First post-session aftercare link and thanks.')
on conflict(purpose) do nothing;

with target as (
  select distinct a.workspace_id from public.artists a
  join crm_private.artist_state st on st.artist_id=a.id and st.is_active
  where a.slug in ('vladimir','kristina')
)
insert into public.message_templates
  (workspace_id,artist_id,purpose,channel,locale,status,subject,body,created_by)
select t.workspace_id,null,'post_session_aftercare','email','en','active',
  'Thank you for today | Your tattoo aftercare',
  'Hi {{client_first_name}},

I hope your tattoo session went well today. Thank you for trusting me with your tattoo.

Your aftercare guide is here:
https://vishartattoo.com/aftercare/

Please choose the healing method we discussed at the studio and follow the instructions. If you are unsure about anything while your tattoo heals, just reply to this email.

Take care,
{{artist_display_name}}',
  null
from target t
where not exists (
  select 1 from public.message_templates m
  where m.workspace_id=t.workspace_id and m.artist_id is null
    and m.purpose='post_session_aftercare'
    and m.channel='email' and m.locale='en' and m.status='active'
);

with target as (
  select a.id as artist_id from public.artists a
  join crm_private.artist_state st on st.artist_id=a.id and st.is_active
  where a.slug in ('vladimir','kristina')
),
spec(appointment_type,name) as (
  values ('tattoo_session','Aftercare card - after tattoo session'),
         ('touch_up','Aftercare card - after touch-up')
)
insert into public.automation_rules
  (artist_id,name,trigger_event_type,condition_from_status,condition_to_status,
   delay_minutes,action_type,action_title,action_body,action_priority,
   schedule_anchor,anchor_offset_minutes,condition_appointment_type,
   message_purpose,message_channel,message_locale,is_enabled,created_by)
select t.artist_id,s.name,'appointment.scheduled',null,null,0,
       'send_client_message','Post-session aftercare',null,'normal',
       'session_end',0,s.appointment_type::public.appointment_type,
       'post_session_aftercare','email','en',true,null
from target t cross join spec s
where not exists (
  select 1 from public.automation_rules r
  where r.artist_id=t.artist_id and r.message_purpose='post_session_aftercare'
    and r.condition_appointment_type=s.appointment_type::public.appointment_type
    and r.schedule_anchor='session_end' and r.anchor_offset_minutes=0
);

-- Static HTML is attached only to a verified automated aftercare message.
-- The plain-text template always remains available as a MIME fallback.
create or replace function crm_private.decorate_post_session_aftercare_email()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $fn$
begin
  if new.created_by_kind='system'
    and new.automation_job_id is not null
    and new.template_key='post_session_aftercare' then
    new.html_body := $html$
<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#101318;color:#ecf1f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#101318;padding:38px 14px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;border:1px solid #34414d;background:#191f26;border-radius:18px;overflow:hidden">
<tr><td style="height:4px;background:#75bcde;font-size:1px;line-height:4px">&nbsp;</td></tr>
<tr><td style="padding:34px 30px 18px">
<p style="margin:0 0 22px;font-size:11px;letter-spacing:3px;color:#8abbd3;font-weight:700">TATTOO AFTERCARE</p>
<h1 style="font-size:29px;line-height:1.2;color:#ffffff;font-weight:600;letter-spacing:-.5px;margin:0 0 16px">Thank you for today.</h1>
<p style="font-size:16px;line-height:1.65;color:#d3dce4;margin:0 0 16px">I hope your tattoo session went well. Your fresh tattoo deserves the right care from day one.</p>
<p style="font-size:15px;line-height:1.65;color:#bec9d2;margin:0 0 27px">Open your aftercare guide and follow the healing method we discussed in the studio.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#a6d5ed" style="border-radius:9px">
<a href="https://vishartattoo.com/aftercare/" target="_blank" style="display:inline-block;padding:17px 26px;color:#0e1a24;font-size:15px;font-weight:700;text-decoration:none;border-radius:9px">OPEN AFTERCARE GUIDE &nbsp;&#8599;</a>
</td></tr></table>
<p style="font-size:13px;line-height:1.6;color:#9aabb8;margin:25px 0 2px">Questions while healing? Just reply to this email.</p>
</td></tr>
<tr><td style="border-top:1px solid #35414b;padding:17px 30px;color:#91a5b6;font-size:12px;letter-spacing:1px">VISHAR TATTOO &middot; AFTERCARE</td></tr>
</table>
<p style="font-size:12px;line-height:1.5;color:#9eacb9;max-width:520px;margin:19px 0">If the button does not work, open https://vishartattoo.com/aftercare/</p>
</td></tr></table></body></html>
$html$;
  end if;
  return new;
end;
$fn$;

drop trigger if exists email_messages_post_session_aftercare_html on public.email_messages;
create trigger email_messages_post_session_aftercare_html
before insert on public.email_messages
for each row execute function crm_private.decorate_post_session_aftercare_email();

revoke all on function crm_private.decorate_post_session_aftercare_email()
from public,anon,authenticated,service_role;

-- In the shared service tick, use the same authoritative status, calendar
-- version, and activity audit path as the manual appointment completion.
create or replace function crm_private.auto_complete_due_tattoo_sessions(p_limit integer default 100)
returns integer language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $fn$
declare
  v public.sessions%rowtype;
  n integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'post-session completion is backend-only' using errcode='42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid post-session batch size' using errcode='22023';
  end if;

  for v in
    select s.* from public.sessions s
    join crm_private.artist_state st on st.artist_id=s.artist_id and st.is_active
    where s.status='confirmed'
      and s.appointment_type in ('tattoo_session','touch_up')
      and s.start_at < s.end_at
      and s.end_at <= now()
      -- No retrospective change to old appointments after the rollout.
      and s.end_at >= now() - interval '36 hours'
      and exists (
        select 1 from public.automation_rules r
        where r.artist_id=s.artist_id
          and r.message_purpose='post_session_aftercare'
      )
    order by s.end_at,s.id
    for update of s skip locked
    limit p_limit
  loop
    update public.sessions
    set status='completed',calendar_version=v.calendar_version+1
    where id=v.id and status='confirmed';
    if not found then continue; end if;

    perform crm_private.log_artist_activity(
      v.artist_id,'appointment.status_changed','system',null,
      v.client_id,v.enquiry_id,v.project_id,v.id,null,
      jsonb_build_object('appointment_type',v.appointment_type,
        'from_status','confirmed','to_status','completed',
        'completion_source','scheduled_end')
    );
    if public.session_is_calendar_eligible('completed'::public.session_status) then
      if v.calendar_event_id is null then
        perform crm_private.enqueue_outbox(
          'calendar_create',
          public.calendar_outbox_dedupe_key('create',v.id,v.calendar_version+1),
          jsonb_build_object('session_id',v.id,'appointment_type',v.appointment_type,
            'calendar_version',v.calendar_version+1),
          v.client_id,v.enquiry_id,v.project_id,v.id,null
        );
      else
        perform crm_private.enqueue_outbox(
          'calendar_update',
          public.calendar_outbox_dedupe_key('update',v.id,v.calendar_version+1),
          jsonb_build_object('session_id',v.id,'appointment_type',v.appointment_type,
            'calendar_version',v.calendar_version+1),
          v.client_id,v.enquiry_id,v.project_id,v.id,null
        );
      end if;
    end if;
    n := n+1;
  end loop;
  return n;
end;
$fn$;

revoke all on function crm_private.auto_complete_due_tattoo_sessions(integer)
from public,anon,authenticated,service_role;

-- Same signature and existing body, with one bounded pre-tick call.

CREATE OR REPLACE FUNCTION public.service_run_automation_tick(p_limit integer DEFAULT 100)
 RETURNS TABLE(materialised integer, withdrawn integer, executed integer, notified integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_materialised integer := 0;
  v_withdrawn integer := 0;
  v_executed integer := 0;
  v_notified integer := 0;
  v_client_job record;
  v_client_result text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'automation ticks are backend-only' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'automation tick limit must be between 1 and 500' using errcode = '22023';
  end if;

  -- Complete eligible tattoo sessions before selecting due client lifecycle emails.
  perform crm_private.auto_complete_due_tattoo_sessions(100);

  with pairs as (
    select r.id as rule_id, r.version, e.id as event_id, e.artist_id,
           r.action_type, r.action_title, r.action_body, r.action_priority,
           r.schedule_anchor, r.anchor_offset_minutes,
           r.condition_appointment_type,
           r.message_purpose, r.message_channel, r.message_locale,
           case
             when r.action_type = 'send_client_message'::public.automation_action_type
             then e.entity_id
             else null
           end as session_id,
           crm_private.resolve_automation_scheduled_at(
             r.schedule_anchor,
             r.delay_minutes,
             r.anchor_offset_minutes,
             e.occurred_at,
             e.artist_id,
             e.entity_kind,
             e.entity_id,
             r.condition_appointment_type
           ) as scheduled_at
    from public.automation_events e
    join public.automation_rules r
      on r.artist_id = e.artist_id
     and r.trigger_event_type = e.event_type
     and r.is_enabled
    where (r.condition_from_status is null or r.condition_from_status = e.from_status)
      and (r.condition_to_status is null or r.condition_to_status = e.to_status)
      and not exists (
        select 1 from public.automation_jobs j
        where j.rule_id = r.id and j.event_id = e.id
      )
      -- A client rule conditioned on one appointment type still sees every
      -- session event its artist emits, and an event it can never match never
      -- produces a job. Without this predicate those pairs are re-selected on
      -- every tick, and once there are more of them than p_limit they occupy
      -- the whole batch in occurred_at order and starve the real work behind
      -- them. Excluding them here rather than after the limit is what keeps
      -- the batch made of pairs that can actually materialise.
      and (
        r.action_type <> 'send_client_message'::public.automation_action_type
        or exists (
          select 1
          from public.sessions s
          where s.id = e.entity_id
            and s.artist_id = e.artist_id
            and s.appointment_type = r.condition_appointment_type
        )
      )
    order by e.occurred_at, e.id
    limit p_limit
  ),
  inserted as (
    insert into public.automation_jobs (
      rule_id, rule_version, event_id, artist_id,
      action_type, action_title, action_body, action_priority,
      schedule_anchor, anchor_offset_minutes, condition_appointment_type,
      message_purpose, message_channel, message_locale,
      session_id, scheduled_at
    )
    select rule_id, version, event_id, artist_id,
           action_type, action_title, action_body, action_priority,
           schedule_anchor, anchor_offset_minutes, condition_appointment_type,
           message_purpose, message_channel, message_locale,
           session_id, scheduled_at
    from pairs
    where scheduled_at is not null
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_materialised from inserted;

  -- Withdraw stale rule snapshots first. A later reschedule never revives work
  -- that was explicitly disabled or edited.
  with stale as (
    update public.automation_jobs j
    set status = 'cancelled',
        cancelled_at = now(),
        last_error_category = 'rule_withdrawn'
    from public.automation_rules r
    where j.rule_id = r.id
      and j.status = 'pending'
      and (not r.is_enabled or r.version <> j.rule_version)
    returning 1
  )
  select count(*)::int into v_withdrawn from stale;

  -- Reconcile every still-pending lifecycle job from the authoritative session.
  -- This is the reschedule primitive: the domain row moves, the job follows.
  update public.automation_jobs j
  set scheduled_at = case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end
  from public.sessions s
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and s.id = j.session_id
    and s.artist_id = j.artist_id
    and j.scheduled_at is distinct from case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end;

  -- Definitive appointment states cancel pending lifecycle work. Proposed/draft
  -- are deliberately not terminal: a later confirmation may still make a due
  -- reminder eligible, and the next tick will pick it up.
  update public.automation_jobs j
  set status = 'cancelled', cancelled_at = now(),
      last_error_category = 'appointment_ineligible'
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and (
      not exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and s.appointment_type = j.condition_appointment_type
      )
      or exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and (
            (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show', 'completed'))
            or
            (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show'))
          )
      )
    );

  -- Legacy artist-team notification execution is unchanged.
  with due as (
    select j.id, j.artist_id, j.action_title, j.action_body, j.action_priority,
           e.entity_kind, e.entity_id
    from public.automation_jobs j
    join public.automation_events e on e.id = j.event_id
    join crm_private.artist_state s on s.artist_id = j.artist_id and s.is_active
    where j.status = 'pending'
      and j.scheduled_at <= now()
      and j.action_type = 'notify_artist_team'
      and crm_private.automations_enabled_for_artist(j.artist_id)
    order by j.scheduled_at, j.id
    limit p_limit
  ),
  targeted as (
    select d.*, r.profile_id
    from due d
    cross join lateral crm_private.automation_notification_recipients(d.artist_id) r
  ),
  sent as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    )
    select t.profile_id, t.artist_id, 'automation.triggered',
           t.action_title, t.action_body,
           case when t.entity_id is not null then t.entity_kind end,
           t.entity_id, t.action_priority,
           'delivered',
           'automation_job:' || t.id::text || ':' || t.profile_id::text,
           now(), now()
    from targeted t
    on conflict (dedupe_key) do nothing
    returning 1
  ),
  finished as (
    update public.automation_jobs j
    set status = 'completed',
        completed_at = now(),
        attempt_count = j.attempt_count + 1,
        last_error_category = case
          when exists (select 1 from targeted t where t.id = j.id) then 'none'
          else 'no_recipient'
        end
    where j.id in (select id from due)
    returning 1
  )
  select (select count(*)::int from finished), (select count(*)::int from sent)
  into v_executed, v_notified;

  -- Client work is executed one locked job at a time. The helper rechecks every
  -- live gate under that lock and creates email + outbox atomically.
  for v_client_job in
    select j.id
    from public.automation_jobs j
    join public.sessions s
      on s.id = j.session_id
     and s.artist_id = j.artist_id
    join crm_private.artist_state a
      on a.artist_id = j.artist_id
     and a.is_active
    where j.status = 'pending'
      and j.action_type = 'send_client_message'::public.automation_action_type
      and j.scheduled_at <= now()
      and crm_private.automations_enabled_for_artist(j.artist_id)
      and (
        (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
         and s.status = 'confirmed')
        or
        (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
         and s.status = 'completed')
      )
    order by j.scheduled_at, j.id
    limit p_limit
  loop
    v_client_result := crm_private.execute_client_lifecycle_job(v_client_job.id);
    if v_client_result in ('queued', 'failed', 'blocked', 'cancelled') then
      v_executed := v_executed + 1;
    end if;
  end loop;

  return query select v_materialised, v_withdrawn, v_executed, v_notified;
end;
$function$
;

do $guard$
declare
  n integer;
begin
  select count(*) into n from public.automation_rules r
  join public.artists a on a.id=r.artist_id
  where a.slug in ('vladimir','kristina')
    and r.message_purpose='post_session_aftercare'
    and r.is_enabled and r.anchor_offset_minutes=0
    and r.schedule_anchor='session_end';
  if n<>4 then
    raise exception 'expected four active tattoo/touch-up aftercare rules for two artists; found %',n;
  end if;
  if exists (
    select 1 from public.automation_rules r
    join public.artists a on a.id=r.artist_id
    where a.slug in ('vladimir','kristina') and r.message_purpose='post_session_aftercare'
      and not exists (
        select 1 from public.message_templates m
        where m.workspace_id=a.workspace_id
          and (m.artist_id is null or m.artist_id=a.id)
          and m.purpose=r.message_purpose
          and m.channel=r.message_channel and m.locale=r.message_locale
          and m.status='active'
      )
  ) then raise exception 'aftercare template missing'; end if;
end
$guard$;
