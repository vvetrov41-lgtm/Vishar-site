-- 0023_owner_artist_transfer.sql
--
-- Owner-only, atomic transfer of an enquiry/project work tree between artists.
-- Historical activity remains append-only in its event-time artist scope; a
-- new owner-only audit row records the transfer. Work with payment, calendar,
-- trusted-source or already-routed integration state cannot be transferred.

-- Parent/child composite artist constraints must be deferred while the whole
-- tree moves atomically. They are still enforced at transaction end.
alter table public.projects
  alter constraint projects_enquiry_artist_fkey deferrable initially deferred;
alter table public.sessions
  alter constraint sessions_project_artist_fkey deferrable initially deferred;
alter table public.follow_ups
  alter constraint follow_ups_enquiry_artist_fkey deferrable initially deferred;
alter table public.follow_ups
  alter constraint follow_ups_project_artist_fkey deferrable initially deferred;
alter table public.email_messages
  alter constraint email_messages_enquiry_artist_fkey deferrable initially deferred;
alter table public.email_messages
  alter constraint email_messages_project_artist_fkey deferrable initially deferred;
alter table public.integration_outbox
  alter constraint integration_outbox_enquiry_artist_fkey deferrable initially deferred;
alter table public.integration_outbox
  alter constraint integration_outbox_project_artist_fkey deferrable initially deferred;
alter table public.integration_outbox
  alter constraint integration_outbox_session_artist_fkey deferrable initially deferred;
alter table public.integration_outbox
  alter constraint integration_outbox_email_artist_fkey deferrable initially deferred;

-- Activity rows describe the scope at the time an event occurred. The original
-- simple entity FKs from migration 0005 remain authoritative for existence;
-- these later composite FKs would otherwise require rewriting append-only
-- history during a transfer.
alter table public.activity_log
  drop constraint activity_log_enquiry_artist_fkey;
alter table public.activity_log
  drop constraint activity_log_project_artist_fkey;
alter table public.activity_log
  drop constraint activity_log_session_artist_fkey;

comment on column public.activity_log.artist_id is
  'Event-time artist context. Historical rows remain unchanged after an owner-only work transfer; NULL is reserved for global/profile/system events.';

create or replace function crm_private.owner_artist_transfer_context()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select public.is_owner()
     and nullif(pg_catalog.current_setting('crm.owner_artist_transfer', true), '') = 'on';
$$;

revoke all on function crm_private.owner_artist_transfer_context()
  from public, anon, authenticated, service_role;

-- The normal immutability rules stay closed. Only the owner-only transfer RPC
-- sets the transaction-local context, and browser roles still have no direct
-- UPDATE privilege on these tables.
create or replace function crm_private.scope_enquiry_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'UPDATE'
     and new.artist_id is distinct from old.artist_id
     and not crm_private.owner_artist_transfer_context() then
    raise exception 'enquiries.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  if new.artist_id is null then
    new.artist_id := crm_private.legacy_default_artist_id();
  end if;

  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_project_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE'
     and new.artist_id is distinct from old.artist_id
     and not crm_private.owner_artist_transfer_context() then
    raise exception 'projects.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id);

  if v_parent_artist is not null then
    if new.artist_id is null then
      new.artist_id := v_parent_artist;
    elsif new.artist_id <> v_parent_artist then
      raise exception 'project artist must match the source enquiry artist'
        using errcode = '23514';
    end if;
  elsif new.artist_id is null then
    new.artist_id := crm_private.legacy_default_artist_id();
  end if;

  if tg_op = 'INSERT' and new.enquiry_id is null then
    perform crm_private.require_active_artist(new.artist_id);
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_session_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE'
     and new.artist_id is distinct from old.artist_id
     and not crm_private.owner_artist_transfer_context() then
    raise exception 'sessions.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(null, new.project_id);

  if new.artist_id is null then
    new.artist_id := v_parent_artist;
  elsif new.artist_id <> v_parent_artist then
    raise exception 'session artist must match the parent project artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_follow_up_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE'
     and new.artist_id is distinct from old.artist_id
     and not crm_private.owner_artist_transfer_context() then
    raise exception 'follow_ups.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id, new.project_id);

  if new.artist_id is null then
    new.artist_id := coalesce(v_parent_artist, crm_private.legacy_default_artist_id());
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'follow-up artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.scope_email_message_artist()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_parent_artist uuid;
begin
  if tg_op = 'UPDATE'
     and new.artist_id is distinct from old.artist_id
     and not crm_private.owner_artist_transfer_context() then
    raise exception 'email_messages.artist_id is immutable; use the protected transfer workflow'
      using errcode = '23514';
  end if;

  v_parent_artist := crm_private.resolve_artist_from_links(new.enquiry_id, new.project_id);

  if new.artist_id is null then
    new.artist_id := coalesce(v_parent_artist, crm_private.legacy_default_artist_id());
  elsif v_parent_artist is not null and new.artist_id <> v_parent_artist then
    raise exception 'email artist must match every linked entity artist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.scope_enquiry_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_project_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_session_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_follow_up_artist()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.scope_email_message_artist()
  from public, anon, authenticated, service_role;

create or replace function public.transfer_work_to_artist(
  p_enquiry_id uuid,
  p_project_id uuid,
  p_to_artist_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry_id uuid;
  v_project_id uuid;
  v_client_id uuid;
  v_from_artist_id uuid;
  v_project_artist_id uuid;
  v_previous_context text;
  v_session_count integer := 0;
  v_follow_up_count integer := 0;
  v_email_count integer := 0;
begin
  perform crm_private.require_role('owner');

  if num_nonnulls(p_enquiry_id, p_project_id) <> 1 then
    raise exception 'provide exactly one enquiry_id or project_id'
      using errcode = '22023';
  end if;

  if coalesce(p_reason_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'transfer reason must be a short machine code'
      using errcode = '22023';
  end if;

  perform crm_private.require_active_artist(p_to_artist_id);

  if p_enquiry_id is not null then
    select e.id, e.client_id, e.artist_id
      into v_enquiry_id, v_client_id, v_from_artist_id
    from public.enquiries e
    where e.id = p_enquiry_id
    for update;

    if not found then
      raise exception 'enquiry % does not exist', p_enquiry_id
        using errcode = '23503';
    end if;

    select p.id into v_project_id
    from public.projects p
    where p.enquiry_id = v_enquiry_id
    for update;
  else
    select p.id, p.enquiry_id, p.client_id, p.artist_id
      into v_project_id, v_enquiry_id, v_client_id, v_from_artist_id
    from public.projects p
    where p.id = p_project_id
    for update;

    if not found then
      raise exception 'project % does not exist', p_project_id
        using errcode = '23503';
    end if;

    if v_enquiry_id is not null then
      perform 1
      from public.enquiries e
      where e.id = v_enquiry_id
      for update;
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'artist-transfer:' || coalesce(v_project_id, v_enquiry_id)::text,
      0
    )
  );

  if v_project_id is not null then
    select p.artist_id into v_project_artist_id
    from public.projects p
    where p.id = v_project_id;

    if v_project_artist_id <> v_from_artist_id then
      raise exception 'enquiry/project artist scope is inconsistent'
        using errcode = '23514';
    end if;
  end if;

  if v_from_artist_id = p_to_artist_id then
    return jsonb_build_object(
      'enquiry_id', v_enquiry_id,
      'project_id', v_project_id,
      'from_artist_id', v_from_artist_id,
      'to_artist_id', p_to_artist_id,
      'changed', false
    );
  end if;

  -- A trusted website source is part of immutable intake provenance. Reassigning
  -- it would contradict the source-to-artist mapping.
  if v_enquiry_id is not null and exists (
    select 1
    from public.enquiries e
    where e.id = v_enquiry_id and e.booking_source_id is not null
  ) then
    raise exception 'trusted-source enquiries cannot be transferred between artists'
      using errcode = '23514';
  end if;

  -- Financial identity belongs to the original artist business account. Work
  -- must be transferred before any legacy or ledger-backed money state exists.
  if v_project_id is not null and exists (
    select 1
    from public.projects p
    where p.id = v_project_id
      and (p.deposit_amount is not null or p.deposit_status <> 'not_required')
  ) then
    raise exception 'work with legacy deposit state cannot be transferred'
      using errcode = '23514';
  end if;

  if v_project_id is not null and exists (
    select 1
    from public.sessions s
    where s.project_id = v_project_id
      and (
        s.price is not null
        or s.payment_status <> 'unpaid'
        or s.calendar_event_id is not null
        or s.calendar_provider <> 'none'
      )
  ) then
    raise exception 'work with session payment/calendar state cannot be transferred'
      using errcode = '23514';
  end if;

  if v_project_id is not null and exists (
    select 1
    from public.payment_requests r
    where r.project_id = v_project_id
       or r.session_id in (
         select s.id from public.sessions s where s.project_id = v_project_id
       )
  ) then
    raise exception 'work with a payment request cannot be transferred'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.email_messages m
    where (m.enquiry_id = v_enquiry_id or m.project_id = v_project_id)
      and m.status <> 'draft'
  ) then
    raise exception 'work with an approved or delivered email cannot be transferred'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.integration_outbox o
    where o.enquiry_id = v_enquiry_id
       or o.project_id = v_project_id
       or o.session_id in (
         select s.id from public.sessions s where s.project_id = v_project_id
       )
       or o.email_message_id in (
         select m.id
         from public.email_messages m
         where m.enquiry_id = v_enquiry_id or m.project_id = v_project_id
       )
  ) then
    raise exception 'work with routed integration jobs cannot be transferred'
      using errcode = '23514';
  end if;

  v_previous_context := pg_catalog.current_setting(
    'crm.owner_artist_transfer', true
  );

  perform set_config('crm.owner_artist_transfer', 'on', true);

  begin
    if v_enquiry_id is not null then
      update public.enquiries
      set artist_id = p_to_artist_id,
          assigned_to = null
      where id = v_enquiry_id;
    end if;

    if v_project_id is not null then
      update public.projects
      set artist_id = p_to_artist_id
      where id = v_project_id;

      update public.sessions
      set artist_id = p_to_artist_id
      where project_id = v_project_id;
      get diagnostics v_session_count = row_count;
    end if;

    update public.follow_ups f
    set artist_id = p_to_artist_id,
        assigned_to = case
          when f.assigned_to is null then null
          when exists (
            select 1
            from crm_private.artist_access a
            where a.profile_id = f.assigned_to
              and a.artist_id = p_to_artist_id
              and a.is_active
              and a.access_level <> 'read_only'
          ) then f.assigned_to
          else null
        end
    where f.enquiry_id = v_enquiry_id
       or f.project_id = v_project_id;
    get diagnostics v_follow_up_count = row_count;

    update public.email_messages
    set artist_id = p_to_artist_id
    where status = 'draft'
      and (enquiry_id = v_enquiry_id or project_id = v_project_id);
    get diagnostics v_email_count = row_count;

    perform set_config(
      'crm.owner_artist_transfer',
      coalesce(v_previous_context, ''),
      true
    );
  exception when others then
    perform set_config(
      'crm.owner_artist_transfer',
      coalesce(v_previous_context, ''),
      true
    );
    raise;
  end;

  perform crm_private.log_artist_activity(
    p_to_artist_id,
    'artist.work_transferred',
    'owner',
    auth.uid(),
    v_client_id,
    v_enquiry_id,
    v_project_id,
    null,
    null,
    jsonb_build_object(
      'from_artist_id', v_from_artist_id,
      'to_artist_id', p_to_artist_id,
      'reason_code', p_reason_code,
      'sessions_moved', v_session_count,
      'follow_ups_moved', v_follow_up_count,
      'draft_emails_moved', v_email_count
    )
  );

  return jsonb_build_object(
    'enquiry_id', v_enquiry_id,
    'project_id', v_project_id,
    'from_artist_id', v_from_artist_id,
    'to_artist_id', p_to_artist_id,
    'sessions_moved', v_session_count,
    'follow_ups_moved', v_follow_up_count,
    'draft_emails_moved', v_email_count,
    'changed', true
  );
end;
$$;

revoke all on function public.transfer_work_to_artist(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_work_to_artist(uuid,uuid,uuid,text)
  to authenticated;

comment on function public.transfer_work_to_artist(uuid,uuid,uuid,text) is
  'Owner-only atomic transfer before payment, calendar, trusted-source or routed integration state exists. Historical audit rows remain append-only in their original artist scope.';
