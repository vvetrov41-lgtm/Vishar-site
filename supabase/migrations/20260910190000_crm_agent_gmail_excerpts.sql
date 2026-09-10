-- 20260910190000_crm_agent_gmail_excerpts.sql
--
-- What the client actually SAID in a Gmail reply, for the client brief.
--
-- THE GAP THIS CLOSES
--
-- 20260910180000 schedules a refresh when a Gmail thread advances, but the
-- timeline only carries thread metadata, so the brief learned that a reply had
-- happened without learning what it said. A client writing "yes, 19 October
-- works, but could we change the dragon to black and grey?" produced a refresh
-- whose context contained the subject line and nothing else.
--
-- WHY THE CONTENT ARRIVES THIS WAY
--
-- Gmail message bodies are not CRM rows: the Gmail Worker reads them from the
-- mailbox with its own OAuth token. The Worker that drains CRM agent jobs
-- (`tattooai`) deliberately holds no Gmail credential, and the scheduler's
-- configuration states in as many words that no Gmail OAuth/client/token/KV
-- credential may be copied into it. Fetching mail at claim time would mean
-- giving a third Worker mailbox access, which is a new trust boundary for a
-- derived-state feature.
--
-- The established direction is the opposite one, and it already exists: the
-- Gmail Worker, having completed an authorized read, pushes bounded content
-- into the database through a `service_` RPC. That is exactly what
-- `service_observe_gmail_enquiry_ai` does with `p_source_text` today. This adds
-- one more bounded push beside it rather than a new credential path.
--
-- WHY THIS IS NOT A SECOND MAILBOX
--
-- At most five excerpts per artist/client relationship, each capped at 4000
-- characters, pruned on every insert. It holds recent client replies long
-- enough for a brief to be recomputed deterministically, and nothing else.
-- Retention is bounded by count rather than cleared after use because the
-- brief must stay rebuildable: clearing an excerpt after one refresh would
-- make the same recomputation produce a different answer.
--
-- The existing enquiry-AI observation path is not modified. Its narrow keyword
-- relevance gate is correct for deciding whether to draft a reply to an
-- enquiry, and wrong for client memory, where a reply on an already-linked
-- thread with a known client is relevant by construction.

create table crm_private.gmail_client_ai_excerpts (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  enquiry_id uuid references public.enquiries(id) on delete set null,
  provider_thread_id text not null check (provider_thread_id ~ '^[A-Za-z0-9_-]{4,255}$'),
  provider_message_id text not null check (provider_message_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  direction text not null check (direction in ('inbound', 'outbound')),
  subject text check (length(subject) <= 500),
  -- Bounded on the way in. A long forwarded thread is truncated rather than
  -- stored whole; the brief needs the reply, not the quoted history.
  body_excerpt text not null check (length(btrim(body_excerpt)) between 1 and 4000),
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (artist_id, client_id, provider_message_id)
);

-- Private schema, no RLS policy and no API grant: this is message content and
-- must never be reachable from a browser, a GPT action or an MCP tool. It is
-- read only by the SECURITY DEFINER context builder.
revoke all on crm_private.gmail_client_ai_excerpts
  from public, anon, authenticated, service_role;

comment on table crm_private.gmail_client_ai_excerpts is
  'Bounded recent Gmail excerpts for the client brief: at most five per artist/client, 4000 characters each, pruned on insert. Not a mailbox and not a timeline; the mailbox remains authoritative.';

create index gmail_client_ai_excerpts_client_idx
  on crm_private.gmail_client_ai_excerpts (artist_id, client_id, occurred_at desc);

create function public.service_record_gmail_client_message(
  p_artist_id uuid,
  p_client_id uuid,
  p_enquiry_id uuid,
  p_provider_thread_id text,
  p_provider_message_id text,
  p_direction text,
  p_subject text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_body text;
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  -- Off by default with the rest of the derived-state layer. A disabled agent
  -- stores no message content at all.
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  if p_provider_thread_id is null or p_provider_thread_id !~ '^[A-Za-z0-9_-]{4,255}$'
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9_-]{1,255}$'
     or p_direction is null or p_direction not in ('inbound', 'outbound')
     or (p_subject is not null and length(p_subject) > 998) then
    raise exception 'invalid Gmail excerpt' using errcode = '22023';
  end if;

  -- PostgreSQL text cannot hold a NUL, so there is nothing to strip there.
  -- Other control characters can arrive from a mail client and would be
  -- rendered into a Telegram message and a CRM screen; tab, newline and
  -- carriage return are ordinary in an email body and are kept.
  v_body := btrim(regexp_replace(
    coalesce(p_body, ''), E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', 'g'));
  if v_body = '' then
    return jsonb_build_object('status', 'ignored');
  end if;
  v_body := left(v_body, 4000);

  -- Scope is re-derived from the live rows. The Gmail Worker has already
  -- authorized its own read; this refuses independently, so a caller holding
  -- the service credential still cannot attach content to a client the artist
  -- has no CRM relationship with.
  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;

  -- An enquiry may be named, but only one that actually belongs to this pair.
  -- A mismatched id is dropped rather than stored, so a thread cannot be filed
  -- against another artist's enquiry.
  if p_enquiry_id is not null and not exists (
    select 1 from public.enquiries e
    where e.id = p_enquiry_id and e.artist_id = p_artist_id and e.client_id = p_client_id
  ) then
    p_enquiry_id := null;
  end if;

  insert into crm_private.gmail_client_ai_excerpts (
    artist_id, workspace_id, client_id, enquiry_id,
    provider_thread_id, provider_message_id, direction, subject, body_excerpt
  )
  values (
    p_artist_id, v_workspace, p_client_id, p_enquiry_id,
    p_provider_thread_id, p_provider_message_id, p_direction,
    nullif(left(btrim(coalesce(p_subject, '')), 500), ''), v_body
  )
  on conflict (artist_id, client_id, provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- The same provider message seen twice is not new information, and must
    -- not schedule a second refresh.
    return jsonb_build_object('status', 'existing');
  end if;

  -- Keep the newest five for this relationship. Pruning on insert is what
  -- makes the retention bound a property of the table rather than of a sweep
  -- job somebody has to remember to run.
  delete from crm_private.gmail_client_ai_excerpts x
  where x.artist_id = p_artist_id
    and x.client_id = p_client_id
    and x.id not in (
      select y.id from crm_private.gmail_client_ai_excerpts y
      where y.artist_id = p_artist_id and y.client_id = p_client_id
      order by y.occurred_at desc, y.id desc
      limit 5
    );

  perform crm_private.schedule_client_ai_refresh(
    p_artist_id, p_client_id, 'gmail:' || p_provider_message_id);

  return jsonb_build_object('status', 'recorded', 'excerpt_id', v_id);
end;
$$;

revoke all on function public.service_record_gmail_client_message(uuid,uuid,uuid,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.service_record_gmail_client_message(uuid,uuid,uuid,text,text,text,text,text)
  to service_role;

comment on function public.service_record_gmail_client_message(uuid,uuid,uuid,text,text,text,text,text) is
  'Records one bounded Gmail excerpt for the client brief and schedules the refresh that consumes it. Re-derives artist/client scope independently of the caller and stores at most five excerpts per relationship.';

-- ---------------------------------------------------------------------------
-- Wiring the excerpts into the derived state
--
-- Three functions are replaced. The watermark must change when a new excerpt
-- arrives, or a brief written before the reply would report itself fresh; the
-- context must carry the excerpt, which is the whole point; and the timeline
-- shows the excerpt in place of the bare subject line it used to show.
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
              'id', m.id, 'updated_at', m.updated_at, 'body', m.body
            ) order by m.id), '[]'::jsonb)
            from public.communication_messages m
            join public.communication_conversations v
              on v.id = m.conversation_id and v.artist_id = m.artist_id
            where v.client_id = p_client_id and m.artist_id = p_artist_id
          ),
          'emails', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.id, 'status', x.status, 'updated_at', x.updated_at
            ) order by x.id), '[]'::jsonb)
            from public.email_messages x
            where x.client_id = p_client_id and x.artist_id = p_artist_id
          ),
          'gmail', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', g.id, 'last_provider_message_id', g.last_provider_message_id,
              'updated_at', g.updated_at
            ) order by g.id), '[]'::jsonb)
            from crm_private.gmail_thread_contexts g
            where g.client_id = p_client_id and g.artist_id = p_artist_id
          ),
          -- What the client actually wrote. Hashing the excerpt, not just its
          -- id, means an edited or re-fetched body also invalidates the brief.
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
  'Digest of every authoritative fact a client brief may depend on, including bounded Gmail excerpts. Pinned to UTC so it is a property of the data rather than of the reader.';

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
         x.subject || case when x.status = 'draft' then ' (draft)' else '' end,
         coalesce(x.sent_at, x.created_at)
  from public.email_messages x
  where x.client_id = p_client_id and x.artist_id = p_artist_id

  -- Gmail excerpts carry what was written. They replace the bare subject line
  -- the thread-context branch used to contribute for the same message, which
  -- is why that branch now excludes any thread whose latest message is here.
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
  -- Internal notes are client-scoped and carry no artist column. Two artists
  -- in one workspace can share a client, so only notes bound to THIS artist's
  -- enquiry, project or session are included. A client-level note has no such
  -- binding and is excluded rather than guessed at.
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
