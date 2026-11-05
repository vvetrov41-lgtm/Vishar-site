-- Explicitly preserve the message's capability order before binding it to
-- Confirm / Reschedule / Cancel HTML buttons. PostgreSQL aggregates without
-- ORDER BY do not provide an ordering contract.
create or replace function crm_private.consultation_reminder_action_urls(p_body text)
returns text[]
language sql immutable
set search_path = pg_catalog
as $$
  select coalesce(
    array_agg(x.link[1] order by x.position),
    array[]::text[]
  )
  from regexp_matches(
    coalesce(p_body,''),
    '(https://booking[.]vishartattoo[.]com/appointments/respond/[0-9a-f]{64})',
    'g'
  ) with ordinality as x(link, position);
$$;

do $ordered_capabilities$
declare
  v_definition text := pg_get_functiondef(
    'crm_private.decorate_consultation_reminder_email()'::regprocedure
  );
  v_before text := $before$
  select array_agg(x.link[1]) into v_links
    from regexp_matches(
      coalesce(new.body,''),
      '(https://booking[.]vishartattoo[.]com/appointments/respond/[0-9a-f]{64})',
      'g'
    ) as x(link);
$before$;
  v_after text := $after$
  v_links := crm_private.consultation_reminder_action_urls(new.body);
$after$;
begin
  if position(v_before in v_definition)=0 then
    raise exception 'Unexpected consultation email decorator. Refusing unordered capability patch.'
      using errcode='23514';
  end if;
  execute replace(v_definition,v_before,v_after);
end;
$ordered_capabilities$;

revoke all on function crm_private.consultation_reminder_action_urls(text)
  from public, anon, authenticated, service_role;
