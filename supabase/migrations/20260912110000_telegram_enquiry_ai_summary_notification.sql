-- Make the primary new-enquiry Telegram push useful on its own:
-- client name first, a bounded existing CRM-AI summary when available, and no
-- public reference number. The Worker renders the exact CRM deep-link from the
-- notification's enquiry entity id.
--
-- When CRM AI is enabled, the ordinary enquiry notification is held briefly so
-- the already-scheduled client-state refresh can enrich the same notification.
-- If AI is unavailable, the held row is released unchanged after five minutes;
-- there is no second queue and no lost-notification failure mode.

create or replace function public.service_route_telegram_enquiry_notification(
  p_outbox_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_client_id uuid;
  v_client_name text;
  v_file_count integer;
  v_ai_enabled boolean := false;
  v_ai_summary text;
  v_notification_count integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram enquiry routing is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for update;

  if not found
     or v_job.status <> 'leased'
     or v_job.leased_by is distinct from p_worker_id
     or v_job.enquiry_id is null then
    raise exception 'Telegram enquiry outbox lease is unavailable' using errcode = '42501';
  end if;

  select e.client_id,
         left(c.full_name, 80),
         count(f.id)::integer
    into v_client_id, v_client_name, v_file_count
  from public.enquiries e
  join public.clients c on c.id = e.client_id
  left join public.enquiry_files f
    on f.enquiry_id = e.id and f.upload_state = 'ready'
  where e.id = v_job.enquiry_id
    and e.artist_id = v_job.artist_id
    and e.intake_state = 'complete'
  group by e.client_id, c.full_name;

  if not found or v_file_count < 1 or nullif(btrim(v_client_name), '') is null then
    raise exception 'Telegram enquiry projection is invalid' using errcode = '22023';
  end if;

  select coalesce(enabled, false)
    into v_ai_enabled
  from crm_private.crm_agent_config
  where singleton;
  v_ai_enabled := coalesce(v_ai_enabled, false);

  -- A client can submit another enquiry after an earlier AI brief exists. Use
  -- the brief only when its watermark still describes the live CRM after this
  -- enquiry; otherwise let the normal refresh enrich the held notification.
  if v_ai_enabled then
    select left(btrim(st.summary), 1800)
      into v_ai_summary
    from public.client_ai_state st
    where st.artist_id = v_job.artist_id
      and st.client_id = v_client_id
      and st.source_watermark = crm_private.client_ai_watermark(v_job.artist_id, v_client_id)
    order by st.refreshed_at desc
    limit 1;
  end if;

  insert into public.notifications (
    recipient_profile_id, artist_id, workspace_id,
    notification_type, title, body, entity_type, entity_id,
    priority, status, dedupe_key, scheduled_at, delivered_at
  )
  select
    am.profile_id,
    v_job.artist_id,
    a.workspace_id,
    'enquiry.created',
    left('New enquiry: ' || v_client_name, 200),
    case
      when v_ai_summary is not null then
        left('AI summary:' || E'\n' || v_ai_summary, 2000)
      when v_ai_enabled then
        'New enquiry received. AI summary is being prepared.'
      else
        'New enquiry received.'
    end,
    'enquiry',
    v_job.enquiry_id,
    'high',
    'delivered',
    'enquiry_created:' || v_job.enquiry_id::text || ':' || am.profile_id::text,
    case when v_ai_enabled and v_ai_summary is null
         then now() + interval '5 minutes'
         else now()
    end,
    now()
  from public.artist_memberships am
  join public.artists a
    on a.id = am.artist_id and a.is_active
  where am.artist_id = v_job.artist_id
    and am.is_active
    and crm_private.telegram_notification_recipient_eligible(
      am.profile_id, v_job.artist_id, a.workspace_id
    )
  on conflict (dedupe_key) do nothing;

  select count(*)::integer into v_notification_count
  from public.notifications n
  where n.entity_type = 'enquiry'
    and n.entity_id = v_job.enquiry_id
    and n.notification_type = 'enquiry.created'
    and n.dedupe_key like 'enquiry_created:' || v_job.enquiry_id::text || ':%';

  if v_notification_count = 0 then
    return jsonb_build_object(
      'routed', false,
      'notification_count', 0,
      'error_code', 'telegram_destination_unavailable'
    );
  end if;

  return jsonb_build_object(
    'routed', true,
    'notification_count', v_notification_count,
    'error_code', null
  );
end;
$$;

revoke all on function public.service_route_telegram_enquiry_notification(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_route_telegram_enquiry_notification(uuid, text)
  to service_role;

-- Enrich the SAME held enquiry notification as soon as a fresh AI brief lands.
-- Once Telegram has created any delivery row the payload is immutable for that
-- send attempt, so the trigger refuses to race an in-flight or completed send.
create or replace function crm_private.enrich_recent_enquiry_notification_from_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_name text;
begin
  select left(c.full_name, 80)
    into v_client_name
  from public.clients c
  where c.id = new.client_id;

  if not found or nullif(btrim(v_client_name), '') is null then
    return new;
  end if;

  update public.notifications n
  set title = left('New enquiry: ' || v_client_name, 200),
      body = left('AI summary:' || E'\n' || btrim(new.summary), 2000),
      scheduled_at = now(),
      updated_at = now()
  from public.enquiries e
  where n.notification_type = 'enquiry.created'
    and n.entity_type = 'enquiry'
    and n.entity_id = e.id
    and e.client_id = new.client_id
    and e.artist_id = new.artist_id
    and n.artist_id = new.artist_id
    and n.created_at >= now() - interval '15 minutes'
    and not exists (
      select 1
      from crm_private.telegram_notification_deliveries d
      where d.notification_id = n.id
    );

  return new;
end;
$$;

revoke all on function crm_private.enrich_recent_enquiry_notification_from_client_ai()
  from public, anon, authenticated, service_role;

drop trigger if exists client_ai_state_enrich_enquiry_notification
  on public.client_ai_state;
create trigger client_ai_state_enrich_enquiry_notification
after insert or update of summary, source_watermark
on public.client_ai_state
for each row
execute function crm_private.enrich_recent_enquiry_notification_from_client_ai();

-- The new-enquiry row is now the primary push. Suppress the separate
-- `client_ai.next_action` push for the short intake window, per recipient, so a
-- normal new enquiry never creates two Telegram alerts. Later recommendations
-- retain their existing behaviour.
create or replace function crm_private.enqueue_client_ai_notification(p_next_action_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_action public.client_ai_next_actions%rowtype;
  v_client_name text;
  v_count integer := 0;
begin
  select a.* into v_action
  from public.client_ai_next_actions a
  where a.id = p_next_action_id and a.status = 'open' and a.approval_required;
  if not found then
    return 0;
  end if;

  select left(c.full_name, 80) into v_client_name
  from public.clients c where c.id = v_action.client_id;
  if not found then
    return 0;
  end if;

  insert into public.notifications (
    recipient_profile_id, artist_id, workspace_id,
    notification_type, title, body, entity_type, entity_id,
    priority, status, dedupe_key, scheduled_at
  )
  select
    am.profile_id,
    v_action.artist_id,
    a.workspace_id,
    'client_ai.next_action',
    left('Needs you: ' || v_client_name, 200),
    left(
      'Suggested next step: ' || v_action.action_type
      || E'\n' || left(v_action.reason, 600)
      || E'\nThis is a suggestion for your review. Nothing has been sent to the client.',
      2000),
    'client',
    v_action.client_id,
    case when v_action.priority = 'high' then 'high'::public.notification_priority
         else 'normal'::public.notification_priority end,
    'pending',
    'client_ai_next_action:' || v_action.id::text || ':' || am.profile_id::text,
    now()
  from public.artist_memberships am
  join public.artists a on a.id = am.artist_id and a.is_active
  where am.artist_id = v_action.artist_id
    and am.is_active
    and crm_private.telegram_notification_recipient_eligible(
      am.profile_id, v_action.artist_id, a.workspace_id)
    and not exists (
      select 1
      from public.notifications initial_n
      join public.enquiries initial_e
        on initial_e.id = initial_n.entity_id
       and initial_n.entity_type = 'enquiry'
      where initial_n.notification_type = 'enquiry.created'
        and initial_n.artist_id = v_action.artist_id
        and initial_n.recipient_profile_id = am.profile_id
        and initial_e.artist_id = v_action.artist_id
        and initial_e.client_id = v_action.client_id
        and initial_n.created_at >= now() - interval '15 minutes'
    )
  on conflict (dedupe_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function crm_private.enqueue_client_ai_notification(uuid)
  from public, anon, authenticated, service_role;
