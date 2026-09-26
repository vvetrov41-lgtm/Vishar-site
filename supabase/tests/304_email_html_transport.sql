-- 304_email_html_transport.sql
--
-- Optional HTML email alternatives remain backend-owned and the Gmail claim
-- exposes them without widening the claim RPC to browser roles.

begin;
select no_plan();

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_messages'
      and column_name = 'html_body'
      and data_type = 'text'
  ),
  'email_messages has an optional HTML body'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_email_outbox(text, integer, integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_email_outbox(text, integer, integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.claim_email_outbox(text, integer, integer)',
    'EXECUTE'
  ),
  'email outbox claiming remains backend-only'
);

select ok(
  position(
    'html_body text'
    in pg_get_function_result(
      'public.claim_email_outbox(text, integer, integer)'::regprocedure
    )
  ) > 0,
  'claim_email_outbox exposes html_body to the Gmail worker'
);

select * from finish();
rollback;
