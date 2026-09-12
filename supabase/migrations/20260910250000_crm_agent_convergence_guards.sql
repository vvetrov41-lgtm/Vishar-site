-- Long-running convergence guards for the CRM AI derived client state.
--
-- A canonical row can return to a state it held before (A -> B -> A), so a
-- state fingerprint alone cannot be the permanent job event id. Also, artist
-- replies and actually-sent CRM email are authoritative history: client memory
-- must converge after those outbound communications, while drafts must not make
-- the brief stale before anything has been sent.

-- ---------------------------------------------------------------------------
-- 1. Mutation events: preserve legacy insert keys, make later writes unique.
-- ---------------------------------------------------------------------------

create or replace function crm_private.enqueue_project_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new text;
  v_event text;
begin
  v_new := crm_private.project_ai_fingerprint(new);
  if tg_op = 'UPDATE' and crm_private.project_ai_fingerprint(old) = v_new then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event := 'project:' || new.id::text || ':' || v_new;
  else
    v_event := 'project:' || new.id::text || ':tx:'
      || pg_current_xact_id()::text || ':' || v_new;
  end if;

  begin
    perform crm_private.schedule_client_ai_refresh(new.artist_id, new.client_id, v_event);
  exception when others then null;
  end;
  return new;
end;
$$;

create or replace function crm_private.enqueue_session_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new text;
  v_event text;
begin
  if new.client_id is null then
    return new;
  end if;

  v_new := crm_private.session_ai_fingerprint(new);
  if tg_op = 'UPDATE' and crm_private.session_ai_fingerprint(old) = v_new then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event := 'session:' || new.id::text || ':' || v_new;
  else
    v_event := 'session:' || new.id::text || ':tx:'
      || pg_current_xact_id()::text || ':' || v_new;
  end if;

  begin
    perform crm_private.schedule_client_ai_refresh(new.artist_id, new.client_id, v_event);
  exception when others then null;
  end;
  return new;
end;
$$;

create or replace function crm_private.enqueue_enquiry_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_watermark text;
  v_source_event_id text;
begin
  if new.intake_state <> 'complete' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.intake_state = 'complete'
     and old.status is not distinct from new.status
     and old.project_type is not distinct from new.project_type
     and old.placement is not distinct from new.placement
     and old.approximate_size is not distinct from new.approximate_size
     and old.cover_up is not distinct from new.cover_up
     and old.preferred_timing is not distinct from new.preferred_timing
     and old.idea is not distinct from new.idea
     and old.archived_at is not distinct from new.archived_at then
    return new;
  end if;

  begin
    -- Keep the established insertion identity so replay of initial completion
    -- stays idempotent. Subsequent edits identify the mutation as well as its
    -- resulting watermark, so A -> B -> A cannot collide with an old job.
    if tg_op = 'INSERT' then
      v_source_event_id := 'enquiry:' || new.id::text || ':' || new.status::text;
    else
      v_watermark := crm_private.client_ai_watermark(new.artist_id, new.client_id);
      v_source_event_id := 'enquiry:' || new.id::text || ':tx:'
        || pg_current_xact_id()::text || ':wm:'
        || left(coalesce(v_watermark, 'missing'), 32);
    end if;

    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, v_source_event_id
    );
  exception when others then null;
  end;
  return new;
end;
$$;

revoke all on function
  crm_private.enqueue_project_client_ai(),
  crm_private.enqueue_session_client_ai(),
  crm_private.enqueue_enquiry_client_ai()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Linked conversations: outbound artist messages are history too.
--
-- Delivery-status updates are intentionally not in the watermark below. The
-- model sees direction/body/occurred_at, not provider delivery bookkeeping.
-- ---------------------------------------------------------------------------

create or replace function crm_private.enqueue_communication_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client uuid;
begin
  if new.direction not in ('inbound', 'outbound')
     or new.body is null or btrim(new.body) = '' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.direction is not distinct from new.direction
     and old.body is not distinct from new.body
     and old.provider_timestamp is not distinct from new.provider_timestamp then
    return new;
  end if;

  select c.client_id into v_client
  from public.communication_conversations c
  where c.id = new.conversation_id
    and c.artist_id = new.artist_id
    and c.client_id is not null;

  if v_client is not null then
    begin
      perform crm_private.schedule_client_ai_refresh(
        new.artist_id,
        v_client,
        'message:' || new.id::text || case when tg_op = 'UPDATE'
          then ':tx:' || pg_current_xact_id()::text else '' end
      );
    exception when others then null;
    end;
  end if;
  return new;
end;
$$;

revoke all on function crm_private.enqueue_communication_client_ai()
  from public, anon, authenticated, service_role;

drop trigger if exists communication_messages_enqueue_client_ai on public.communication_messages;
create trigger communication_messages_enqueue_client_ai
  after insert or update of direction, body, provider_timestamp
  on public.communication_messages
  for each row execute function crm_private.enqueue_communication_client_ai();

comment on function crm_private.enqueue_communication_client_ai() is
  'Refreshes client memory for non-empty inbound and outbound message content on a linked conversation. Delivery bookkeeping alone does not queue model work.';

-- ---------------------------------------------------------------------------
-- 3. CRM-owned email: only sent content is authoritative conversation.
-- ---------------------------------------------------------------------------

create or replace function crm_private.client_ai_watermark(p_artist_id uuid, p_client_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
set "TimeZone" = 'UTC'
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'artist', p_artist_id,
          'client', to_jsonb(c) - 'notes_summary',
          'enquiries', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', e.id, 'status', e.status, 'intake_state', e.intake_state,
              'archived_at', e.archived_at, 'project_type', e.project_type,
              'placement', e.placement, 'approximate_size', e.approximate_size,
              'cover_up', e.cover_up, 'preferred_timing', e.preferred_timing,
              'idea', e.idea
            ) order by e.id), '[]'::jsonb)
            from public.enquiries e
            where e.client_id = p_client_id and e.artist_id = p_artist_id
          ),
          'projects', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'status', p.status, 'deposit_status', p.deposit_status,
              'estimate_total', p.estimate_total, 'estimated_sessions', p.estimated_sessions,
              'estimated_hours', p.estimated_hours, 'hourly_rate', p.hourly_rate,
              'deposit_amount', p.deposit_amount, 'currency', p.currency,
              'archived_at', p.archived_at
            ) order by p.id), '[]'::jsonb)
            from public.projects p
            where p.client_id = p_client_id and p.artist_id = p_artist_id
          ),
          'sessions', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', s.id, 'status', s.status, 'start_at', s.start_at, 'end_at', s.end_at,
              'payment_status', s.payment_status, 'price', s.price,
              'cancelled_at', s.cancelled_at
            ) order by s.id), '[]'::jsonb)
            from public.sessions s
            where s.client_id = p_client_id and s.artist_id = p_artist_id
          ),
          'messages', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', m.id, 'direction', m.direction, 'body', m.body,
              'occurred_at', coalesce(m.provider_timestamp, m.created_at)
            ) order by m.id), '[]'::jsonb)
            from public.communication_messages m
            join public.communication_conversations v
              on v.id = m.conversation_id and v.artist_id = m.artist_id
            where v.client_id = p_client_id and m.artist_id = p_artist_id
          ),
          'emails', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.id, 'subject', x.subject, 'body', x.body, 'sent_at', x.sent_at
            ) order by x.id), '[]'::jsonb)
            from public.email_messages x
            where x.client_id = p_client_id
              and x.artist_id = p_artist_id
              and x.status = 'sent'
          ),
          'gmail', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', g.id, 'last_provider_message_id', g.last_provider_message_id,
              'updated_at', g.updated_at
            ) order by g.id), '[]'::jsonb)
            from crm_private.gmail_thread_contexts g
            where g.client_id = p_client_id and g.artist_id = p_artist_id
          ),
          'gmail_excerpts', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.provider_message_id, 'body', x.body_excerpt
            ) order by x.provider_message_id), '[]'::jsonb)
            from crm_private.gmail_client_ai_excerpts x
            where x.client_id = p_client_id and x.artist_id = p_artist_id
          ),
          'notes', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', n.id, 'updated_at', n.updated_at
            ) order by n.id), '[]'::jsonb)
            from public.internal_notes n
            where n.client_id = p_client_id
          ),
          'images', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', f.id, 'analyzed_at', f.analyzed_at
            ) order by f.id), '[]'::jsonb)
            from public.enquiry_file_ai_analysis f
            where f.client_id = p_client_id and f.artist_id = p_artist_id
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.clients c
  where c.id = p_client_id
    and crm_private.client_ai_scope(p_artist_id, p_client_id) is not null;
$$;

comment on function crm_private.client_ai_watermark(uuid,uuid) is
  'Digest of authoritative client facts. Communication delivery bookkeeping and unsent CRM email drafts do not invalidate memory; actual sent content does.';

create or replace function crm_private.client_timeline_items(p_artist_id uuid, p_client_id uuid)
returns table (
  source text,
  source_id uuid,
  direction text,
  body text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select 'communication'::text, m.id, m.direction::text, m.body,
         coalesce(m.provider_timestamp, m.created_at)
  from public.communication_messages m
  join public.communication_conversations v
    on v.id = m.conversation_id and v.artist_id = m.artist_id
  where v.client_id = p_client_id and m.artist_id = p_artist_id

  union all
  select 'email'::text, x.id, 'outbound'::text,
         x.subject || case when btrim(x.body) = '' then '' else E'\n\n' || x.body end,
         x.sent_at
  from public.email_messages x
  where x.client_id = p_client_id
    and x.artist_id = p_artist_id
    and x.status = 'sent'
    and x.sent_at is not null

  union all
  select 'gmail'::text, g.id, g.direction,
         coalesce(g.subject || ': ', '') || g.body_excerpt,
         g.occurred_at
  from crm_private.gmail_client_ai_excerpts g
  where g.client_id = p_client_id and g.artist_id = p_artist_id

  union all
  select 'gmail_thread'::text, t.id, null::text, t.subject, t.updated_at
  from crm_private.gmail_thread_contexts t
  where t.client_id = p_client_id and t.artist_id = p_artist_id
    and not exists (
      select 1 from crm_private.gmail_client_ai_excerpts g
      where g.artist_id = t.artist_id and g.client_id = t.client_id
        and g.provider_message_id = t.last_provider_message_id
    )

  union all
  select 'enquiry'::text, e.id, 'inbound'::text, e.idea, e.created_at
  from public.enquiries e
  where e.client_id = p_client_id and e.artist_id = p_artist_id and e.archived_at is null

  union all
  select 'note'::text, n.id, null::text, n.body, n.created_at
  from public.internal_notes n
  where n.client_id = p_client_id
    and (
      exists (select 1 from public.enquiries e
              where e.id = n.enquiry_id and e.artist_id = p_artist_id)
      or exists (select 1 from public.projects p
                 where p.id = n.project_id and p.artist_id = p_artist_id)
      or exists (select 1 from public.sessions s
                 where s.id = n.session_id and s.artist_id = p_artist_id)
    )

  union all
  select 'session'::text, s.id, null::text,
         'Session ' || s.status::text || ' ' || to_char(s.start_at, 'YYYY-MM-DD HH24:MI'),
         s.updated_at
  from public.sessions s
  where s.client_id = p_client_id and s.artist_id = p_artist_id;
$$;

revoke all on function crm_private.client_timeline_items(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.enqueue_sent_email_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_event text;
begin
  if new.status <> 'sent' or new.client_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.subject is not distinct from new.subject
     and old.body is not distinct from new.body
     and old.sent_at is not distinct from new.sent_at then
    return new;
  end if;

  if tg_op = 'INSERT' or old.status is distinct from 'sent' then
    v_event := 'email:' || new.id::text || ':sent';
  else
    v_event := 'email:' || new.id::text || ':tx:' || pg_current_xact_id()::text;
  end if;

  begin
    perform crm_private.schedule_client_ai_refresh(new.artist_id, new.client_id, v_event);
  exception when others then null;
  end;
  return new;
end;
$$;

revoke all on function crm_private.enqueue_sent_email_client_ai()
  from public, anon, authenticated, service_role;

drop trigger if exists email_messages_enqueue_client_ai on public.email_messages;
create trigger email_messages_enqueue_client_ai
  after insert or update of status, subject, body, sent_at
  on public.email_messages
  for each row execute function crm_private.enqueue_sent_email_client_ai();

comment on function crm_private.enqueue_sent_email_client_ai() is
  'Refreshes client memory only for an actually-sent CRM email or a material correction to an already-sent record. Draft creation and editing are deliberately ignored.';
