-- 20260910160000_crm_agent_client_ai.sql
--
-- Derived CRM AI state for one artist/client relationship.
--
-- WHAT THIS IS
--
-- Three derived-state tables and one durable job queue. Nothing here is a
-- source of truth. `enquiries`, `projects`, `sessions`, payments, `clients`,
-- `communication_messages` and `email_messages` stay authoritative for their
-- own domains; every row created here is a recomputable projection of them and
-- carries the watermark it was derived from, so a stale projection is
-- detectable rather than merely old.
--
-- WHAT THIS IS NOT
--
-- It is not a second message store. The unified timeline below is a UNION over
-- the tables that already own those rows, so linking a conversation or
-- archiving an enquiry changes the timeline immediately and no copy can drift.
--
-- It is not the generic automation engine (0081). That engine deliberately
-- refuses free text and personal data in its action payloads, and reusing it
-- here would mean widening exactly the boundary it exists to hold. This queue
-- is narrow instead: four job types, identifiers only, and every prompt input
-- recomputed server-side at claim time from the real rows.
--
-- AUTHORITY
--
-- The model proposes; it never decides. `approval_required` is a generated
-- column, so a model that returns `false` for a deposit request still produces
-- an approval-gated row. Draft text is permitted only for the action types
-- that cannot commit money, a date or a booking, and is re-validated in SQL
-- against the same reply-safety rule the enquiry intake path uses.
--
-- Clients are workspace data but are not artist-owned rows, so authorization
-- is never inferred from `clients` alone: every entry point re-derives scope
-- from an artist -> enquiry -> client or artist -> conversation -> client
-- relationship the CRM already records.

-- ---------------------------------------------------------------------------
-- 1. Operational switch
--
-- Off by default, exactly like `enquiry_ai_config`. Vision has its own switch
-- because reading a private Storage object is a strictly larger capability
-- than reading rows the CRM already holds.
-- ---------------------------------------------------------------------------

create table crm_private.crm_agent_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  vision_enabled boolean not null default false
);
insert into crm_private.crm_agent_config default values;
revoke all on crm_private.crm_agent_config from public, anon, authenticated;
grant select, update on crm_private.crm_agent_config to service_role;

comment on table crm_private.crm_agent_config is
  'Private runtime switch for derived CRM AI state. Deployment enables it; no browser, GPT action or MCP tool can read or change it.';

-- ---------------------------------------------------------------------------
-- 2. Scope
--
-- The one place that answers "may this artist reason about this client?".
-- Returns the workspace when a real CRM relationship exists and NULL
-- otherwise, so every caller fails closed by checking for NULL.
-- ---------------------------------------------------------------------------

create function crm_private.client_ai_scope(p_artist_id uuid, p_client_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.workspace_id
  from public.artists a
  join public.clients c
    on c.id = p_client_id
   and c.workspace_id = a.workspace_id
   and c.archived_at is null
  where a.id = p_artist_id
    and a.is_active
    and a.workspace_id is not null
    -- Membership of the same workspace is not by itself a relationship. The
    -- artist must already hold a record that names this client.
    and (
      exists (
        select 1 from public.enquiries e
        where e.client_id = c.id and e.artist_id = a.id and e.archived_at is null
      )
      or exists (
        select 1 from public.communication_conversations v
        where v.client_id = c.id and v.artist_id = a.id
      )
    );
$$;

revoke all on function crm_private.client_ai_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_ai_scope(uuid, uuid) is
  'Workspace for an artist/client pair that the CRM already relates, or NULL. Never infers access from the clients row alone.';

-- ---------------------------------------------------------------------------
-- 3. Output validation
--
-- Fail-closed structural validation of everything a model returns, in the
-- database, so a Worker bug cannot persist a shape the CRM never agreed to.
-- The Worker validates the same contract first; this is the boundary that
-- actually holds.
-- ---------------------------------------------------------------------------

-- Control characters are rejected here rather than escaped downstream: a brief
-- is rendered into a Telegram message and a CRM screen, and neither should
-- have to defend itself against a model-supplied terminal sequence.
create function crm_private.crm_agent_text(p_value jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_typeof(p_value) = 'string'
     and length(btrim(p_value #>> '{}')) between 1 and p_max
     and (p_value #>> '{}') !~ E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]';
$$;

create function crm_private.crm_agent_string_array(p_value jsonb, p_max_items integer, p_max_chars integer)
returns boolean
language sql
immutable
set search_path = pg_catalog, crm_private
as $$
  select jsonb_typeof(p_value) = 'array'
     and jsonb_array_length(p_value) <= p_max_items
     and not exists (
       select 1 from jsonb_array_elements(p_value) x
       where not crm_private.crm_agent_text(x.value, p_max_chars)
     );
$$;

-- A "discussed" entry records that a number or a date was MENTIONED and by
-- whom. It is never an approval, and `status` has no value meaning "agreed":
-- agreement lives in projects/sessions/payments and is overlaid on read.
create function crm_private.crm_agent_discussed(p_value jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, crm_private
as $$
  select jsonb_typeof(p_value) = 'object'
     and (p_value ?& array['value','status'])
     and (p_value - array['value','status']) = '{}'::jsonb
     and (p_value->>'status') in ('mentioned_by_client','mentioned_by_artist','not_discussed')
     and (
       case when p_value->>'status' = 'not_discussed'
         then p_value->'value' = 'null'::jsonb
         else crm_private.crm_agent_text(p_value->'value', 200)
       end
     );
$$;

create function crm_private.validate_client_ai_brief(p_brief jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, crm_private
as $$
declare
  v_top constant text[] := array[
    'project_summary','stage','placement','style','colour','size',
    'cover_up_context','constraints','decisions_made','open_questions',
    'promises_to_client','waiting_on','last_interaction','discussed'
  ];
  v_discussed constant text[] := array[
    'session_estimate','price','deposit','candidate_dates','confirmed_dates'
  ];
  v_key text;
begin
  if p_brief is null or jsonb_typeof(p_brief) <> 'object'
    or not (p_brief ?& v_top)
    or (p_brief - v_top) <> '{}'::jsonb
    or coalesce(p_brief->>'stage','') not in (
      'new_enquiry','gathering_information','awaiting_artist_review',
      'quote_discussion','scheduling','deposit_pending','booked','aftercare','dormant')
    or coalesce(p_brief->>'waiting_on','') not in ('client','artist','nobody')
    or not crm_private.crm_agent_string_array(p_brief->'constraints', 10, 300)
    or not crm_private.crm_agent_string_array(p_brief->'decisions_made', 10, 300)
    or not crm_private.crm_agent_string_array(p_brief->'open_questions', 10, 300)
    or not crm_private.crm_agent_string_array(p_brief->'promises_to_client', 10, 300)
    or jsonb_typeof(p_brief->'discussed') <> 'object'
    or not ((p_brief->'discussed') ?& v_discussed)
    or ((p_brief->'discussed') - v_discussed) <> '{}'::jsonb
  then
    return false;
  end if;

  -- Free-text descriptors are nullable; where present they are bounded.
  foreach v_key in array array['project_summary','placement','style','colour','size','cover_up_context','last_interaction'] loop
    if p_brief->v_key <> 'null'::jsonb
      and not crm_private.crm_agent_text(
        p_brief->v_key,
        case when v_key in ('project_summary','last_interaction') then 1200 else 300 end)
    then
      return false;
    end if;
  end loop;

  foreach v_key in array v_discussed loop
    if not crm_private.crm_agent_discussed(p_brief->'discussed'->v_key) then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

-- Only these action types may ever be persisted. Anything else, including a
-- plausible-looking new verb, is rejected rather than stored and interpreted
-- later.
create function crm_private.crm_agent_action_types()
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select array[
    'request_information','artist_review','prepare_quote','offer_dates',
    'request_deposit','confirm_booking','follow_up','await_client','no_action'
  ]::text[];
$$;

-- The action types whose draft could commit money, availability or a booking
-- are absent here on purpose: they never carry model-written client text.
create function crm_private.crm_agent_draftable_action_types()
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select array['request_information','follow_up','artist_review']::text[];
$$;

-- The same reply-safety rule the enquiry intake path applies. Kept as one
-- expression so the two boundaries cannot drift apart.
create function crm_private.crm_agent_draft_is_safe(p_draft text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_draft is not null
     and length(btrim(p_draft)) between 1 and 2000
     and p_draft !~ E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'
     and p_draft !~* '(https?://|www\.|[£$€][[:space:]]*[0-9]|[0-9][[:space:]]*(gbp|usd|eur|pounds?|dollars?|euros?)\y|\y(confirmed|booked|guaranteed|available on|reserve|reserved|price is|costs?[[:space:]]+[0-9]|(will|would|should|takes?)[[:space:]]+[0-9]+[[:space:]]+sessions?|pay(ment)?[[:space:]]+(now|here|to)|send[[:space:]]+(a[[:space:]]+)?deposit|deposit[[:space:]]+(is|of|required)|ignore[[:space:]]+(previous|all)|system prompt)\y)';
$$;

create function crm_private.validate_client_ai_next_action(p_action jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, crm_private
as $$
declare
  v_keys constant text[] := array['action_type','reason','priority','draft_reply','missing_information'];
begin
  if p_action is null or jsonb_typeof(p_action) <> 'object'
    or not (p_action ?& v_keys)
    or (p_action - v_keys) <> '{}'::jsonb
    or not (coalesce(p_action->>'action_type','') = any (crm_private.crm_agent_action_types()))
    or coalesce(p_action->>'priority','') not in ('low','normal','high')
    or not crm_private.crm_agent_text(p_action->'reason', 600)
    or not crm_private.crm_agent_string_array(p_action->'missing_information', 12, 120)
  then
    return false;
  end if;

  if p_action->'draft_reply' = 'null'::jsonb then
    return true;
  end if;

  -- A draft is optional, but where one exists it must be safe text AND belong
  -- to an action type that cannot commit a price, a date or a booking.
  return jsonb_typeof(p_action->'draft_reply') = 'string'
     and crm_private.crm_agent_draft_is_safe(p_action->>'draft_reply')
     and (p_action->>'action_type') = any (crm_private.crm_agent_draftable_action_types());
end;
$$;

-- Reference-image analysis is descriptive only. There is no field in which a
-- model could return a cover-up verdict, a skin assessment or a feasibility
-- decision, because no such field exists in the contract.
create function crm_private.validate_reference_image_analysis(p_analysis jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, crm_private
as $$
declare
  v_keys constant text[] := array[
    'image_kind','existing_tattoo_visible','body_area','subjects',
    'composition','palette','quality_limitations','summary'
  ];
begin
  return p_analysis is not null
     and jsonb_typeof(p_analysis) = 'object'
     and (p_analysis ?& v_keys)
     and (p_analysis - v_keys) = '{}'::jsonb
     and coalesce(p_analysis->>'image_kind','') in
       ('photograph_of_skin','reference_artwork','existing_tattoo','other','unclear')
     and (p_analysis->'existing_tattoo_visible') in ('true'::jsonb,'false'::jsonb,'null'::jsonb)
     and (p_analysis->'body_area' = 'null'::jsonb or crm_private.crm_agent_text(p_analysis->'body_area', 120))
     and (p_analysis->'composition' = 'null'::jsonb or crm_private.crm_agent_text(p_analysis->'composition', 300))
     and (p_analysis->'palette' = 'null'::jsonb or crm_private.crm_agent_text(p_analysis->'palette', 200))
     and crm_private.crm_agent_string_array(p_analysis->'subjects', 10, 120)
     and crm_private.crm_agent_string_array(p_analysis->'quality_limitations', 6, 200)
     and crm_private.crm_agent_text(p_analysis->'summary', 800);
end;
$$;

revoke all on function
  crm_private.crm_agent_text(jsonb,integer),
  crm_private.crm_agent_string_array(jsonb,integer,integer),
  crm_private.crm_agent_discussed(jsonb),
  crm_private.crm_agent_action_types(),
  crm_private.crm_agent_draftable_action_types(),
  crm_private.crm_agent_draft_is_safe(text),
  crm_private.validate_client_ai_brief(jsonb),
  crm_private.validate_client_ai_next_action(jsonb),
  crm_private.validate_reference_image_analysis(jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Derived state
--
-- All three tables are private by default: no API role holds a grant, RLS is
-- enabled and forced, and reads happen through the bounded RPCs in section 8.
-- Exposing them through the Data API would publish free-text client context to
-- every authenticated browser session in the project.
-- ---------------------------------------------------------------------------

create table public.client_ai_state (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  summary text not null check (length(btrim(summary)) between 1 and 2000),
  brief jsonb not null check (crm_private.validate_client_ai_brief(brief)),
  missing_information jsonb not null default '[]'::jsonb
    check (crm_private.crm_agent_string_array(missing_information, 12, 120)),
  -- The watermark this brief was derived from. Comparing it to a freshly
  -- computed one is how a reader knows whether the CRM has moved on.
  source_watermark text not null check (source_watermark ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('qwen','workers_ai','openai','deepseek')),
  model text not null check (length(model) between 1 and 160),
  refreshed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (artist_id, client_id)
);

comment on table public.client_ai_state is
  'One derived AI brief per artist/client relationship. Recomputable from authoritative CRM rows; never a source of truth for bookings, dates or money.';
comment on column public.client_ai_state.brief is
  'Structured, schema-validated context. Its "discussed" values record what was said, not what was agreed; agreement is read from projects/sessions/payments.';

create index client_ai_state_artist_idx
  on public.client_ai_state (artist_id, refreshed_at desc);

create table public.client_ai_next_actions (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  client_ai_state_id uuid not null references public.client_ai_state(id) on delete cascade,
  action_type text not null check (action_type = any (crm_private.crm_agent_action_types())),
  reason text not null check (length(btrim(reason)) between 1 and 600),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  -- Generated, not supplied. A model that claims a deposit request needs no
  -- approval still produces an approval-gated row.
  approval_required boolean not null
    generated always as (action_type not in ('no_action','await_client')) stored,
  draft_reply text,
  missing_information jsonb not null default '[]'::jsonb
    check (crm_private.crm_agent_string_array(missing_information, 12, 120)),
  status text not null default 'open'
    check (status in ('open','superseded','dismissed','actioned')),
  source_watermark text not null check (source_watermark ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('qwen','workers_ai','openai','deepseek')),
  model text not null check (length(model) between 1 and 160),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- Draft text is allowed only where it cannot commit money, availability or a
  -- booking, and only when it survives the shared reply-safety rule.
  constraint client_ai_next_actions_draft_scope check (
    draft_reply is null
    or (action_type = any (crm_private.crm_agent_draftable_action_types())
        and crm_private.crm_agent_draft_is_safe(draft_reply))
  ),
  -- One recommendation per artist/client/watermark. A repeated refresh over
  -- unchanged source data conflicts here instead of producing a duplicate.
  unique (artist_id, client_id, source_watermark)
);

comment on table public.client_ai_next_actions is
  'Append-only AI recommendations. Persisting one performs no business action: it never sends a message, books a date, quotes a price or records a payment.';
comment on column public.client_ai_next_actions.approval_required is
  'Generated from action_type. The model cannot lower it, so an approval gate cannot be talked away by model output.';

-- At most one open recommendation per relationship: a new one supersedes the
-- previous, so the digest never shows two competing "next" steps.
create unique index client_ai_next_actions_one_open_idx
  on public.client_ai_next_actions (artist_id, client_id)
  where status = 'open';

create index client_ai_next_actions_artist_open_idx
  on public.client_ai_next_actions (artist_id, priority, created_at desc)
  where status = 'open';

create table public.enquiry_file_ai_analysis (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  enquiry_file_id uuid not null references public.enquiry_files(id) on delete cascade,
  -- The object checksum at analysis time. A re-uploaded object under the same
  -- id produces a different digest, which invalidates this row.
  source_checksum text check (source_checksum ~ '^[a-f0-9]{64}$'),
  analysis jsonb not null check (crm_private.validate_reference_image_analysis(analysis)),
  summary text not null check (length(btrim(summary)) between 1 and 800),
  provider text not null check (provider in ('qwen','workers_ai','openai','deepseek')),
  model text not null check (length(model) between 1 and 160),
  analyzed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (enquiry_file_id),
  foreign key (enquiry_id, artist_id) references public.enquiries(id, artist_id) on delete cascade
);

comment on table public.enquiry_file_ai_analysis is
  'Structured description of one private reference image. Descriptive only: the contract has no field for a cover-up verdict, a skin assessment or a feasibility decision.';

create index enquiry_file_ai_analysis_enquiry_idx
  on public.enquiry_file_ai_analysis (enquiry_id, analyzed_at desc);

-- ---------------------------------------------------------------------------
-- 5. Durable job queue
--
-- The established lease shape: explicit status, bounded attempts, an
-- availability time, a lease token with an expiry, a snapshot hash and a
-- dedupe key. Payloads carry identifiers only; the prompt input is rebuilt
-- from the real rows at claim time, so a job row is never a copy of client
-- data and cannot be replayed into a different scope.
-- ---------------------------------------------------------------------------

create table public.crm_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  job_type text not null check (job_type in ('refresh_client_ai_state','analyze_reference_image')),
  enquiry_id uuid references public.enquiries(id) on delete cascade,
  enquiry_file_id uuid references public.enquiry_files(id) on delete cascade,
  -- Bounded, non-personal. A conversation/message/enquiry id or a watermark.
  source_event_id text not null check (source_event_id ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  status text not null default 'pending'
    check (status in ('pending','processing','succeeded','failed','stale')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  snapshot_hash text check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  error_code text check (error_code in (
    'input_invalid','ai_unavailable','output_invalid','processing_failed',
    'stale_input','lease_expired','scope_changed','image_unavailable','image_unsupported')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (artist_id, job_type, source_event_id),
  constraint crm_agent_jobs_image_target check (
    (job_type = 'analyze_reference_image') = (enquiry_file_id is not null)
  ),
  constraint crm_agent_jobs_image_enquiry check (
    job_type <> 'analyze_reference_image' or enquiry_id is not null
  )
);

comment on table public.crm_agent_jobs is
  'Narrow durable queue for derived CRM AI work. Deliberately not the generic automation engine, whose payload contract excludes personal and free-text data by design.';
comment on column public.crm_agent_jobs.source_event_id is
  'Dedupe identity for one triggering event. Identifiers only; never message text, an email address or any other personal value.';

create index crm_agent_jobs_drain_idx
  on public.crm_agent_jobs (available_at, created_at)
  where status in ('pending','processing');

create index crm_agent_jobs_client_idx
  on public.crm_agent_jobs (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Access
--
-- No API role holds a table grant. `service_role` reaches these tables through
-- the SECURITY DEFINER functions below; `authenticated` reaches them only
-- through the bounded artist reads. RLS is enabled and forced on all four so
-- the security suite's blanket assertion continues to hold.
-- ---------------------------------------------------------------------------

alter table public.client_ai_state enable row level security;
alter table public.client_ai_state force row level security;
alter table public.client_ai_next_actions enable row level security;
alter table public.client_ai_next_actions force row level security;
alter table public.enquiry_file_ai_analysis enable row level security;
alter table public.enquiry_file_ai_analysis force row level security;
alter table public.crm_agent_jobs enable row level security;
alter table public.crm_agent_jobs force row level security;

revoke all on public.client_ai_state from public, anon, authenticated, service_role;
revoke all on public.client_ai_next_actions from public, anon, authenticated, service_role;
revoke all on public.enquiry_file_ai_analysis from public, anon, authenticated, service_role;
revoke all on public.crm_agent_jobs from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Watermark
--
-- One digest over everything a brief is allowed to depend on. It answers
-- "has the source data changed since this was generated?" without keeping a
-- copy of the source data, and it is what makes a recomputation deterministic
-- and a stale write detectable.
-- ---------------------------------------------------------------------------

-- TimeZone is pinned because to_jsonb() renders a timestamptz in the SESSION
-- time zone. Without this, a Worker running in UTC and a browser session in
-- Europe/London compute DIFFERENT digests for identical data, every brief
-- reports itself stale to somebody, and every refresh is immediately
-- invalidated by the next reader. The digest has to be a property of the data
-- alone.
create function crm_private.client_ai_watermark(p_artist_id uuid, p_client_id uuid)
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
          -- Enquiry CONTENT, not just its timestamps. A watermark built from
          -- updated_at would trust every writer to bump it; hashing the fields
          -- the context projection actually exposes makes staleness a property
          -- of the data rather than of a trigger someone might forget.
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
              'updated_at', p.updated_at
            ) order by p.id), '[]'::jsonb)
            from public.projects p
            where p.client_id = p_client_id and p.artist_id = p_artist_id
          ),
          'sessions', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', s.id, 'status', s.status, 'start_at', s.start_at,
              'payment_status', s.payment_status, 'updated_at', s.updated_at
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

revoke all on function crm_private.client_ai_watermark(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_ai_watermark(uuid, uuid) is
  'Digest of every authoritative fact a client brief may depend on. Changing any of them changes the watermark, which invalidates derived state without storing a copy of it.';

-- ---------------------------------------------------------------------------
-- 8. Scheduling
--
-- Every scheduler recomputes scope from the real rows, so a caller that knows
-- a client id but holds no relationship with that client schedules nothing.
-- A disabled switch is a silent no-op rather than an error: enqueue failures
-- must never surface in an enquiry or a webhook path.
-- ---------------------------------------------------------------------------

create function crm_private.schedule_client_ai_refresh(
  p_artist_id uuid,
  p_client_id uuid,
  p_source_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace uuid;
  v_id uuid;
begin
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return null;
  end if;
  if p_source_event_id is null or p_source_event_id !~ '^[A-Za-z0-9_:.-]{1,255}$' then
    return null;
  end if;

  v_workspace := crm_private.client_ai_scope(p_artist_id, p_client_id);
  if v_workspace is null then
    return null;
  end if;

  insert into public.crm_agent_jobs (
    artist_id, workspace_id, client_id, job_type, source_event_id
  )
  values (p_artist_id, v_workspace, p_client_id, 'refresh_client_ai_state', p_source_event_id)
  on conflict (artist_id, job_type, source_event_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

create function crm_private.schedule_reference_image_analysis(p_enquiry_file_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_file public.enquiry_files%rowtype;
  v_artist uuid;
  v_client uuid;
  v_workspace uuid;
  v_id uuid;
begin
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false)
     or not coalesce((select vision_enabled from crm_private.crm_agent_config where singleton), false) then
    return null;
  end if;

  select f.* into v_file from public.enquiry_files f where f.id = p_enquiry_file_id;
  if not found or v_file.upload_state <> 'ready' then
    return null;
  end if;
  -- The router accepts these three types and nothing else. An unsupported file
  -- is never queued, so it cannot consume an attempt to discover that.
  if v_file.mime_type not in ('image/jpeg','image/png','image/webp') then
    return null;
  end if;

  select e.artist_id, e.client_id into v_artist, v_client
  from public.enquiries e
  where e.id = v_file.enquiry_id and e.archived_at is null;
  if not found then
    return null;
  end if;

  v_workspace := crm_private.client_ai_scope(v_artist, v_client);
  if v_workspace is null then
    return null;
  end if;

  insert into public.crm_agent_jobs (
    artist_id, workspace_id, client_id, job_type, enquiry_id, enquiry_file_id, source_event_id
  )
  values (v_artist, v_workspace, v_client, 'analyze_reference_image',
          v_file.enquiry_id, v_file.id, v_file.id::text)
  on conflict (artist_id, job_type, source_event_id) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function
  crm_private.schedule_client_ai_refresh(uuid,uuid,text),
  crm_private.schedule_reference_image_analysis(uuid)
  from public, anon, authenticated, service_role;

-- Backend entry point, for paths that already run in a Worker (an inbound
-- Gmail observation, a communications drain) rather than in a trigger.
create function public.service_schedule_client_ai_refresh(
  p_artist_id uuid,
  p_client_id uuid,
  p_source_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  v_id := crm_private.schedule_client_ai_refresh(p_artist_id, p_client_id, p_source_event_id);
  return jsonb_build_object('status', case when v_id is null then 'ignored' else 'queued' end, 'job_id', v_id);
end;
$$;

revoke all on function public.service_schedule_client_ai_refresh(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.service_schedule_client_ai_refresh(uuid,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Unified client timeline
--
-- A projection, not a copy. Each branch reads the table that already owns
-- those rows, so linking a conversation, archiving an enquiry or deleting a
-- note is reflected on the next read and no second store can drift out of
-- agreement with the first.
--
-- Gmail is present as thread metadata only. Message bodies are not stored in
-- the CRM; the Gmail Worker reads them from the mailbox under its own bounded
-- contract, and inventing a body column here would quietly turn this into the
-- second message store the design refuses to build.
-- ---------------------------------------------------------------------------

create function crm_private.client_timeline_items(p_artist_id uuid, p_client_id uuid)
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

  union all
  select 'gmail_thread'::text, g.id, null::text, g.subject, g.updated_at
  from crm_private.gmail_thread_contexts g
  where g.client_id = p_client_id and g.artist_id = p_artist_id

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

revoke all on function crm_private.client_timeline_items(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_timeline_items(uuid,uuid) is
  'Union projection over the tables that already own each item. Creates no second message timeline and stores nothing.';

-- ---------------------------------------------------------------------------
-- 10. Bounded context
--
-- What the model is allowed to see. Explicitly projected and explicitly
-- capped: the newest 20 timeline items, the open CRM facts, and any persisted
-- image summaries. A client with three years of history produces the same
-- bounded payload as a client with three messages, and the derived brief is
-- what carries the rest forward.
-- ---------------------------------------------------------------------------

-- Pinned to UTC for the same reason as the watermark: a prompt context that
-- renders differently per session is not reproducible, and neither is a bug
-- report about one.
create function crm_private.client_ai_context(p_artist_id uuid, p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
set "TimeZone" = 'UTC'
as $$
  select jsonb_build_object(
    'client', jsonb_build_object(
      'full_name', c.full_name,
      'preferred_contact', c.preferred_contact
    ),
    'artist', jsonb_build_object(
      'display_name', a.display_name,
      'timezone', a.timezone
    ),
    'enquiries', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'reference', e.reference_number, 'status', e.status,
          'project_type', left(e.project_type, 200), 'placement', left(e.placement, 200),
          'approximate_size', left(e.approximate_size, 200), 'cover_up', left(e.cover_up, 200),
          'preferred_timing', left(e.preferred_timing, 200), 'idea', left(e.idea, 2000),
          'created_at', e.created_at
        ) as item,
        -- Ordered by the timestamp itself, never by its rendered text.
        row_number() over (order by e.created_at desc, e.id desc) as rank
        from public.enquiries e
        where e.client_id = p_client_id and e.artist_id = p_artist_id and e.archived_at is null
        order by e.created_at desc, e.id desc
        limit 5
      ) s
    ),
    -- Authoritative money/date/booking facts. The prompt is told these are the
    -- only ones that count, and the read RPC overlays them again afterwards.
    'crm_facts', jsonb_build_object(
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', p.status, 'deposit_status', p.deposit_status,
          'estimated_sessions', p.estimated_sessions,
          'estimate_total', p.estimate_total, 'currency', p.currency
        ) order by p.created_at desc), '[]'::jsonb)
        from public.projects p
        where p.client_id = p_client_id and p.artist_id = p_artist_id and p.archived_at is null
      ),
      'sessions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', s.status, 'start_at', s.start_at, 'end_at', s.end_at,
          'payment_status', s.payment_status
        ) order by s.start_at desc), '[]'::jsonb)
        from public.sessions s
        where s.client_id = p_client_id and s.artist_id = p_artist_id
          and s.start_at > clock_timestamp() - interval '180 days'
      )
    ),
    'timeline', (
      select coalesce(jsonb_agg(s.item order by s.rank), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'source', u.source, 'direction', u.direction,
          'text', left(u.body, 1000), 'occurred_at', u.occurred_at
        ) as item,
        row_number() over (order by u.occurred_at desc, u.source_id desc) as rank
        from crm_private.client_timeline_items(p_artist_id, p_client_id) u
        order by u.occurred_at desc, u.source_id desc
        limit 20
      ) s
    ),
    'reference_images', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'summary', f.summary, 'analysis', f.analysis
      ) order by f.analyzed_at desc, f.id desc), '[]'::jsonb)
      from public.enquiry_file_ai_analysis f
      where f.client_id = p_client_id and f.artist_id = p_artist_id
    ),
    'previous_brief', (
      select jsonb_build_object('summary', st.summary, 'brief', st.brief)
      from public.client_ai_state st
      where st.artist_id = p_artist_id and st.client_id = p_client_id
    )
  )
  from public.clients c
  join public.artists a on a.id = p_artist_id
  where c.id = p_client_id
    and crm_private.client_ai_scope(p_artist_id, p_client_id) is not null;
$$;

revoke all on function crm_private.client_ai_context(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.client_ai_context(uuid,uuid) is
  'Explicit bounded projection for one model call. Caps enquiries at 5 and timeline items at 20; carries no identifiers, lease tokens or storage paths into a prompt.';

-- ---------------------------------------------------------------------------
-- 11. Lease cycle
--
-- Claim, complete, fail. The rules are the ones the enquiry AI queue already
-- proved: one in-flight job per client, an expiring lease, bounded attempts,
-- a snapshot taken at claim time and re-checked at completion, and a scope
-- re-derivation on both ends so a job whose relationship disappeared between
-- claim and completion is failed rather than applied.
-- ---------------------------------------------------------------------------

create function public.service_claim_crm_agent_jobs(p_limit integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_hash text;
  v_token uuid;
  v_payload jsonb;
  v_file public.enquiry_files%rowtype;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return v_out;
  end if;

  -- A lease that expired after the last attempt is a terminal failure, not an
  -- infinite retry. Recovering it here keeps a crashed Worker from parking a
  -- client's queue forever.
  update public.crm_agent_jobs
  set status = 'failed', error_code = 'lease_expired',
      lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where status = 'processing' and lease_until < clock_timestamp() and attempts >= 3;

  for v_job in
    select j.*
    from public.crm_agent_jobs j
    where j.attempts < 3
      and (
        (j.status = 'pending' and j.available_at <= clock_timestamp())
        or (j.status = 'processing' and j.lease_until < clock_timestamp())
      )
      -- One in-flight job per client. Two concurrent refreshes would race on
      -- the same derived row and the loser's work would be discarded anyway.
      and not exists (
        select 1 from public.crm_agent_jobs busy
        where busy.client_id = j.client_id and busy.artist_id = j.artist_id
          and busy.id <> j.id and busy.status = 'processing'
          and busy.lease_until >= clock_timestamp()
      )
    -- Newest first. Several events can queue several refreshes for one client
    -- before the drain runs, and only the newest describes the CRM as it is;
    -- claiming the oldest would guarantee a stale answer and pay a provider
    -- for it.
    order by j.created_at desc
    for update skip locked
  loop
    exit when jsonb_array_length(v_out) >= greatest(1, least(coalesce(p_limit, 1), 5));

    -- Advisory lock as well as SKIP LOCKED: two Workers scanning at once can
    -- each hold a different row for the same client.
    if not pg_try_advisory_xact_lock(hashtextextended('crm-agent:' || v_job.artist_id::text || ':' || v_job.client_id::text, 0)) then
      continue;
    end if;
    if exists (
      select 1 from public.crm_agent_jobs busy
      where busy.client_id = v_job.client_id and busy.artist_id = v_job.artist_id
        and busy.id <> v_job.id and busy.status = 'processing'
        and busy.lease_until >= clock_timestamp()
    ) then
      continue;
    end if;

    -- Scope is recomputed from the live rows, never trusted from the job.
    if crm_private.client_ai_scope(v_job.artist_id, v_job.client_id) is distinct from v_job.workspace_id then
      update public.crm_agent_jobs
      set status = 'failed', error_code = 'scope_changed',
          lease_token = null, lease_until = null, updated_at = clock_timestamp()
      where id = v_job.id;
      continue;
    end if;

    v_hash := crm_private.client_ai_watermark(v_job.artist_id, v_job.client_id);

    if v_job.job_type = 'refresh_client_ai_state' then
      v_payload := crm_private.client_ai_context(v_job.artist_id, v_job.client_id);
    else
      if not coalesce((select vision_enabled from crm_private.crm_agent_config where singleton), false) then
        continue;
      end if;
      select f.* into v_file
      from public.enquiry_files f
      join public.enquiries e on e.id = f.enquiry_id and e.artist_id = v_job.artist_id
        and e.client_id = v_job.client_id and e.archived_at is null
      where f.id = v_job.enquiry_file_id and f.upload_state = 'ready';
      if not found then
        -- A deleted, unfinished or re-scoped object is a terminal outcome for
        -- this job: retrying cannot make the object reappear.
        update public.crm_agent_jobs
        set status = 'failed', error_code = 'image_unavailable',
            lease_token = null, lease_until = null, updated_at = clock_timestamp()
        where id = v_job.id;
        continue;
      end if;
      -- The Worker receives the object KEY, never a URL and never a signed
      -- link. Signing happens inside the Worker against the private bucket.
      v_payload := jsonb_build_object(
        'storage_path', v_file.storage_path,
        'mime_type', v_file.mime_type,
        'byte_size', v_file.byte_size,
        'checksum', v_file.checksum
      );
    end if;

    if v_hash is null or v_payload is null then
      update public.crm_agent_jobs
      set status = 'failed', error_code = 'scope_changed',
          lease_token = null, lease_until = null, updated_at = clock_timestamp()
      where id = v_job.id;
      continue;
    end if;

    v_token := gen_random_uuid();
    update public.crm_agent_jobs
    set status = 'processing', attempts = attempts + 1,
        lease_token = v_token, lease_until = clock_timestamp() + interval '5 minutes',
        snapshot_hash = v_hash, error_code = null, updated_at = clock_timestamp()
    where id = v_job.id;

    -- Collapse the backlog this job supersedes. Three events in a minute are
    -- one refresh, not three: the older ones would each recompute the same
    -- watermark and be discarded as stale after paying for a model call.
    if v_job.job_type = 'refresh_client_ai_state' then
      update public.crm_agent_jobs older
      set status = 'stale', error_code = 'stale_input',
          lease_token = null, lease_until = null, updated_at = clock_timestamp()
      where older.artist_id = v_job.artist_id
        and older.client_id = v_job.client_id
        and older.job_type = v_job.job_type
        and older.status = 'pending'
        and older.created_at < v_job.created_at;
    end if;

    v_out := v_out || jsonb_build_object(
      'job_id', v_job.id,
      'lease_token', v_token,
      'job_type', v_job.job_type,
      'artist_id', v_job.artist_id,
      'client_id', v_job.client_id,
      'workspace_id', v_job.workspace_id,
      'enquiry_id', v_job.enquiry_id,
      'enquiry_file_id', v_job.enquiry_file_id,
      'input', v_payload
    );
  end loop;

  return v_out;
end;
$$;

create function public.service_fail_crm_agent_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_status text;
  v_code text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  -- An unrecognised code becomes the generic one rather than being stored: the
  -- column is a closed vocabulary and a Worker must not widen it.
  v_code := case
    when p_error_code in ('input_invalid','ai_unavailable','output_invalid',
                          'processing_failed','image_unavailable','image_unsupported')
      then p_error_code
    else 'processing_failed'
  end;

  select j.* into v_job from public.crm_agent_jobs j where j.id = p_job_id for update;
  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  -- Two of these codes describe the object, not the call, so retrying is
  -- pointless and the job ends now.
  v_status := case
    when v_code in ('image_unavailable','image_unsupported') then 'failed'
    when v_job.attempts < 3 then 'pending'
    else 'failed'
  end;

  update public.crm_agent_jobs
  set status = v_status, error_code = v_code,
      available_at = clock_timestamp() + interval '5 minutes',
      lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where id = v_job.id;

  return jsonb_build_object('status', v_status, 'error_code', v_code);
end;
$$;

revoke all on function
  public.service_claim_crm_agent_jobs(integer),
  public.service_fail_crm_agent_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function
  public.service_claim_crm_agent_jobs(integer),
  public.service_fail_crm_agent_job(uuid,uuid,text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 12. Artist notification
--
-- One deduplicated `notifications` row per recommendation, using the same
-- recipient predicate the enquiry path uses. There is no second Telegram
-- queue: the existing connector leases from `notifications` and delivers.
--
-- Delivery is a presentation of CRM state. A Telegram outage leaves the
-- recommendation intact and readable through the digest, and the artist loses
-- a push, not a decision.
-- ---------------------------------------------------------------------------

create function crm_private.enqueue_client_ai_notification(p_next_action_id uuid)
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

  -- The body is CRM-authored around a bounded model-written reason. No draft
  -- reply, no price, no date and no storage path crosses into a push message.
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
  on conflict (dedupe_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function crm_private.enqueue_client_ai_notification(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.enqueue_client_ai_notification(uuid) is
  'One notification per recommendation per recipient. The dedupe key carries the recommendation id, so re-running a refresh over unchanged data announces nothing twice.';

-- ---------------------------------------------------------------------------
-- 13. Applying a result
--
-- The completion path is where the safety story either holds or does not, so
-- it does four things in one transaction and refuses if any of them fails:
-- re-validate the model output, re-derive the scope, compare the watermark
-- taken at claim time against the live one, and only then write.
--
-- Writing means: replace the current brief, supersede the previous open
-- recommendation, insert the new one, and enqueue exactly one deduplicated
-- artist notification. No message is sent, no date is held, no money is
-- requested and no booking state is touched.
-- ---------------------------------------------------------------------------

create function public.service_complete_client_ai_state_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_summary text,
  p_brief jsonb,
  p_next_action jsonb,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_state public.client_ai_state%rowtype;
  v_action public.client_ai_next_actions%rowtype;
  v_draft text;
  v_notifications integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  if p_provider is null or p_provider not in ('qwen','workers_ai','openai','deepseek')
     or p_model is null or length(p_model) not between 1 and 160
     or p_model !~ '^[@a-zA-Z0-9/_.:-]+$'
     or p_summary is null or length(btrim(p_summary)) not between 1 and 2000
     or p_summary ~ E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'
     or not crm_private.validate_client_ai_brief(p_brief)
     or not crm_private.validate_client_ai_next_action(p_next_action) then
    raise exception 'invalid structured AI result' using errcode = '22023';
  end if;

  select j.* into v_job from public.crm_agent_jobs j where j.id = p_job_id for update;
  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp()
     or v_job.job_type <> 'refresh_client_ai_state' then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  if crm_private.client_ai_scope(v_job.artist_id, v_job.client_id) is distinct from v_job.workspace_id then
    update public.crm_agent_jobs
    set status = 'failed', error_code = 'scope_changed',
        lease_token = null, lease_until = null, updated_at = clock_timestamp()
    where id = v_job.id;
    return jsonb_build_object('status', 'failed', 'error_code', 'scope_changed');
  end if;

  -- The client answered while the model was thinking, or a newer job for the
  -- same client already exists. Either way this answer is about a CRM that no
  -- longer exists, so it is discarded instead of overwriting fresher state.
  if crm_private.client_ai_watermark(v_job.artist_id, v_job.client_id) is distinct from v_job.snapshot_hash
     or exists (
       select 1 from public.crm_agent_jobs newer
       where newer.client_id = v_job.client_id and newer.artist_id = v_job.artist_id
         and newer.job_type = v_job.job_type and newer.created_at > v_job.created_at
     ) then
    update public.crm_agent_jobs
    set status = 'stale', error_code = 'stale_input',
        lease_token = null, lease_until = null, updated_at = clock_timestamp()
    where id = v_job.id;
    return jsonb_build_object('status', 'stale');
  end if;

  insert into public.client_ai_state (
    artist_id, workspace_id, client_id, summary, brief, missing_information,
    source_watermark, provider, model
  )
  values (
    v_job.artist_id, v_job.workspace_id, v_job.client_id,
    btrim(p_summary), p_brief, coalesce(p_next_action->'missing_information', '[]'::jsonb),
    v_job.snapshot_hash, p_provider, p_model
  )
  on conflict (artist_id, client_id) do update set
    summary = excluded.summary,
    brief = excluded.brief,
    missing_information = excluded.missing_information,
    source_watermark = excluded.source_watermark,
    provider = excluded.provider,
    model = excluded.model,
    version = public.client_ai_state.version + 1,
    refreshed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  returning * into v_state;

  -- A draft is dropped rather than rejected when the action type is not one
  -- that may carry client-facing text. The recommendation is still useful; the
  -- text is what must not survive.
  v_draft := case
    when p_next_action->'draft_reply' = 'null'::jsonb then null
    when (p_next_action->>'action_type') = any (crm_private.crm_agent_draftable_action_types())
      then p_next_action->>'draft_reply'
    else null
  end;

  -- Supersede only the recommendations derived from a DIFFERENT watermark. A
  -- refresh that lands on the same watermark must not close the row it is
  -- about to re-derive, or the artist would be left with no open next step.
  update public.client_ai_next_actions
  set status = 'superseded', updated_at = clock_timestamp()
  where artist_id = v_job.artist_id and client_id = v_job.client_id
    and status = 'open' and source_watermark is distinct from v_job.snapshot_hash;

  -- Re-deriving the same watermark updates the existing row in place and keeps
  -- its id, so the notification dedupe key is unchanged and the artist is not
  -- told about the same thing twice.
  insert into public.client_ai_next_actions (
    artist_id, workspace_id, client_id, client_ai_state_id,
    action_type, reason, priority, draft_reply, missing_information,
    source_watermark, provider, model
  )
  values (
    v_job.artist_id, v_job.workspace_id, v_job.client_id, v_state.id,
    p_next_action->>'action_type', btrim(p_next_action->>'reason'),
    p_next_action->>'priority', v_draft,
    coalesce(p_next_action->'missing_information', '[]'::jsonb),
    v_job.snapshot_hash, p_provider, p_model
  )
  on conflict (artist_id, client_id, source_watermark) do update set
    client_ai_state_id = excluded.client_ai_state_id,
    action_type = excluded.action_type,
    reason = excluded.reason,
    priority = excluded.priority,
    draft_reply = excluded.draft_reply,
    missing_information = excluded.missing_information,
    provider = excluded.provider,
    model = excluded.model,
    -- A recommendation the artist already dismissed stays dismissed: an
    -- identical re-derivation is not new information.
    status = case when public.client_ai_next_actions.status in ('dismissed','actioned')
                  then public.client_ai_next_actions.status else 'open' end,
    updated_at = clock_timestamp()
  returning * into v_action;

  update public.crm_agent_jobs
  set status = 'succeeded', error_code = null,
      lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where id = v_job.id;

  -- Only an action that actually wants the artist is announced. `no_action`
  -- and `await_client` are states, not requests, and notifying on them would
  -- train the artist to ignore the channel.
  if v_action.id is not null and v_action.approval_required then
    v_notifications := crm_private.enqueue_client_ai_notification(v_action.id);
  end if;

  -- Metadata only. The brief, the reason and the draft stay out of the audit
  -- trail: activity rows are read by more surfaces than the derived state is.
  perform crm_private.log_artist_activity(
    v_job.artist_id, 'client_ai.state_refreshed', 'worker', null,
    v_job.client_id, null, null, null, null,
    jsonb_build_object(
      'job_id', v_job.id, 'state_version', v_state.version,
      'action_type', coalesce(v_action.action_type, 'suppressed_duplicate'),
      'approval_required', coalesce(v_action.approval_required, true),
      'provider', p_provider, 'model', p_model,
      'notifications', v_notifications
    )
  );

  return jsonb_build_object(
    'status', 'succeeded',
    'state_id', v_state.id,
    'state_version', v_state.version,
    'next_action_id', v_action.id,
    'action_type', v_action.action_type,
    'approval_required', v_action.approval_required,
    'notifications', v_notifications
  );
end;
$$;

create function public.service_complete_reference_image_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_analysis jsonb,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_file public.enquiry_files%rowtype;
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('qwen','workers_ai','openai','deepseek')
     or p_model is null or length(p_model) not between 1 and 160
     or p_model !~ '^[@a-zA-Z0-9/_.:-]+$'
     or not crm_private.validate_reference_image_analysis(p_analysis) then
    raise exception 'invalid structured AI result' using errcode = '22023';
  end if;

  select j.* into v_job from public.crm_agent_jobs j where j.id = p_job_id for update;
  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp()
     or v_job.job_type <> 'analyze_reference_image' then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  if not coalesce((select vision_enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- The file, the enquiry and the artist must still agree. A file whose
  -- enquiry moved is not this artist's to describe.
  select f.* into v_file
  from public.enquiry_files f
  join public.enquiries e on e.id = f.enquiry_id and e.artist_id = v_job.artist_id
    and e.client_id = v_job.client_id and e.archived_at is null
  where f.id = v_job.enquiry_file_id and f.upload_state = 'ready';
  if not found then
    update public.crm_agent_jobs
    set status = 'failed', error_code = 'image_unavailable',
        lease_token = null, lease_until = null, updated_at = clock_timestamp()
    where id = v_job.id;
    return jsonb_build_object('status', 'failed', 'error_code', 'image_unavailable');
  end if;

  insert into public.enquiry_file_ai_analysis (
    artist_id, workspace_id, client_id, enquiry_id, enquiry_file_id,
    source_checksum, analysis, summary, provider, model
  )
  values (
    v_job.artist_id, v_job.workspace_id, v_job.client_id, v_job.enquiry_id, v_file.id,
    v_file.checksum, p_analysis, btrim(p_analysis->>'summary'), p_provider, p_model
  )
  on conflict (enquiry_file_id) do update set
    source_checksum = excluded.source_checksum,
    analysis = excluded.analysis,
    summary = excluded.summary,
    provider = excluded.provider,
    model = excluded.model,
    analyzed_at = clock_timestamp()
  returning id into v_id;

  update public.crm_agent_jobs
  set status = 'succeeded', error_code = null,
      lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where id = v_job.id;

  -- A new image summary changes the watermark, so the brief that quoted the
  -- old set of images is now stale. Schedule the refresh that resolves it.
  perform crm_private.schedule_client_ai_refresh(
    v_job.artist_id, v_job.client_id, 'image:' || v_file.id::text);

  perform crm_private.log_artist_activity(
    v_job.artist_id, 'client_ai.image_analyzed', 'worker', null,
    v_job.client_id, v_job.enquiry_id, null, null, null,
    jsonb_build_object('job_id', v_job.id, 'provider', p_provider, 'model', p_model)
  );

  return jsonb_build_object('status', 'succeeded', 'analysis_id', v_id);
end;
$$;

revoke all on function
  public.service_complete_client_ai_state_job(uuid,uuid,text,jsonb,jsonb,text,text),
  public.service_complete_reference_image_job(uuid,uuid,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function
  public.service_complete_client_ai_state_job(uuid,uuid,text,jsonb,jsonb,text,text),
  public.service_complete_reference_image_job(uuid,uuid,jsonb,text,text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 14. Artist reads
--
-- The mobile surface. Three bounded reads for `authenticated` only, each
-- gated by the capability registry, each re-deriving the artist/client
-- relationship rather than trusting an id from the caller.
-- ---------------------------------------------------------------------------

create function public.get_client_ai_state(p_artist_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_state public.client_ai_state%rowtype;
  v_action public.client_ai_next_actions%rowtype;
  v_facts jsonb;
  v_current text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  if crm_private.client_ai_scope(p_artist_id, p_client_id) is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;

  -- Canonical money/date/booking facts, read live. These are returned
  -- alongside the brief and always win: a brief that still remembers a
  -- cancelled session is visibly contradicted rather than quietly believed.
  select jsonb_build_object(
    'projects', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'status', p.status, 'deposit_status', p.deposit_status,
        'estimated_sessions', p.estimated_sessions,
        'estimate_total', p.estimate_total, 'currency', p.currency
      ) order by p.created_at desc), '[]'::jsonb)
      from public.projects p
      where p.client_id = p_client_id and p.artist_id = p_artist_id and p.archived_at is null
    ),
    'sessions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'status', s.status, 'start_at', s.start_at, 'payment_status', s.payment_status
      ) order by s.start_at desc), '[]'::jsonb)
      from public.sessions s
      where s.client_id = p_client_id and s.artist_id = p_artist_id
        and s.status in ('proposed','confirmed','completed')
    )
  ) into v_facts;

  select st.* into v_state from public.client_ai_state st
  where st.artist_id = p_artist_id and st.client_id = p_client_id;

  if not found then
    return jsonb_build_object(
      'status', 'not_generated',
      'enabled', coalesce((select enabled from crm_private.crm_agent_config where singleton), false),
      'crm_facts', v_facts
    );
  end if;

  select a.* into v_action from public.client_ai_next_actions a
  where a.artist_id = p_artist_id and a.client_id = p_client_id and a.status = 'open';

  v_current := crm_private.client_ai_watermark(p_artist_id, p_client_id);

  return jsonb_build_object(
    'status', 'ready',
    'enabled', coalesce((select enabled from crm_private.crm_agent_config where singleton), false),
    'version', v_state.version,
    'summary', v_state.summary,
    'brief', v_state.brief,
    'missing_information', v_state.missing_information,
    'refreshed_at', v_state.refreshed_at,
    'provider', v_state.provider,
    'model', v_state.model,
    -- Provenance, so a reader can answer "was this derived from what the CRM
    -- looks like now?" without trusting the timestamp.
    'is_stale', (v_current is distinct from v_state.source_watermark),
    'crm_facts', v_facts,
    'next_action', case when v_action.id is null then null else jsonb_build_object(
      'id', v_action.id,
      'action_type', v_action.action_type,
      'reason', v_action.reason,
      'priority', v_action.priority,
      'approval_required', v_action.approval_required,
      'draft_reply', v_action.draft_reply,
      'missing_information', v_action.missing_information,
      'created_at', v_action.created_at,
      'is_stale', (v_current is distinct from v_action.source_watermark)
    ) end
  );
end;
$$;

comment on function public.get_client_ai_state(uuid,uuid) is
  'One client brief plus the live CRM facts it must not contradict. Reports is_stale by comparing the stored watermark to a freshly computed one.';

-- The "what needs me" digest. Deliberately small: this is what a phone shows.
create function public.list_client_ai_next_actions(
  p_artist_id uuid,
  p_limit integer default 20
)
returns table (
  next_action_id uuid,
  client_id uuid,
  client_name text,
  action_type text,
  reason text,
  priority text,
  approval_required boolean,
  has_draft boolean,
  is_stale boolean,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_clients');

  return query
  select
    a.id,
    a.client_id,
    left(c.full_name, 160),
    a.action_type,
    a.reason,
    a.priority,
    a.approval_required,
    (a.draft_reply is not null),
    (crm_private.client_ai_watermark(a.artist_id, a.client_id) is distinct from a.source_watermark),
    a.created_at
  from public.client_ai_next_actions a
  join public.clients c on c.id = a.client_id and c.archived_at is null
  where a.artist_id = p_artist_id
    and a.status = 'open'
    and a.action_type not in ('no_action','await_client')
    -- The relationship is re-proved per row. A membership change between the
    -- capability check and the read cannot leak another artist's client.
    and crm_private.client_ai_scope(a.artist_id, a.client_id) is not null
  order by
    case a.priority when 'high' then 0 when 'normal' then 1 else 2 end,
    a.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

comment on function public.list_client_ai_next_actions(uuid,integer) is
  'Open recommendations awaiting the artist, newest and highest priority first. Returns a has_draft flag rather than the draft: the digest is a list, not a send surface.';

create function public.get_client_timeline(
  p_artist_id uuid,
  p_client_id uuid,
  p_limit integer default 50
)
returns table (
  source text,
  source_id uuid,
  direction text,
  body text,
  occurred_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_communications');
  if crm_private.client_ai_scope(p_artist_id, p_client_id) is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;

  return query
  select t.source, t.source_id, t.direction, left(t.body, 1000), t.occurred_at
  from crm_private.client_timeline_items(p_artist_id, p_client_id) t
  -- Stable ordering: the timestamp alone is not unique across six sources, and
  -- an unstable order makes paging silently skip or repeat an item.
  order by t.occurred_at desc, t.source_id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

comment on function public.get_client_timeline(uuid,uuid,integer) is
  'The unified client history for one artist, projected live from the tables that own each item. Copies nothing and stores nothing.';

revoke all on function
  public.get_client_ai_state(uuid,uuid),
  public.list_client_ai_next_actions(uuid,integer),
  public.get_client_timeline(uuid,uuid,integer)
  from public, anon, service_role;
grant execute on function
  public.get_client_ai_state(uuid,uuid),
  public.list_client_ai_next_actions(uuid,integer),
  public.get_client_timeline(uuid,uuid,integer)
  to authenticated;

-- Resolving a recommendation is an artist action, not a model one.
create function public.resolve_client_ai_next_action(
  p_next_action_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_action public.client_ai_next_actions%rowtype;
begin
  if p_status not in ('dismissed','actioned') then
    raise exception 'invalid recommendation status' using errcode = '22023';
  end if;

  select a.* into v_action from public.client_ai_next_actions a
  where a.id = p_next_action_id for update;
  if not found then
    raise exception 'recommendation unavailable' using errcode = '42501';
  end if;

  perform crm_private.require_artist_access(v_action.artist_id, 'manage_clients');
  perform crm_private.require_active_artist(v_action.artist_id);
  if crm_private.client_ai_scope(v_action.artist_id, v_action.client_id) is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;
  if v_action.status <> 'open' then
    return jsonb_build_object('status', v_action.status, 'changed', false);
  end if;

  update public.client_ai_next_actions
  set status = p_status, updated_at = clock_timestamp()
  where id = v_action.id;

  -- `actioned` records that the artist dealt with it. It performs no send, no
  -- booking and no payment: those remain the artist's own CRM actions.
  perform crm_private.log_artist_activity(
    v_action.artist_id, 'client_ai.action_resolved', 'staff', auth.uid(),
    v_action.client_id, null, null, null, null,
    jsonb_build_object('next_action_id', v_action.id, 'action_type', v_action.action_type, 'status', p_status)
  );

  return jsonb_build_object('status', p_status, 'changed', true);
end;
$$;

revoke all on function public.resolve_client_ai_next_action(uuid,text)
  from public, anon, service_role;
grant execute on function public.resolve_client_ai_next_action(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Event wiring
--
-- Three triggers, all AFTER, all wrapped so a queue problem can never roll
-- back the business write that caused it. An enquiry must be stored even if
-- the AI queue is unavailable; the same is true of an inbound WhatsApp
-- message and of a finished upload.
--
-- The exception block emits nothing on purpose: SQLERRM here could carry a
-- message body or an email address into the PostgreSQL log.
-- ---------------------------------------------------------------------------

create function crm_private.enqueue_enquiry_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.intake_state <> 'complete'
     or (tg_op = 'UPDATE' and old.intake_state = 'complete' and old.status is not distinct from new.status) then
    return new;
  end if;
  begin
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, 'enquiry:' || new.id::text || ':' || new.status::text);
  exception when others then null;
  end;
  return new;
end;
$$;

create trigger enquiries_enqueue_client_ai
  after insert or update of intake_state, status on public.enquiries
  for each row execute function crm_private.enqueue_enquiry_client_ai();

-- Inbound only. An outbound message is the artist acting; the artist does not
-- need a suggestion about the thing they just did, and refreshing on both
-- halves of a conversation doubles the model spend for no new information.
create function crm_private.enqueue_communication_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client uuid;
begin
  if new.direction <> 'inbound' then
    return new;
  end if;
  begin
    select v.client_id into v_client
    from public.communication_conversations v
    where v.id = new.conversation_id and v.artist_id = new.artist_id
      and v.link_state = 'linked';
    if v_client is not null then
      perform crm_private.schedule_client_ai_refresh(
        new.artist_id, v_client, 'message:' || new.id::text);
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

create trigger communication_messages_enqueue_client_ai
  after insert on public.communication_messages
  for each row execute function crm_private.enqueue_communication_client_ai();

-- A conversation linked to a client after the fact carries a history the brief
-- has never seen. Linking is the event, not any one message in it.
create function crm_private.enqueue_conversation_link_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.link_state <> 'linked' or new.client_id is null
     or (tg_op = 'UPDATE' and old.client_id is not distinct from new.client_id) then
    return new;
  end if;
  begin
    perform crm_private.schedule_client_ai_refresh(
      new.artist_id, new.client_id, 'conversation:' || new.id::text);
  exception when others then null;
  end;
  return new;
end;
$$;

create trigger communication_conversations_enqueue_client_ai
  after insert or update of client_id, link_state on public.communication_conversations
  for each row execute function crm_private.enqueue_conversation_link_client_ai();

create function crm_private.enqueue_enquiry_file_client_ai()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.upload_state <> 'ready' or (tg_op = 'UPDATE' and old.upload_state = 'ready') then
    return new;
  end if;
  begin
    perform crm_private.schedule_reference_image_analysis(new.id);
  exception when others then null;
  end;
  return new;
end;
$$;

create trigger enquiry_files_enqueue_client_ai
  after insert or update of upload_state on public.enquiry_files
  for each row execute function crm_private.enqueue_enquiry_file_client_ai();

revoke all on function
  crm_private.enqueue_enquiry_client_ai(),
  crm_private.enqueue_communication_client_ai(),
  crm_private.enqueue_conversation_link_client_ai(),
  crm_private.enqueue_enquiry_file_client_ai()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 16. Deterministic rebuild
--
-- Derived state must be reconstructable on demand, not only when an event
-- happens to fire. This is the artist-facing "recompute this client" and the
-- operator's recovery path after a bad model day.
-- ---------------------------------------------------------------------------

create function public.refresh_client_ai_state(p_artist_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_watermark text;
  v_job uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_clients');
  perform crm_private.require_active_artist(p_artist_id);
  if crm_private.client_ai_scope(p_artist_id, p_client_id) is null then
    raise exception 'client scope unavailable' using errcode = '42501';
  end if;
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Keyed on the current watermark, so asking twice for the same unchanged CRM
  -- state is one job, while asking again after the client replies is a new one.
  v_watermark := crm_private.client_ai_watermark(p_artist_id, p_client_id);
  v_job := crm_private.schedule_client_ai_refresh(
    p_artist_id, p_client_id, 'manual:' || left(v_watermark, 32));

  if v_job is null then
    -- An existing job for this exact watermark is already queued or done.
    -- Requeue a terminal one so a failure is recoverable from the phone.
    update public.crm_agent_jobs
    set status = 'pending', attempts = 0, available_at = clock_timestamp(),
        lease_token = null, lease_until = null, error_code = null,
        updated_at = clock_timestamp()
    where artist_id = p_artist_id
      and job_type = 'refresh_client_ai_state'
      and source_event_id = 'manual:' || left(v_watermark, 32)
      and status in ('failed','stale')
    returning id into v_job;
  end if;

  return jsonb_build_object(
    'status', case when v_job is null then 'already_queued' else 'queued' end,
    'job_id', v_job);
end;
$$;

revoke all on function public.refresh_client_ai_state(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.refresh_client_ai_state(uuid,uuid) to authenticated;

comment on function public.refresh_client_ai_state(uuid,uuid) is
  'Artist-triggered recomputation, keyed on the current watermark so repeat presses collapse to one job and a post-reply press does not.';
