-- 0065_gpt_monzo_reconciliation.sql
--
-- Expose the existing reviewed Monzo reconciliation workflow to Custom GPTs
-- without creating a second settlement path. The OAuth client_id remains the
-- authoritative artist route. GPT callers never supply artist_id or provider
-- identifiers. Match is non-financial; only the separate Confirm action may
-- settle a verified candidate through the existing reconciliation RPC.

create or replace function public.gpt_list_monzo_reconciliation_candidates()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;

  return public.list_monzo_reconciliation_candidates(v_artist_id);
end;
$$;

create or replace function public.gpt_match_monzo_reconciliation_candidate(
  p_candidate_id uuid,
  p_payment_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_candidate_artist uuid;
  v_request_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;

  select r.artist_id into v_candidate_artist
  from public.payment_reconciliation_candidates r
  where r.id = p_candidate_id;

  if v_candidate_artist is distinct from v_artist_id then
    raise exception 'reconciliation candidate is outside this GPT artist scope'
      using errcode = '42501';
  end if;

  select r.artist_id into v_request_artist
  from public.payment_requests r
  where r.id = p_payment_request_id;

  if v_request_artist is distinct from v_artist_id then
    raise exception 'payment request is outside this GPT artist scope'
      using errcode = '42501';
  end if;

  return public.match_monzo_reconciliation_candidate(
    p_candidate_id,
    p_payment_request_id
  );
end;
$$;

create or replace function public.gpt_ignore_monzo_reconciliation_candidate(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_candidate_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;

  select r.artist_id into v_candidate_artist
  from public.payment_reconciliation_candidates r
  where r.id = p_candidate_id;

  if v_candidate_artist is distinct from v_artist_id then
    raise exception 'reconciliation candidate is outside this GPT artist scope'
      using errcode = '42501';
  end if;

  return public.ignore_monzo_reconciliation_candidate(p_candidate_id);
end;
$$;

create or replace function public.gpt_confirm_monzo_reconciliation_candidate(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_candidate_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;

  select r.artist_id into v_candidate_artist
  from public.payment_reconciliation_candidates r
  where r.id = p_candidate_id;

  if v_candidate_artist is distinct from v_artist_id then
    raise exception 'reconciliation candidate is outside this GPT artist scope'
      using errcode = '42501';
  end if;

  return public.confirm_monzo_reconciliation_candidate(p_candidate_id);
end;
$$;

revoke all on function public.gpt_list_monzo_reconciliation_candidates()
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_ignore_monzo_reconciliation_candidate(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_confirm_monzo_reconciliation_candidate(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_list_monzo_reconciliation_candidates()
  to authenticated;
grant execute on function public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)
  to authenticated;
grant execute on function public.gpt_ignore_monzo_reconciliation_candidate(uuid)
  to authenticated;
grant execute on function public.gpt_confirm_monzo_reconciliation_candidate(uuid)
  to authenticated;

comment on function public.gpt_list_monzo_reconciliation_candidates() is
  'Lists PII-minimised Monzo reconciliation candidates for the artist bound to the GPT OAuth client.';
comment on function public.gpt_match_monzo_reconciliation_candidate(uuid,uuid) is
  'Matches a Monzo candidate to a payment request inside the GPT OAuth artist scope. This does not settle payment.';
comment on function public.gpt_ignore_monzo_reconciliation_candidate(uuid) is
  'Explicitly ignores a Monzo reconciliation candidate inside the GPT OAuth artist scope without settlement.';
comment on function public.gpt_confirm_monzo_reconciliation_candidate(uuid) is
  'Confirms an already matched Monzo reconciliation candidate inside the GPT OAuth artist scope through the existing authoritative settlement path.';
