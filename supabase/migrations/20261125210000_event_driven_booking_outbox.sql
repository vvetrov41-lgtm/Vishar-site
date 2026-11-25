-- Application-driven wake hints; no database networking extension is installed.
-- Outbox rows, leases, due dates and provider send guards remain authoritative.

create or replace function crm_private.mark_calendar_outbox_queued()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,crm_private
as $$
begin
  if new.status::text <> 'pending' or new.kind::text not in
      ('calendar_create','calendar_update','calendar_cancel') then return new; end if;
  update public.sessions s
  set calendar_sync_status='queued'
  where s.id=new.session_id and s.artist_id=new.artist_id
    and s.calendar_sync_status='not_connected'
    and s.calendar_version::text=new.payload->>'calendar_version'
    and exists (
      select 1 from public.artist_integrations i
      join public.artists a on a.id=i.artist_id
      where i.artist_id=s.artist_id and i.is_enabled and a.is_active
        and i.integration_type='calendar' and i.provider='google'
        and i.integration_key='google_calendar_'||a.slug
    );
  return new;
end
$$;
revoke all on function crm_private.mark_calendar_outbox_queued() from public,anon,authenticated,service_role;

create or replace function public.get_booking_outbox_wake_hints()
returns table(lane text, due_ms bigint)
language plpgsql
stable
security definer
set search_path=pg_catalog,crm_private
as $$
declare
  v_gpt boolean := nullif(btrim(auth.jwt()->>'client_id'),'') is not null;
  v_artist uuid;
  v_sessions boolean := true;
  v_finance boolean := true;
begin
  if auth.uid() is null then
    raise exception 'CRM authentication required' using errcode='42501';
  end if;
  -- The browser uses ordinary MFA-aware memberships; OAuth clients must also
  -- satisfy the active artist selector and their own independent ceilings.
  if v_gpt then
    select c.artist_id, coalesce(g.can_manage_appointments,false), coalesce(g.can_manage_finance,false)
      into v_artist,v_sessions,v_finance
    from crm_private.require_gpt_client_context() c
    join crm_private.gpt_action_clients g on g.id=c.gpt_client_id;
    if not found or v_artist is null then
      raise exception 'CRM artist context required' using errcode='42501';
    end if;
  end if;
  return query
  with eligible as (
    select case o.kind::text
      when 'calendar_create' then 'calendar'
      when 'calendar_update' then 'calendar'
      when 'calendar_cancel' then 'calendar'
      when 'approved_email' then 'email'
      when 'whatsapp_message' then 'whatsapp'
      when 'instagram_message' then 'instagram' end as lane,
      floor(extract(epoch from greatest(o.next_attempt_at,now()))*1000)::bigint as due_ms
    from public.integration_outbox o
    where o.status::text='pending'
      and o.created_at>=now()-interval '10 minutes'
      and o.next_attempt_at<=now()+interval '5 minutes'
      and (not v_gpt or o.artist_id=v_artist)
      and (
        (o.kind::text in ('calendar_create','calendar_update','calendar_cancel')
          and v_sessions and public.can_manage_artist_sessions(o.artist_id))
        or (o.dedupe_key like '%:booking_card:%'
          and o.kind::text in ('approved_email','whatsapp_message','instagram_message')
          and ((v_sessions and public.can_manage_artist_sessions(o.artist_id))
            or (v_finance and public.can_manage_artist_finance(o.artist_id))))
      )
  )
  select distinct e.lane,e.due_ms from eligible e
  order by e.due_ms,e.lane limit 32;
end
$$;
revoke all on function public.get_booking_outbox_wake_hints() from public,anon,authenticated,service_role;
grant execute on function public.get_booking_outbox_wake_hints() to authenticated;

drop trigger if exists integration_outbox_wake_booking on public.integration_outbox;
create trigger integration_outbox_wake_booking
after insert on public.integration_outbox
for each row execute function crm_private.mark_calendar_outbox_queued();
