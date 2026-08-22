-- 0082_message_templates_and_consent.sql
--
-- Phase O: reusable message templates, and the consent and suppression guards
-- that decide whether a client may be contacted at all.
--
-- Order matters here. Nothing in this lineage can yet send a message to a
-- client — the automation engine's only action is an internal notification, and
-- migration 0069's communications core is operator-driven. The guard is built
-- first, on purpose, so that the first client-facing action has something to
-- fail closed against instead of being the release that also invents the rule.
--
-- The distinction the whole file turns on
-- ---------------------------------------
-- A service message is part of work the client asked for: their appointment is
-- tomorrow, their deposit is due. A marketing message is not. Conflating them
-- is how a CRM ends up sending promotions to someone who only ever asked about
-- a cover-up, so:
--
--   * classification is a property of the catalogued *purpose*, never a flag the
--     template author sets, so a template cannot label a promotion as service;
--   * marketing requires positively recorded consent — absence is refusal;
--   * suppression outranks everything, including consent and service traffic
--     where the reason means the address is unusable.
--
-- `enquiries.privacy_acknowledged_at` is explicitly documented in migration
-- 0003 as "an acknowledgement, not consent as the lawful basis", so it is not
-- read here. Consent is its own positively recorded fact.
--
-- Forward-only. No provider is contacted, no message is sent, and no existing
-- behaviour changes.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'message_classification') then
    create type public.message_classification as enum ('service', 'marketing');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'message_template_channel') then
    create type public.message_template_channel as enum ('email', 'whatsapp', 'instagram');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'message_template_status') then
    create type public.message_template_status as enum ('draft', 'active', 'retired');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'consent_state') then
    create type public.consent_state as enum ('granted', 'withdrawn');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'suppression_reason') then
    -- `unsubscribed` withdraws marketing only. Every other reason means the
    -- address itself is unusable, so it stops service traffic too.
    create type public.suppression_reason as enum
      ('unsubscribed', 'complained', 'bounced', 'blocked', 'invalid_destination', 'manual');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Purpose catalogue
--
-- Classification lives here rather than on the template, so "is this
-- marketing?" is answered by what the message is *for*, not by what its author
-- chose to tick. Adding a marketing purpose is a migration a reviewer sees.
-- ---------------------------------------------------------------------------

create table if not exists public.message_template_purposes (
  purpose        text primary key,
  classification public.message_classification not null,
  description    text not null,
  created_at     timestamptz not null default now(),
  constraint message_template_purposes_shape
    check (purpose ~ '^[a-z][a-z0-9_]{2,63}$')
);

comment on table public.message_template_purposes is
  'What a template may be for, and whether that purpose is service or marketing. Classification is catalogued rather than chosen, so a template cannot label a promotion as service traffic.';

insert into public.message_template_purposes (purpose, classification, description) values
  ('session_reminder_24h',   'service',   'Reminds a client of an appointment in the next day.'),
  ('session_reminder_72h',   'service',   'Reminds a client of an appointment later in the week.'),
  ('deposit_policy',         'service',   'Explains the deposit that secures a booked appointment.'),
  ('new_enquiry_ack',        'service',   'Acknowledges an enquiry the client just sent.'),
  ('consultation_reminder',  'service',   'Reminds a client of a booked consultation.'),
  ('no_response_followup',   'service',   'Follows up an enquiry the client has not replied to.'),
  ('availability_announcement', 'marketing', 'Announces newly opened dates to past clients.'),
  ('studio_news',            'marketing', 'General studio or artist news.')
on conflict (purpose) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Variable catalogue
--
-- The same reasoning as migration 0081's trigger catalogue: a template body is
-- not a template language. It may interpolate catalogued names and nothing
-- else, so there is no expression to evaluate and no field to reach through.
-- Every catalogued variable is operational — a date, a reference, a studio
-- name — and none of them is free text a client wrote.
-- ---------------------------------------------------------------------------

create table if not exists public.message_template_variables (
  variable    text primary key,
  description text not null,
  created_at  timestamptz not null default now(),
  constraint message_template_variables_shape
    check (variable ~ '^[a-z][a-z0-9_]{2,31}$')
);

insert into public.message_template_variables (variable, description) values
  ('client_first_name',   'The client''s first name as recorded in the CRM.'),
  ('artist_display_name', 'The artist the message is sent on behalf of.'),
  ('studio_name',         'The workspace display name.'),
  ('appointment_date',    'The appointment date, formatted for the recipient locale.'),
  ('appointment_time',    'The appointment start time.'),
  ('enquiry_reference',   'The enquiry reference number.'),
  ('deposit_amount',      'The deposit amount with its currency.'),
  ('booking_link',        'The artist''s hosted booking form link.')
on conflict (variable) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Templates
--
-- Scoped to a workspace, optionally overridden for one artist. A template is
-- created as a draft: nothing can select a template that nobody activated.
-- ---------------------------------------------------------------------------

create table if not exists public.message_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  artist_id    uuid references public.artists (id) on delete cascade,
  purpose      text not null references public.message_template_purposes (purpose),
  channel      public.message_template_channel not null,
  locale       text not null default 'en',
  version      integer not null default 1,
  status       public.message_template_status not null default 'draft',
  subject      text,
  body         text not null,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint message_templates_locale_known check (locale in ('en', 'ru')),
  constraint message_templates_body_present check (btrim(body) <> ''),
  constraint message_templates_body_length check (length(body) <= 4000),
  constraint message_templates_subject_length
    check (subject is null or length(subject) <= 200),
  -- A subject belongs to email and nowhere else; carrying one for WhatsApp
  -- would invite a renderer to concatenate it into the body.
  constraint message_templates_subject_channel
    check (channel = 'email' or subject is null)
);

comment on table public.message_templates is
  'Reusable client message bodies, scoped to a workspace with an optional per-artist override. Bodies interpolate catalogued variables only; there is no template language.';

-- One active template per (scope, purpose, channel, locale). Two active
-- candidates would make selection a coin toss at send time.
create unique index if not exists message_templates_active_workspace_idx
  on public.message_templates (workspace_id, purpose, channel, locale)
  where status = 'active' and artist_id is null;

create unique index if not exists message_templates_active_artist_idx
  on public.message_templates (artist_id, purpose, channel, locale)
  where status = 'active' and artist_id is not null;

-- An artist override must belong to the workspace that owns the template, or a
-- studio could publish copy into somebody else's organisation.
create or replace function crm_private.guard_message_template_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
  v_token text;
begin
  if new.artist_id is not null then
    select a.workspace_id into v_workspace_id
    from public.artists a where a.id = new.artist_id;

    if v_workspace_id is null or v_workspace_id <> new.workspace_id then
      raise exception 'an artist template must belong to that artist''s workspace'
        using errcode = '23514';
    end if;
  end if;

  -- Every {{token}} must be catalogued. This is what keeps a body from
  -- referencing an arbitrary column, a function, or anything else a renderer
  -- would have to interpret.
  select m[1] into v_token
  from regexp_matches(coalesce(new.body, '') || ' ' || coalesce(new.subject, ''),
                      '\{\{\s*([^}]*?)\s*\}\}', 'g') m
  where not exists (
    select 1 from public.message_template_variables v where v.variable = m[1]
  )
  limit 1;

  if v_token is not null then
    raise exception 'template uses an uncatalogued variable %', v_token
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists message_templates_guard_scope on public.message_templates;
create trigger message_templates_guard_scope
  before insert or update on public.message_templates
  for each row execute function crm_private.guard_message_template_scope();

drop trigger if exists message_templates_set_updated_at on public.message_templates;
create trigger message_templates_set_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Consent
--
-- Positively recorded, per client and channel. There is no "unknown means yes"
-- path: a client with no row has not consented.
-- ---------------------------------------------------------------------------

create table if not exists public.client_marketing_consent (
  client_id    uuid not null references public.clients (id) on delete cascade,
  channel      public.message_template_channel not null,
  state        public.consent_state not null,
  source       text not null,
  recorded_at  timestamptz not null default now(),
  recorded_by  uuid references public.profiles (id),
  evidence_ref text,
  primary key (client_id, channel),
  constraint client_marketing_consent_source_known
    check (source in ('booking_form', 'client_request', 'imported', 'staff_recorded')),
  -- A pointer to where the evidence lives, not the evidence: no message body,
  -- no address, no free-form note about the person.
  constraint client_marketing_consent_evidence_shape
    check (evidence_ref is null or evidence_ref ~ '^[A-Za-z0-9_:./-]{1,120}$')
);

comment on table public.client_marketing_consent is
  'Positively recorded marketing consent per client and channel. An absent row is not consent. enquiries.privacy_acknowledged_at is an acknowledgement and is deliberately not read as consent.';

-- ---------------------------------------------------------------------------
-- 6. Suppression
--
-- The hard guard. A suppression outranks consent, a template, an automation and
-- any agent surface: the send path asks this before anything else.
-- ---------------------------------------------------------------------------

create table if not exists public.communication_suppressions (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  channel      public.message_template_channel not null,
  reason       public.suppression_reason not null,
  is_active    boolean not null default true,
  detail_code  text,
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  constraint communication_suppressions_detail_shape
    check (detail_code is null or detail_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  constraint communication_suppressions_release_state
    check ((released_at is null) = is_active)
);

comment on table public.communication_suppressions is
  'Hard guard on contacting a client. An unsubscribe stops marketing; every other reason means the address is unusable and stops service traffic too. Releasing a suppression is recorded, never deleted.';

create unique index if not exists communication_suppressions_active_idx
  on public.communication_suppressions (client_id, channel, reason)
  where is_active;

-- ---------------------------------------------------------------------------
-- 7. The gate
--
-- One place that answers "may this client be contacted on this channel for this
-- kind of message". Every future send path calls it; nothing is allowed to
-- reimplement the rule.
-- ---------------------------------------------------------------------------

create or replace function crm_private.client_send_block_reason(
  p_client_id uuid,
  p_channel public.message_template_channel,
  p_classification public.message_classification
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_archived timestamptz;
  v_consent public.consent_state;
begin
  if p_client_id is null or p_channel is null or p_classification is null then
    return 'invalid_request';
  end if;

  select c.archived_at into v_archived
  from public.clients c where c.id = p_client_id;
  if not found then
    return 'unknown_client';
  end if;
  if v_archived is not null then
    return 'client_archived';
  end if;

  -- Suppression first, and before consent: a bounced address cannot receive a
  -- message the client did consent to.
  if exists (
    select 1 from public.communication_suppressions s
    where s.client_id = p_client_id
      and s.channel = p_channel
      and s.is_active
      and (
        -- An unsubscribe is a marketing instruction; it does not stop the
        -- reminder for an appointment the client booked.
        s.reason <> 'unsubscribed'
        or p_classification = 'marketing'
      )
  ) then
    return 'suppressed';
  end if;

  if p_classification = 'service' then
    return null;
  end if;

  select mc.state into v_consent
  from public.client_marketing_consent mc
  where mc.client_id = p_client_id and mc.channel = p_channel;

  -- No row is not consent.
  if v_consent is distinct from 'granted' then
    return 'no_marketing_consent';
  end if;

  return null;
end;
$$;

create or replace function public.may_contact_client(
  p_client_id uuid,
  p_channel public.message_template_channel,
  p_purpose text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_classification public.message_classification;
begin
  -- The purpose decides the classification, so a caller cannot ask the gate to
  -- treat a promotion as service traffic by passing a different argument.
  select p.classification into v_classification
  from public.message_template_purposes p
  where p.purpose = p_purpose;

  if v_classification is null then
    raise exception 'unknown message purpose %', p_purpose using errcode = '22023';
  end if;

  return crm_private.client_send_block_reason(p_client_id, p_channel, v_classification) is null;
end;
$$;

comment on function public.may_contact_client(uuid, public.message_template_channel, text) is
  'The single answer to whether a client may be contacted. Takes a catalogued purpose rather than a classification, so no caller can downgrade a marketing message to service traffic by argument.';

-- ---------------------------------------------------------------------------
-- 8. Template selection
--
-- Artist override first, then the workspace default, and only active rows.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_message_template(
  p_artist_id uuid,
  p_purpose text,
  p_channel public.message_template_channel,
  p_locale text default 'en'
)
returns table (
  template_id    uuid,
  scope          text,
  purpose        text,
  classification public.message_classification,
  channel        public.message_template_channel,
  locale         text,
  version        integer,
  subject        text,
  body           text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select t.id,
         case when t.artist_id is null then 'workspace' else 'artist' end,
         t.purpose, p.classification, t.channel, t.locale, t.version, t.subject, t.body
  from public.message_templates t
  join public.message_template_purposes p on p.purpose = t.purpose
  join public.artists a on a.id = p_artist_id
  where t.status = 'active'
    and t.purpose = p_purpose
    and t.channel = p_channel
    and t.locale = p_locale
    and (t.artist_id = p_artist_id
         or (t.artist_id is null and t.workspace_id = a.workspace_id))
    and crm_private.has_artist_capability(p_artist_id, 'view_automations')
  -- An artist override wins over the workspace default.
  order by (t.artist_id is null)
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 9. Write surfaces
-- ---------------------------------------------------------------------------

create or replace function public.upsert_message_template(
  p_workspace_id uuid,
  p_purpose text,
  p_channel public.message_template_channel,
  p_body text,
  p_locale text default 'en',
  p_subject text default null,
  p_artist_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  -- An artist template is the artist's to write; a workspace template is the
  -- organisation's. Neither borrows the other's authority.
  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'manage_automations');
  else
    perform crm_private.require_workspace_access(p_workspace_id, 'manage_workspace');
  end if;

  if not exists (
    select 1 from public.message_template_purposes p where p.purpose = p_purpose
  ) then
    raise exception 'unknown message purpose %', p_purpose using errcode = '22023';
  end if;

  insert into public.message_templates (
    workspace_id, artist_id, purpose, channel, locale, subject, body,
    status, created_by
  ) values (
    p_workspace_id, p_artist_id, p_purpose, p_channel, coalesce(p_locale, 'en'),
    p_subject, p_body, 'draft', auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.record_client_marketing_consent(
  p_client_id uuid,
  p_channel public.message_template_channel,
  p_state public.consent_state,
  p_source text default 'staff_recorded',
  p_evidence_ref text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'client access is not permitted' using errcode = '42501';
  end if;

  insert into public.client_marketing_consent
    (client_id, channel, state, source, recorded_by, evidence_ref)
  values
    (p_client_id, p_channel, p_state, coalesce(p_source, 'staff_recorded'),
     auth.uid(), p_evidence_ref)
  on conflict (client_id, channel) do update
    set state = excluded.state,
        source = excluded.source,
        recorded_at = now(),
        recorded_by = excluded.recorded_by,
        evidence_ref = excluded.evidence_ref;

  return p_state = 'granted';
end;
$$;

create or replace function public.suppress_client_communications(
  p_client_id uuid,
  p_channel public.message_template_channel,
  p_reason public.suppression_reason,
  p_detail_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  if not public.can_access_client(p_client_id) then
    raise exception 'client access is not permitted' using errcode = '42501';
  end if;

  insert into public.communication_suppressions
    (client_id, channel, reason, detail_code)
  values (p_client_id, p_channel, p_reason, p_detail_code)
  on conflict (client_id, channel, reason) where is_active
    do update set detail_code = excluded.detail_code
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges and RLS
-- ---------------------------------------------------------------------------

alter table public.message_template_purposes enable row level security;
alter table public.message_template_purposes force row level security;
alter table public.message_template_variables enable row level security;
alter table public.message_template_variables force row level security;
alter table public.message_templates enable row level security;
alter table public.message_templates force row level security;
alter table public.client_marketing_consent enable row level security;
alter table public.client_marketing_consent force row level security;
alter table public.communication_suppressions enable row level security;
alter table public.communication_suppressions force row level security;

revoke all on public.message_template_purposes from public, anon, authenticated, service_role;
revoke all on public.message_template_variables from public, anon, authenticated, service_role;
revoke all on public.message_templates from public, anon, authenticated, service_role;
revoke all on public.client_marketing_consent from public, anon, authenticated, service_role;
revoke all on public.communication_suppressions from public, anon, authenticated, service_role;

-- The two catalogues are vocabulary, like public.capability_registry.
grant select on public.message_template_purposes to authenticated;
grant select on public.message_template_variables to authenticated;

create policy message_template_purposes_read on public.message_template_purposes
  for select to authenticated using (public.is_active_user());
create policy message_template_variables_read on public.message_template_variables
  for select to authenticated using (public.is_active_user());

drop policy if exists message_templates_service_select on public.message_templates;
create policy message_templates_service_select on public.message_templates
  for select using (crm_private.is_service_backend());

drop policy if exists client_marketing_consent_service_select on public.client_marketing_consent;
create policy client_marketing_consent_service_select on public.client_marketing_consent
  for select using (crm_private.is_service_backend());

drop policy if exists communication_suppressions_service_select on public.communication_suppressions;
create policy communication_suppressions_service_select on public.communication_suppressions
  for select using (crm_private.is_service_backend());

revoke all on function crm_private.client_send_block_reason(uuid, public.message_template_channel, public.message_classification)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_message_template_scope()
  from public, anon, authenticated, service_role;

revoke all on function public.may_contact_client(uuid, public.message_template_channel, text)
  from public, anon, authenticated, service_role;
grant execute on function public.may_contact_client(uuid, public.message_template_channel, text)
  to authenticated, service_role;

revoke all on function public.resolve_message_template(uuid, text, public.message_template_channel, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_message_template(uuid, text, public.message_template_channel, text)
  to authenticated, service_role;

revoke all on function public.upsert_message_template(uuid, text, public.message_template_channel, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_message_template(uuid, text, public.message_template_channel, text, text, text, uuid)
  to authenticated;

revoke all on function public.record_client_marketing_consent(uuid, public.message_template_channel, public.consent_state, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_client_marketing_consent(uuid, public.message_template_channel, public.consent_state, text, text)
  to authenticated;

revoke all on function public.suppress_client_communications(uuid, public.message_template_channel, public.suppression_reason, text)
  from public, anon, authenticated, service_role;
grant execute on function public.suppress_client_communications(uuid, public.message_template_channel, public.suppression_reason, text)
  to authenticated, service_role;
