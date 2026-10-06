-- 20261006090000_readable_reference_analyses.sql
--
-- reference_analyses (20261004170000) reaches the Vishar CRM Plugin from
-- crm_get_enquiry_full and crm_get_consultation_context. Same stored data,
-- easier to read:
--   * one note on top instead of the same sentence on every photo;
--   * each photo numbered as the CRM shows it ("2 of 3": ready reference
--     images in upload order), so the assistant can say "the second photo";
--   * the vision fields at the top level of each photo, the description once
--     (it was repeated in summary and analysis.summary);
--   * photos the CRM holds but has not analysed are named, so silence about
--     a photo is not read as "nothing there";
--   * internal identifiers (file id, category) dropped.
-- Nothing is re-summarised: every value is the stored analysis as written.
-- Permissions are unchanged: callers enforce access before calling it.

create or replace function crm_private.enquiry_reference_analyses(p_enquiry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with ready as (
    select f.id, row_number() over (order by f.ordinal, f.id) as position,
           count(*) over () as total
    from public.enquiry_files f
    where f.enquiry_id = p_enquiry_id and f.upload_state = 'ready'
  ), photos as (
    select r.position, r.total, a.analysis, a.summary, a.model, a.analyzed_at
    from ready r
    left join public.enquiry_file_ai_analysis a on a.enquiry_file_id = r.id
  )
  select jsonb_build_object(
    'note', 'Stored vision-model analysis of the client''s attached photos, not re-summarised. Photos are numbered as in the CRM. Use them with the client''s own text when reviewing the request, references, cover-up and placement. The photos and the client''s words are authoritative; anything an analysis does not show is unknown.',
    'images', coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'image', p.position || ' of ' || p.total,
          'summary', left(coalesce(p.analysis ->> 'summary', p.summary), 1200),
          'image_kind', p.analysis -> 'image_kind',
          'existing_tattoo_visible', p.analysis -> 'existing_tattoo_visible',
          'body_area', p.analysis -> 'body_area',
          'subjects', p.analysis -> 'subjects',
          'composition', p.analysis -> 'composition',
          'palette', p.analysis -> 'palette',
          'quality_limitations', p.analysis -> 'quality_limitations',
          'model', p.model,
          'analysed_at', p.analyzed_at))
        order by p.position)
      from (select * from photos where model is not null order by position limit 8) p
    ), '[]'::jsonb),
    'not_analysed', coalesce((
      select jsonb_agg(p.position || ' of ' || p.total order by p.position)
      from photos p where p.model is null
    ), '[]'::jsonb)
  );
$$;

revoke all on function crm_private.enquiry_reference_analyses(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.enquiry_reference_analyses(uuid) is
  'Stored vision analyses of an enquiry''s ready reference photos, unchanged, numbered as in the CRM: {note, images[], not_analysed[]}. Callers enforce access before calling it.';
