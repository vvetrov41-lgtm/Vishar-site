-- 277_booking_time_step_error_code.sql
--
-- iPhone Safari may supply any minute for a consultation. Consultations accept
-- that native value, while tattoo sessions keep the five-minute invariant and
-- stable machine-readable refusal used by strict booking flows.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values (
  'bd211111-1111-4111-8111-111111111111',
  'Five Minute Client',
  'five-minute@example.test'
);

create function pg_temp.refusal_hint(p_sql text) returns text language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return coalesce(v_hint, '');
end;
$$;
grant execute on function pg_temp.refusal_hint(text) to service_role;

select lives_ok(
  $sql$
    insert into public.sessions (
      artist_id, client_id, appointment_type, status, start_at, end_at
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      'bd211111-1111-4111-8111-111111111111',
      'in_person_consultation', 'draft',
      '2030-01-08T10:03:00Z', '2030-01-08T10:33:00Z'
    )
  $sql$,
  'an in-person consultation accepts unrestricted native minutes'
);

select lives_ok(
  $sql$
    insert into public.sessions (
      artist_id, client_id, appointment_type, status, start_at, end_at
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      'bd211111-1111-4111-8111-111111111111',
      'video_consultation', 'draft',
      '2030-01-08T10:47:00Z', '2030-01-08T11:17:00Z'
    )
  $sql$,
  'a video consultation accepts unrestricted native minutes'
);

select is(
  pg_temp.refusal_hint($sql$
    insert into public.sessions (
      artist_id, client_id, appointment_type, status, start_at, end_at
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      'bd211111-1111-4111-8111-111111111111',
      'tattoo_session', 'draft',
      '2030-01-08T12:03:00Z', '2030-01-08T13:03:00Z'
    )
  $sql$),
  'INVALID_APPOINTMENT_STEP',
  'an off-grid tattoo session keeps the stable five-minute refusal code'
);

select lives_ok(
  $sql$
    insert into public.sessions (
      artist_id, client_id, appointment_type, status, start_at, end_at
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      'bd211111-1111-4111-8111-111111111111',
      'tattoo_session', 'draft',
      '2030-01-08T12:05:00Z', '2030-01-08T13:05:00Z'
    )
  $sql$,
  'a five-minute tattoo boundary is still accepted'
);

select * from finish();
rollback;
