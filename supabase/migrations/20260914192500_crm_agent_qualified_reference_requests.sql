-- Preserve legitimate requests for an additional or more specific reference.
-- Structured missing_information may still use the generic `reference_images`
-- field name, so the qualification in the artist-facing reason/draft must win.

create or replace function crm_private.client_ai_action_requests_attached_references(
  p_reason text,
  p_draft_reply text,
  p_missing_information jsonb
) returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_text text := lower(coalesce(p_reason, '') || ' ' || coalesce(p_draft_reply, ''));
  v_missing jsonb := case
    when jsonb_typeof(coalesce(p_missing_information, '[]'::jsonb)) = 'array'
      then coalesce(p_missing_information, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_qualified boolean;
begin
  v_qualified := v_text ~ '(additional|another|more|extra|specific|clearer|updated|different).{0,60}(reference|image|photo)';

  -- A structured field name such as `reference_images` describes the kind of
  -- information missing, not whether the request is generic. If the actual
  -- artist-facing wording explicitly asks for an additional/specific image,
  -- keep the request even when that generic field name is present.
  if not v_qualified and exists (
    select 1
    from jsonb_array_elements_text(v_missing) x(value)
    where lower(x.value) ~ '(^|[_ -])reference(s|[_ -]?(image|photo)s?)?([_ -]|$)'
  ) then
    return true;
  end if;

  -- Block only a generic request to send/upload the references that are
  -- already present. Qualified requests remain possible when the project
  -- genuinely needs another, clearer or more specific image.
  if not v_qualified and (
    v_text ~ '(send|provide|share|upload|attach|supply).{0,80}(reference|reference image|reference photo)'
    or v_text ~ '(reference|reference image|reference photo).{0,80}(send|provide|share|upload|attach|supply)'
  ) then
    return true;
  end if;

  return false;
end;
$$;

revoke execute on function crm_private.client_ai_action_requests_attached_references(text, text, jsonb)
  from public, anon, authenticated, service_role;
