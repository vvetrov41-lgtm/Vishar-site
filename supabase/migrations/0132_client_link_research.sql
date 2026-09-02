-- 0132_client_link_research.sql
--
-- Automatic, fail-closed research of public URLs that known CRM clients send
-- through WhatsApp, Instagram or Gmail. Provider fetches never happen in a DB
-- trigger: inbound communications only enqueue bounded work, and a server-side
-- Worker later claims it and calls Firecrawl through the existing gateway.
--
-- External page content remains untrusted evidence. It cannot select an artist,
-- authorize a mutation or overwrite the source message.

create table public.client_link_research (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  client_id uuid references public.clients(id) on delete cascade,
  enquiry_id uuid references public.enquiries(id) on delete set null,
  conversation_id uuid references public.communication_conversations(id) on delete cascade,
  communication_message_id uuid references public.communication_messages(id) on delete cascade,
  channel text not null,
  source_message_key text not null,
  source_url text not null,
  normalized_url text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 4,
  next_attempt_at timestamptz not null default now(),
  leased_by text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  title text,
  markdown_excerpt text,
  resolved_url text,
  error_code text,
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_link_research_channel check (channel in ('whatsapp', 'instagram', 'gmail')),
  constraint client_link_research_source_key_length check (char_length(source_message_key) between 1 and 255),
  constraint client_link_research_source_url_length check (char_length(source_url) between 8 and 2048),
  constraint client_link_research_normalized_url_length check (char_length(normalized_url) between 8 and 2048),
  constraint client_link_research_status check (status in ('pending', 'processing', 'ready', 'failed')),
  constraint client_link_research_attempt_bounds check (attempt_count between 0 and max_attempts and max_attempts between 1 and 8),
  constraint client_link_research_title_length check (title is null or char_length(title) <= 500),
  constraint client_link_research_excerpt_length check (markdown_excerpt is null or char_length(markdown_excerpt) <= 12000),
  constraint client_link_research_resolved_url_length check (resolved_url is null or char_length(resolved_url) between 8 and 2048),
  constraint client_link_research_error_shape check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint client_link_research_lease_shape check (
    (status = 'processing' and leased_by is not null and leased_at is not null and lease_expires_at is not null)
    or (status <> 'processing' and leased_by is null and leased_at is null and lease_expires_at is null)
  ),
  unique (artist_id, channel, source_message_key, normalized_url)
);

create index client_link_research_due_idx
  on public.client_link_research (next_attempt_at, created_at)
  where status in ('pending', 'failed', 'processing');
create index client_link_research_client_idx
  on public.client_link_research (client_id, created_at desc)
  where client_id is not null;
create index client_link_research_message_idx
  on public.client_link_research (communication_message_id)
  where communication_message_id is not null;

alter table public.client_link_research enable row level security;

create policy client_link_research_select_artist_scope on public.client_link_research
  for select
  using (
    crm_private.is_service_backend()
    or public.can_access_artist(artist_id)
  );

revoke all on table public.client_link_research from public, anon;
grant select on table public.client_link_research to authenticated;
grant select, insert, update, delete on table public.client_link_research to service_role;

comment on table public.client_link_research is
  'Artist-scoped analysis of public URLs sent by known clients. Source messages remain immutable; Firecrawl output is stored as untrusted evidence.';

-- ---------------------------------------------------------------------------
-- URL extraction and idempotent enqueue
-- ---------------------------------------------------------------------------

create or replace function crm_private.extract_http_urls(
  p_body text,
  p_limit integer default 8
)
returns table(url text)
language sql
stable
set search_path = pg_catalog
as $function$
  with matches as (
    select m[1] as candidate, ordinality
    from regexp_matches(
      coalesce(p_body, ''),
      $regex$(https?://[^[:space:]<>"'\[\]{}]+)$regex$,
      'gi'
    ) with ordinality as r(m, ordinality)
  ), normalized as (
    select rtrim(candidate, '.,;:!?)]}') as candidate, ordinality
    from matches
  )
  select candidate
  from normalized
  where char_length(candidate) between 8 and 2048
  group by candidate, ordinality
  order by min(ordinality)
  limit least(greatest(coalesce(p_limit, 8), 1), 8);
$function$;

revoke all on function crm_private.extract_http_urls(text, integer)
  from public, anon, authenticated, service_role;

create or replace function crm_private.enqueue_client_link_research(
  p_artist_id uuid,
  p_client_id uuid,
  p_enquiry_id uuid,
  p_conversation_id uuid,
  p_communication_message_id uuid,
  p_channel text,
  p_source_message_key text,
  p_url text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_id uuid;
  v_url text := btrim(coalesce(p_url, ''));
begin
  if p_artist_id is null
     or p_channel not in ('whatsapp', 'instagram', 'gmail')
     or nullif(btrim(coalesce(p_source_message_key, '')), '') is null
     or char_length(p_source_message_key) > 255
     or char_length(v_url) not between 8 and 2048
     or v_url !~* '^https?://' then
    return null;
  end if;

  insert into public.client_link_research (
    artist_id, client_id, enquiry_id, conversation_id, communication_message_id,
    channel, source_message_key, source_url, normalized_url
  ) values (
    p_artist_id, p_client_id, p_enquiry_id, p_conversation_id, p_communication_message_id,
    p_channel, p_source_message_key, v_url, v_url
  )
  on conflict (artist_id, channel, source_message_key, normalized_url)
  do update set
    client_id = coalesce(excluded.client_id, client_link_research.client_id),
    enquiry_id = coalesce(excluded.enquiry_id, client_link_research.enquiry_id),
    conversation_id = coalesce(excluded.conversation_id, client_link_research.conversation_id),
    communication_message_id = coalesce(excluded.communication_message_id, client_link_research.communication_message_id),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function crm_private.enqueue_client_link_research(uuid,uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.capture_communication_client_links()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_conversation public.communication_conversations%rowtype;
  v_url text;
begin
  if new.direction::text <> 'inbound'
     or new.channel::text not in ('whatsapp', 'instagram')
     or nullif(new.body, '') is null then
    return new;
  end if;

  select c.* into v_conversation
  from public.communication_conversations c
  where c.id = new.conversation_id
    and c.artist_id = new.artist_id;
  if not found then
    return new;
  end if;

  for v_url in select u.url from crm_private.extract_http_urls(new.body, 8) u loop
    perform crm_private.enqueue_client_link_research(
      new.artist_id,
      v_conversation.client_id,
      v_conversation.enquiry_id,
      new.conversation_id,
      new.id,
      new.channel::text,
      new.id::text,
      v_url
    );
  end loop;

  return new;
end;
$function$;

revoke all on function crm_private.capture_communication_client_links()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_capture_client_links on public.communication_messages;
create trigger communication_messages_capture_client_links
  after insert on public.communication_messages
  for each row execute function crm_private.capture_communication_client_links();

create or replace function crm_private.relink_communication_client_links()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if new.client_id is distinct from old.client_id or new.enquiry_id is distinct from old.enquiry_id then
    update public.client_link_research r
    set client_id = new.client_id,
        enquiry_id = new.enquiry_id,
        updated_at = now()
    where r.conversation_id = new.id
      and r.artist_id = new.artist_id;
  end if;
  return new;
end;
$function$;

revoke all on function crm_private.relink_communication_client_links()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_conversations_relink_client_links on public.communication_conversations;
create trigger communication_conversations_relink_client_links
  after update of client_id, enquiry_id on public.communication_conversations
  for each row execute function crm_private.relink_communication_client_links();

-- Existing legitimate recent client messages are safe to enqueue. This creates
-- no fake customer data and lets production acceptance use real history when it
-- already contains a URL.
insert into public.client_link_research (
  artist_id, client_id, enquiry_id, conversation_id, communication_message_id,
  channel, source_message_key, source_url, normalized_url
)
select
  m.artist_id,
  c.client_id,
  c.enquiry_id,
  c.id,
  m.id,
  m.channel::text,
  m.id::text,
  u.url,
  u.url
from public.communication_messages m
join public.communication_conversations c
  on c.id = m.conversation_id and c.artist_id = m.artist_id
cross join lateral crm_private.extract_http_urls(m.body, 8) u
where m.direction::text = 'inbound'
  and m.channel::text in ('whatsapp', 'instagram')
  and c.client_id is not null
  and m.created_at >= now() - interval '30 days'
on conflict (artist_id, channel, source_message_key, normalized_url) do nothing;

-- ---------------------------------------------------------------------------
-- Backend-only Gmail discovery and queue operations
-- ---------------------------------------------------------------------------

create or replace function public.service_list_gmail_link_research_mailboxes()
returns table(
  artist_id uuid,
  integration_key text,
  mailbox_email text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail link research discovery is backend-only' using errcode = '42501';
  end if;

  return query
  select i.artist_id, i.integration_key, lower(btrim(i.external_account_label))
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
    and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null
  order by i.artist_id;
end;
$function$;

create or replace function public.service_enqueue_client_link_research(
  p_artist_id uuid,
  p_client_id uuid,
  p_channel text,
  p_source_message_key text,
  p_url text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'client link research enqueue is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or p_client_id is null or p_channel <> 'gmail' then
    raise exception 'valid Gmail client link research context is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.enquiries e
    where e.artist_id = p_artist_id and e.client_id = p_client_id
  ) then
    raise exception 'client is outside this artist scope' using errcode = '42501';
  end if;

  return crm_private.enqueue_client_link_research(
    p_artist_id, p_client_id, null, null, null,
    'gmail', p_source_message_key, p_url
  );
end;
$function$;

create or replace function public.claim_client_link_research(
  p_worker_id text,
  p_limit integer default 5,
  p_lease_seconds integer default 180
)
returns table(
  research_id uuid,
  source_url text,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_limit integer := coalesce(p_limit, 5);
  v_lease_seconds integer := coalesce(p_lease_seconds, 180);
begin
  if not crm_private.is_service_backend() then
    raise exception 'client link research claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$'
     or v_limit < 1 or v_limit > 10
     or v_lease_seconds < 60 or v_lease_seconds > 600 then
    raise exception 'invalid client link research claim' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select r.id
    from public.client_link_research r
    where r.client_id is not null
      and r.attempt_count < r.max_attempts
      and (
        (r.status in ('pending', 'failed') and r.next_attempt_at <= now())
        or (r.status = 'processing' and r.lease_expires_at <= now())
      )
    order by r.next_attempt_at, r.created_at, r.id
    for update skip locked
    limit v_limit
  ), leased as (
    update public.client_link_research r
    set status = 'processing',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where r.id = c.id
    returning r.*
  )
  select l.id, l.source_url, l.attempt_count, l.max_attempts
  from leased l
  order by l.created_at, l.id;
end;
$function$;

create or replace function public.record_client_link_research_result(
  p_research_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_title text default null,
  p_markdown_excerpt text default null,
  p_resolved_url text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_job public.client_link_research%rowtype;
  v_attempt integer;
  v_terminal boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'client link research result is backend-only' using errcode = '42501';
  end if;
  if p_research_id is null
     or coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$'
     or p_succeeded is null then
    raise exception 'valid client link research result is required' using errcode = '22023';
  end if;
  if p_succeeded then
    if p_resolved_url is null or char_length(p_resolved_url) not between 8 and 2048
       or char_length(coalesce(p_title, '')) > 500
       or char_length(coalesce(p_markdown_excerpt, '')) > 12000 then
      raise exception 'invalid successful client link research result' using errcode = '22023';
    end if;
  elsif coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed client link research requires a safe error code' using errcode = '22023';
  end if;

  select r.* into v_job
  from public.client_link_research r
  where r.id = p_research_id
  for update;
  if not found then
    raise exception 'client link research job is unavailable' using errcode = '22023';
  end if;
  if v_job.status <> 'processing' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'client link research lease is not owned by this worker' using errcode = '42501';
  end if;

  v_attempt := v_job.attempt_count + 1;
  if not p_succeeded and p_error_code = 'invalid_public_url' then
    v_attempt := v_job.max_attempts;
  end if;
  v_terminal := v_attempt >= v_job.max_attempts;

  update public.client_link_research r
  set status = case when p_succeeded then 'ready' else 'failed' end,
      attempt_count = v_attempt,
      next_attempt_at = case
        when p_succeeded or v_terminal then r.next_attempt_at
        else now() + make_interval(secs => least((power(2, least(v_attempt, 7)) * 60)::integer, 3600))
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      title = case when p_succeeded then nullif(btrim(coalesce(p_title, '')), '') else r.title end,
      markdown_excerpt = case when p_succeeded then coalesce(p_markdown_excerpt, '') else r.markdown_excerpt end,
      resolved_url = case when p_succeeded then p_resolved_url else r.resolved_url end,
      error_code = case when p_succeeded then null else p_error_code end,
      provider_metadata = case when p_succeeded
        then jsonb_build_object('provider', 'firecrawl', 'untrusted_content', true)
        else r.provider_metadata
      end,
      updated_at = now()
  where r.id = p_research_id;

  return jsonb_build_object(
    'research_id', p_research_id,
    'status', case when p_succeeded then 'ready' else 'failed' end,
    'attempt_count', v_attempt,
    'terminal', v_terminal
  );
end;
$function$;

create or replace function public.service_list_client_link_research(
  p_artist_id uuid,
  p_client_id uuid,
  p_channel text default null,
  p_limit integer default 100
)
returns table(
  research_id uuid,
  channel text,
  source_message_key text,
  source_url text,
  status text,
  title text,
  markdown_excerpt text,
  resolved_url text,
  error_code text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if not crm_private.is_service_backend() then
    raise exception 'client link research read is backend-only' using errcode = '42501';
  end if;
  if p_artist_id is null or p_client_id is null
     or (p_channel is not null and p_channel not in ('whatsapp', 'instagram', 'gmail')) then
    raise exception 'valid client link research scope is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.enquiries e
    where e.artist_id = p_artist_id and e.client_id = p_client_id
    union all
    select 1 from public.projects p
    where p.artist_id = p_artist_id and p.client_id = p_client_id
  ) then
    raise exception 'client is outside this artist scope' using errcode = '42501';
  end if;

  return query
  select r.id, r.channel, r.source_message_key, r.source_url, r.status,
         r.title, r.markdown_excerpt, r.resolved_url, r.error_code, r.updated_at
  from public.client_link_research r
  where r.artist_id = p_artist_id
    and r.client_id = p_client_id
    and (p_channel is null or r.channel = p_channel)
  order by r.created_at desc, r.id desc
  limit v_limit;
end;
$function$;

revoke all on function public.service_list_gmail_link_research_mailboxes()
  from public, anon, authenticated;
revoke all on function public.service_enqueue_client_link_research(uuid,uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.claim_client_link_research(text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.record_client_link_research_result(uuid,text,boolean,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.service_list_client_link_research(uuid,uuid,text,integer)
  from public, anon, authenticated;

grant execute on function public.service_list_gmail_link_research_mailboxes() to service_role;
grant execute on function public.service_enqueue_client_link_research(uuid,uuid,text,text,text) to service_role;
grant execute on function public.claim_client_link_research(text,integer,integer) to service_role;
grant execute on function public.record_client_link_research_result(uuid,text,boolean,text,text,text,text) to service_role;
grant execute on function public.service_list_client_link_research(uuid,uuid,text,integer) to service_role;
