-- A Today row can be factually correct and still no longer require work: the
-- operator may have replied in the provider app, or may deliberately leave a
-- requested deposit outstanding until the client pays. Keep that acknowledgement
-- separate from the business record. It suppresses only the exact observed
-- version; a newer client message or project change becomes visible again.

create table public.attention_acknowledgements (
  artist_id       uuid not null references public.artists(id) on delete cascade,
  item_kind       text not null,
  entity_id       uuid not null,
  observed_at     timestamptz not null,
  acknowledged_at timestamptz not null default now(),
  acknowledged_by uuid references public.profiles(id) on delete set null,
  primary key (artist_id, item_kind, entity_id),
  constraint attention_acknowledgements_kind_allowed check (
    item_kind in ('conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding')
  ),
  constraint attention_acknowledgements_observed_not_future check (
    observed_at <= acknowledged_at + interval '5 minutes'
  )
);

comment on table public.attention_acknowledgements is
  'Shared artist work-queue acknowledgements. A row hides only an observed version of a dismissible Today item; newer source activity reopens the work.';

alter table public.attention_acknowledgements enable row level security;
revoke all on table public.attention_acknowledgements
  from public, anon, authenticated, service_role;

create or replace function public.list_attention_acknowledgements(
  p_artist_id uuid default null
)
returns table (
  artist_id uuid,
  item_kind text,
  entity_id uuid,
  observed_at timestamptz,
  acknowledged_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.artist_id, a.item_kind, a.entity_id, a.observed_at, a.acknowledged_at
  from public.attention_acknowledgements a
  where (p_artist_id is null or a.artist_id = p_artist_id)
    and crm_private.has_artist_capability(a.artist_id, 'view_notifications')
  order by a.acknowledged_at desc;
$$;

create or replace function public.acknowledge_attention_item(
  p_artist_id uuid,
  p_item_kind text,
  p_entity_id uuid,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_source_at timestamptz;
  v_actor_kind text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_artist_id is null or p_item_kind is null or p_entity_id is null or p_observed_at is null then
    raise exception 'artist, kind, entity and observed time are required' using errcode = '22023';
  end if;
  if p_item_kind not in (
    'conversation_reply', 'gmail_reply', 'new_enquiry', 'deposit_outstanding'
  ) then
    raise exception 'attention item kind is not dismissible' using errcode = '22023';
  end if;
  if p_observed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'attention item time cannot be in the future' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'manage_notifications');

  case p_item_kind
    when 'conversation_reply' then
      select c.client_id, c.enquiry_id, c.last_inbound_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.communication_conversations c
      where c.id = p_entity_id and c.artist_id = p_artist_id;
    when 'gmail_reply' then
      select c.id, null::uuid, p_observed_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.clients c
      join public.artists a on a.workspace_id = c.workspace_id
      where c.id = p_entity_id and a.id = p_artist_id and c.archived_at is null;
    when 'new_enquiry' then
      select e.client_id, e.id, e.created_at
        into v_client_id, v_enquiry_id, v_source_at
      from public.enquiries e
      where e.id = p_entity_id and e.artist_id = p_artist_id and e.archived_at is null;
    when 'deposit_outstanding' then
      select p.client_id, p.enquiry_id, p.id, p.updated_at
        into v_client_id, v_enquiry_id, v_project_id, v_source_at
      from public.projects p
      where p.id = p_entity_id and p.artist_id = p_artist_id and p.archived_at is null;
  end case;

  if v_source_at is null then
    raise exception 'attention item does not exist in this artist scope' using errcode = 'P0002';
  end if;
  -- A stale screen may acknowledge the version it actually showed, but it may
  -- not claim to have handled source activity that had not happened yet.
  if p_observed_at > v_source_at + interval '5 minutes'
     and p_item_kind <> 'gmail_reply' then
    raise exception 'attention item version is newer than its source' using errcode = '22023';
  end if;

  insert into public.attention_acknowledgements (
    artist_id, item_kind, entity_id, observed_at, acknowledged_at, acknowledged_by
  ) values (
    p_artist_id, p_item_kind, p_entity_id, p_observed_at, clock_timestamp(), auth.uid()
  )
  on conflict (artist_id, item_kind, entity_id) do update
  set observed_at = greatest(public.attention_acknowledgements.observed_at, excluded.observed_at),
      acknowledged_at = clock_timestamp(),
      acknowledged_by = auth.uid();

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    p_artist_id,
    'attention.dismissed',
    v_actor_kind,
    auth.uid(),
    v_client_id,
    v_enquiry_id,
    v_project_id,
    null,
    null,
    jsonb_build_object('kind', p_item_kind)
  );

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'item_kind', p_item_kind,
    'entity_id', p_entity_id,
    'observed_at', p_observed_at,
    'acknowledged', true
  );
end;
$$;

revoke all on function public.list_attention_acknowledgements(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_attention_item(uuid,text,uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.list_attention_acknowledgements(uuid)
  to authenticated;
grant execute on function public.acknowledge_attention_item(uuid,text,uuid,timestamptz)
  to authenticated;

comment on function public.list_attention_acknowledgements(uuid) is
  'Lists queue acknowledgements only for artists the signed-in profile may view.';
comment on function public.acknowledge_attention_item(uuid,text,uuid,timestamptz) is
  'Acknowledges one exact dismissible Today item version after validating artist scope and source ownership. It changes no enquiry, conversation, project, appointment or payment state.';
