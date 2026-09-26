-- 20260924090000_intake_preflight_telemetry.sql
--
-- Intake semantic preflight telemetry. One row per preflight answer the
-- public intake endpoint gives; the later real submit may mark it.
--
-- Stores metadata only: contract version, status, clarification categories,
-- provider outcome, latency, which form path, and what the client did next
-- (corrected, sent anyway, or unchanged). Never enquiry text, never a client
-- identifier. A row links to the enquiry it preceded only after that enquiry
-- exists, so conversion and abandonment can be measured later:
-- - share of preflights that asked for clarification, per category;
-- - corrected vs sent anyway after a clarification;
-- - preflights never followed by a submit (abandonment);
-- - later, first artist questions per enquiry before/after.

create table crm_private.intake_preflight_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  preflight_version text not null check (preflight_version ~ '^intake-preflight\.[0-9a-z.-]{1,40}$'),
  form_path text not null check (form_path in ('external', 'hosted', 'slug')),
  status text not null check (status in ('ready', 'clarify', 'artist_review', 'skipped')),
  categories text[] not null default '{}'
    check (categories <@ array['placement', 'size', 'idea', 'coverup_goal']::text[] and cardinality(categories) <= 3),
  provider text check (provider is null or provider ~ '^[a-z0-9_]{1,24}$'),
  outcome text not null check (outcome ~ '^[a-z0-9_]{1,40}$'),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 60000),
  submitted_at timestamptz,
  submit_choice text check (submit_choice is null or submit_choice in ('unchanged', 'corrected', 'send_anyway')),
  enquiry_id uuid references public.enquiries(id) on delete set null,
  constraint intake_preflight_submit_shape check (
    (submitted_at is null and submit_choice is null and enquiry_id is null)
    or (submitted_at is not null and submit_choice is not null)
  )
);

create index intake_preflight_events_created_idx on crm_private.intake_preflight_events (created_at desc);

revoke all on crm_private.intake_preflight_events from public, anon, authenticated, service_role;

comment on table crm_private.intake_preflight_events is
  'Intake semantic preflight telemetry: statuses, categories, provider outcome and latency only. No enquiry text or client identifiers.';

create function public.service_record_intake_preflight(p_event jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_categories text[];
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object'
     or coalesce(p_event ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'preflight event with an id is required' using errcode = '22023';
  end if;
  select coalesce(array_agg(c), '{}'::text[]) into v_categories
  from jsonb_array_elements_text(coalesce(p_event -> 'categories', '[]'::jsonb)) c;

  -- The Worker mints the id so the browser gets it without waiting for this
  -- write; a replayed id is ignored.
  insert into crm_private.intake_preflight_events (
    id, preflight_version, form_path, status, categories, provider, outcome, latency_ms
  ) values (
    (p_event ->> 'id')::uuid, p_event ->> 'version', p_event ->> 'form_path', p_event ->> 'status', v_categories,
    nullif(p_event ->> 'provider', ''), p_event ->> 'outcome',
    case when jsonb_typeof(p_event -> 'latency_ms') = 'number'
         then least(greatest(round((p_event ->> 'latency_ms')::numeric), 0), 60000)::integer end
  )
  on conflict (id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- The event id comes back from the browser, so it is untrusted: only an
-- unmarked event from the last day is updated, only once, and only linked to
-- an enquiry that exists.
create function public.service_mark_intake_preflight_submitted(
  p_event_id uuid,
  p_choice text,
  p_enquiry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_rows integer;
begin
  if p_event_id is null or p_choice is null or p_choice not in ('unchanged', 'corrected', 'send_anyway') then
    return jsonb_build_object('status', 'ignored');
  end if;
  update crm_private.intake_preflight_events e
  set submitted_at = clock_timestamp(),
      submit_choice = p_choice,
      enquiry_id = (select en.id from public.enquiries en where en.id = p_enquiry_id)
  where e.id = p_event_id
    and e.submitted_at is null
    and e.created_at > clock_timestamp() - interval '1 day';
  get diagnostics v_rows = row_count;
  return jsonb_build_object('status', case when v_rows = 1 then 'marked' else 'ignored' end);
end;
$$;

revoke all on function public.service_record_intake_preflight(jsonb) from public, anon, authenticated;
grant execute on function public.service_record_intake_preflight(jsonb) to service_role;
revoke all on function public.service_mark_intake_preflight_submitted(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.service_mark_intake_preflight_submitted(uuid, text, uuid) to service_role;

comment on function public.service_record_intake_preflight(jsonb) is
  'Backend only. Records one intake preflight answer (metadata only) and returns its id.';
comment on function public.service_mark_intake_preflight_submitted(uuid, text, uuid) is
  'Backend only. Marks a recent preflight as followed by a real submit (unchanged, corrected or send_anyway).';
