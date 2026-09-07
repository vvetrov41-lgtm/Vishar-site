-- Preserve legacy SQLSTATEs while booking refusals also carry machine-readable HINT codes.
--
-- The enquiry/client mismatch historically surfaced as 23514. The first
-- auto-project booking migration added ENQUIRY_LINK_MISMATCH in HINT but one
-- preflight call used booking_error's generic 22023 default. Keep the new code
-- without changing the established SQLSTATE contract used by existing callers.

create or replace function crm_private.booking_error(
  p_code text,
  p_message text,
  p_sqlstate text default '22023'
)
returns void
language plpgsql
stable
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_sqlstate text := p_sqlstate;
begin
  if p_code = 'ENQUIRY_LINK_MISMATCH' and p_sqlstate = '22023' then
    v_sqlstate := '23514';
  end if;

  raise exception using
    errcode = v_sqlstate,
    message = p_message,
    hint = p_code;
end;
$$;

comment on function crm_private.booking_error(text, text, text) is
  'Raise a booking refusal with a machine-readable HINT while preserving established SQLSTATE contracts.';
