-- Align the AI result contract with the canonical CRM discovery_source taxonomy.
-- The booking table already accepts exactly these seven values; model output must
-- preserve them rather than translating them into a second AI-only vocabulary.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'crm_private'
    and p.proname = 'validate_enquiry_ai_result'
    and pg_get_function_identity_arguments(p.oid) = 'p_result jsonb';

  if v_definition is null
    or position("v_key = 'discovery_source' and v_field->>'value' not in ('instagram','chatgpt','other_ai','friend_referral','google','other')" in v_definition) = 0
  then
    raise exception 'unexpected validate_enquiry_ai_result discovery_source contract';
  end if;
end;
$$;

create or replace function crm_private.validate_enquiry_ai_result(p_result jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, public, crm_private as $$
declare
  v_names constant text[] := array['client_name','email','phone','project_description','concept','placement','style','approximate_size','colour','cover_up','budget','preferred_dates','reference_images_present','discovery_source','discovery_source_detail','notes'];
  v_key text; v_field jsonb; v_status text; v_missing text[]; v_expected text[] := '{}';
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object'
    or not (p_result ?& array['fields','summary','missing_information','draft_reply'])
    or (p_result - array['fields','summary','missing_information','draft_reply']) <> '{}'::jsonb
    or jsonb_typeof(p_result->'fields') <> 'object'
    or not ((p_result->'fields') ?& v_names)
    or ((p_result->'fields') - v_names) <> '{}'::jsonb
    or jsonb_typeof(p_result->'summary') <> 'string'
    or length(btrim(p_result->>'summary')) not between 1 and 1200
    or jsonb_typeof(p_result->'draft_reply') <> 'string'
    or length(btrim(p_result->>'draft_reply')) not between 1 and 3000
    or p_result->>'draft_reply' ~* '(https?://|www\.|[£$€][[:space:]]*[0-9]|[0-9][[:space:]]*(gbp|usd|eur|pounds?|dollars?|euros?)\y|\y(confirmed|booked|guaranteed|available on|reserve|reserved|price is|costs?[[:space:]]+[0-9]|(will|would|should|takes?)[[:space:]]+[0-9]+[[:space:]]+sessions?|pay(ment)?[[:space:]]+(now|here|to)|send[[:space:]]+(a[[:space:]]+)?deposit|deposit[[:space:]]+(is|of|required)|ignore[[:space:]]+(previous|all)|system prompt)\y)'
    or jsonb_typeof(p_result->'missing_information') <> 'array'
    then return false; end if;
  foreach v_key in array v_names loop
    v_field := p_result->'fields'->v_key;
    if jsonb_typeof(v_field) <> 'object' or not (v_field ?& array['value','status'])
      or (v_field - array['value','status']) <> '{}'::jsonb
      or jsonb_typeof(v_field->'status') <> 'string' then return false; end if;
    v_status := v_field->>'status';
    if v_status not in ('explicit','inferred','missing') then return false; end if;
    if v_status = 'missing' then
      if v_field->'value' <> 'null'::jsonb then return false; end if;
      v_expected := array_append(v_expected, v_key);
    else
      if v_key in ('cover_up','reference_images_present') then
        if jsonb_typeof(v_field->'value') <> 'boolean' then return false; end if;
      else
        if jsonb_typeof(v_field->'value') <> 'string'
          or length(btrim(v_field->>'value')) < 1
          or length(btrim(v_field->>'value')) > (case when v_key in ('project_description','notes') then 2000 else 500 end)
          then return false; end if;
        if v_key = 'colour' and v_field->>'value' not in ('colour','black_and_grey','mixed') then return false; end if;
        if v_key = 'discovery_source' and v_field->>'value' not in ('instagram','google','ai','referral','convention','returning_client','other') then return false; end if;
      end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_result->'missing_information') x where jsonb_typeof(x) <> 'string') then return false; end if;
  select coalesce(array_agg(x order by x),'{}') into v_missing from jsonb_array_elements_text(p_result->'missing_information') x;
  select coalesce(array_agg(x order by x),'{}') into v_expected from unnest(v_expected) x;
  return v_missing = v_expected;
end;
$$;

revoke all on function crm_private.validate_enquiry_ai_result(jsonb) from public, anon, authenticated;
