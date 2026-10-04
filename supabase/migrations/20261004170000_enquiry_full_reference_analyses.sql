-- 20261004170000_enquiry_full_reference_analyses.sql
--
-- The Vishar CRM Plugin reviews an enquiry with crm_get_enquiry_full. Until
-- now that read carried the client's text and form answers but nothing about
-- the attached photos, so a review saw the images only through the CRM client
-- brief, written by a small text model, or not at all. The stored analyses
-- were reachable only from the consultation context (20261004160000).
--
-- One helper now builds the image list, and both reads return it unchanged:
--   * gpt_get_enquiry_full gains a reference_analyses column;
--   * gpt_get_consultation_context keeps reference_analyses, from the helper.
-- Each item is the vision model's stored analysis object as written (summary,
-- subjects, body area, existing tattoo visible, image kind, composition,
-- palette, quality limitations), with the model that wrote it and a short
-- note on how to use it. Nothing is re-summarised. Permissions are those of
-- the read that returns it: gpt_get_enquiry_full keeps its operational
-- context, artist scope, complete-intake and not-archived filters.

create or replace function crm_private.enquiry_reference_analyses(p_enquiry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(jsonb_agg(x.item order by x.ordinal), '[]'::jsonb)
  from (
    select f.ordinal, jsonb_build_object(
      'enquiry_file_id', f.id,
      'category', f.category,
      'analysed_at', a.analyzed_at,
      'model', a.model,
      'summary', left(a.summary, 1200),
      'analysis', a.analysis,
      'source', 'Stored vision-model analysis of this attached image, not re-summarised. Use it with the client''s own text when reviewing the request, references, cover-up and placement. The image and the client''s words are authoritative; mark anything the analysis cannot see as unknown.'
    ) as item
    from public.enquiry_files f
    join public.enquiry_file_ai_analysis a on a.enquiry_file_id = f.id
    where f.enquiry_id = p_enquiry_id and f.upload_state = 'ready'
    order by f.ordinal
    limit 8
  ) x;
$$;

revoke all on function crm_private.enquiry_reference_analyses(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_reference_analyses(uuid) is
  'Stored vision analyses of an enquiry''s ready reference images, unchanged. Callers enforce access before calling it.';

-- The return type gains a column, so the function is recreated.
drop function if exists public.gpt_get_enquiry_full(uuid);

create function public.gpt_get_enquiry_full(p_enquiry_id uuid)
returns table (
  enquiry_id uuid,
  reference_number text,
  status public.enquiry_status,
  client_identifier_conflict boolean,
  assigned_to uuid,
  assigned_to_name text,
  client_id uuid,
  client_name text,
  client_email text,
  client_phone text,
  client_instagram text,
  preferred_contact text,
  travelling_from text,
  project_type text,
  placement text,
  approximate_size text,
  cover_up text,
  preferred_timing text,
  idea text,
  source text,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  created_at timestamptz,
  updated_at timestamptz,
  last_action_at timestamptz,
  reference_analyses jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  return query
  select e.id, e.reference_number, e.status, e.client_identifier_conflict,
         e.assigned_to, p.display_name,
         e.client_id, cl.full_name, cl.email, cl.phone, cl.instagram,
         cl.preferred_contact, cl.travelling_from,
         e.project_type, e.placement, e.approximate_size, e.cover_up,
         e.preferred_timing, e.idea,
         e.source, e.landing_page, e.referrer,
         e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.utm_term,
         e.created_at, e.updated_at, e.last_action_at,
         crm_private.enquiry_reference_analyses(e.id)
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  left join public.profiles p on p.id = e.assigned_to
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and e.intake_state = 'complete'
    and e.archived_at is null;
end;
$$;

revoke all on function public.gpt_get_enquiry_full(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_enquiry_full(uuid) to authenticated;

comment on function public.gpt_get_enquiry_full(uuid) is
  'Full enquiry for the active GPT Artist: client contact, form answers, the client''s original text and reference_analyses (stored vision analyses of the attached images, unchanged).';

-- The consultation context returns the same list from the same helper.
create or replace function public.gpt_get_consultation_context(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context jsonb;
  v_enquiry_id uuid;
begin
  v_context := crm_private.gpt_get_consultation_context_core(p_appointment_id);
  begin
    v_enquiry_id := nullif(v_context -> 'enquiry' ->> 'enquiry_id', '')::uuid;
  exception when invalid_text_representation then
    v_enquiry_id := null;
  end;
  -- The enquiry section is present only when the caller may read the
  -- enquiry, so the analyses follow exactly the same permission.
  if v_enquiry_id is null or jsonb_typeof(v_context) is distinct from 'object' then
    return v_context;
  end if;
  return v_context || jsonb_build_object('reference_analyses', crm_private.enquiry_reference_analyses(v_enquiry_id));
end;
$$;

revoke all on function public.gpt_get_consultation_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_consultation_context(uuid) to authenticated;
