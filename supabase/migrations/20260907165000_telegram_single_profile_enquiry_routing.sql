-- 20260907165000_telegram_single_profile_enquiry_routing.sql
--
-- New enquiry alerts now use the same profile-scoped Telegram destination as
-- every other CRM notification. The outbox job materialises an idempotent
-- internal notification; the existing personal Telegram delivery queue owns
-- the provider call, delivery history and destination health readback.

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
  v_reference text;
  v_file_count integer;
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

  select e.reference_number,
         count(f.id)::integer
    into v_reference, v_file_count
  from public.enquiries e
  left join public.enquiry_files f
    on f.enquiry_id = e.id and f.upload_state = 'ready'
  where e.id = v_job.enquiry_id
    and e.artist_id = v_job.artist_id
    and e.intake_state = 'complete'
  group by e.reference_number;

  if not found or v_file_count < 1 then
    raise exception 'Telegram enquiry projection is invalid' using errcode = '22023';
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
    'New enquiry ' || v_reference,
    'Reference: ' || v_reference || E'\nReference images: ' || v_file_count::text,
    'enquiry',
    v_job.enquiry_id,
    'high',
    'delivered',
    'enquiry_created:' || v_job.enquiry_id::text || ':' || am.profile_id::text,
    now(),
    now()
  from public.artist_memberships am
  join public.artists a
    on a.id = am.artist_id and a.is_active
  join public.profiles p
    on p.id = am.profile_id and p.is_active
  join crm_private.telegram_destinations d
    on d.destination_kind = 'profile'
   and d.profile_id = am.profile_id
   and d.is_active
  join public.notification_preferences pref
    on pref.profile_id = am.profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where am.artist_id = v_job.artist_id
    and am.is_active
    and am.access_level = 'artist'
    and crm_private.profile_can_receive_notification(
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

revoke all on function public.service_route_telegram_enquiry_notification(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_route_telegram_enquiry_notification(uuid,text)
  to service_role;

comment on function public.service_route_telegram_enquiry_notification(uuid,text) is
  'Turns one leased enquiry Telegram outbox job into deduplicated profile notifications. It performs no provider call and returns no chat id.';

create or replace function public.service_recover_telegram_enquiry_outbox(
  p_outbox_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_has_destination boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram enquiry recovery is backend-only' using errcode = '42501';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for update;

  if not found
     or v_job.status <> 'dead'
     or v_job.last_error_code <> 'telegram_destination_unavailable'
     or v_job.enquiry_id is null then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_job_not_recoverable');
  end if;

  if exists (
    select 1 from public.activity_log a
    where a.outbox_id = v_job.id and a.event_type = 'outbox.succeeded'
  ) or exists (
    select 1 from public.notifications n
    where n.entity_type = 'enquiry'
      and n.entity_id = v_job.enquiry_id
      and n.notification_type = 'enquiry.created'
  ) then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_delivery_evidence_present');
  end if;

  select exists (
    select 1
    from public.artist_memberships am
    join public.artists a on a.id = am.artist_id and a.is_active
    join public.profiles p on p.id = am.profile_id and p.is_active
    join crm_private.telegram_destinations d
      on d.destination_kind = 'profile'
     and d.profile_id = am.profile_id
     and d.is_active
    join public.notification_preferences pref
      on pref.profile_id = am.profile_id
     and pref.channel = 'telegram'
     and pref.is_enabled
    where am.artist_id = v_job.artist_id
      and am.is_active
      and am.access_level = 'artist'
      and crm_private.profile_can_receive_notification(
        am.profile_id, v_job.artist_id, a.workspace_id
      )
  ) into v_has_destination;

  if not v_has_destination then
    return jsonb_build_object('recovered', false, 'error_code', 'telegram_destination_unavailable');
  end if;

  update public.integration_outbox o
  set status = 'failed',
      attempt_count = 0,
      next_attempt_at = now(),
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = null,
      updated_at = now()
  where o.id = v_job.id;

  return jsonb_build_object('recovered', true, 'error_code', null);
end;
$$;

revoke all on function public.service_recover_telegram_enquiry_outbox(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_recover_telegram_enquiry_outbox(uuid)
  to service_role;

comment on function public.service_recover_telegram_enquiry_outbox(uuid) is
  'Requeues only a destination-unavailable dead enquiry job with no success or notification evidence and an active profile Telegram route.';
