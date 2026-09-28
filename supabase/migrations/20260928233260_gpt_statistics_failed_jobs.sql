-- Unified GPT v2: the two CRM operator reads that are table/view reads rather
-- than RPCs: Statistics and the failed-delivery list.
--
-- The CRM reads the statistics_* views and integration_outbox directly under
-- RLS. These definer wrappers read the same sources for the active Artist
-- only, check the GPT ceiling and CRM capability explicitly, and return
-- aggregates or the same safe columns the CRM shows. Money totals are
-- included only when the human has view_finance for the Artist.

create or replace function public.gpt_get_statistics(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_finance boolean;
  v_result jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_enquiries');
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'statistics need a range of at most 400 days' using errcode = '22023';
  end if;
  v_finance := crm_private.has_artist_capability(v_ctx.artist_id, 'view_finance');

  v_result := jsonb_build_object(
    'artist_id', v_ctx.artist_id,
    'from', p_from,
    'to', p_to,
    'enquiries', (
      select jsonb_build_object(
        'total', count(*),
        'by_status', coalesce((select jsonb_object_agg(status, n) from (
          select e2.status::text as status, count(*) as n from public.statistics_enquiries e2
          where e2.artist_id = v_ctx.artist_id and e2.archived_at is null
            and e2.created_at >= p_from and e2.created_at < p_to group by 1) s), '{}'::jsonb),
        'by_source', coalesce((select jsonb_object_agg(src, n) from (
          select coalesce(e3.discovery_source, e3.source, 'unknown') as src, count(*) as n from public.statistics_enquiries e3
          where e3.artist_id = v_ctx.artist_id and e3.archived_at is null
            and e3.created_at >= p_from and e3.created_at < p_to group by 1) s), '{}'::jsonb))
      from public.statistics_enquiries e
      where e.artist_id = v_ctx.artist_id and e.archived_at is null
        and e.created_at >= p_from and e.created_at < p_to),
    'projects', (
      select jsonb_build_object('created', count(*))
      from public.statistics_projects p
      where p.artist_id = v_ctx.artist_id and p.created_at >= p_from and p.created_at < p_to),
    'sessions', (
      select jsonb_build_object(
        'total', count(*),
        'completed', count(*) filter (where s.status = 'completed'),
        'cancelled', count(*) filter (where s.status = 'cancelled'),
        'no_show', count(*) filter (where s.status = 'no_show'),
        'hours_completed', coalesce(sum(s.duration_hours) filter (where s.status = 'completed'), 0))
      from public.statistics_sessions s
      where s.artist_id = v_ctx.artist_id and s.start_at >= p_from and s.start_at < p_to)
  );

  if v_finance then
    v_result := v_result || jsonb_build_object('payments', (
      select jsonb_build_object(
        'received', coalesce(sum(t.amount) filter (where t.direction = 'credit' and t.status = 'succeeded'), 0),
        'refunded', coalesce(sum(t.amount) filter (where t.direction = 'debit' and t.status = 'succeeded'), 0),
        'currencies', coalesce(jsonb_agg(distinct t.currency) filter (where t.currency is not null), '[]'::jsonb))
      from public.statistics_payment_transactions t
      where t.artist_id = v_ctx.artist_id and t.occurred_at >= p_from and t.occurred_at < p_to),
      'payment_requests', (
      select jsonb_build_object(
        'requested', count(*),
        'paid', count(*) filter (where r.status = 'paid'),
        'open', count(*) filter (where r.status in ('pending', 'partially_paid')))
      from public.statistics_payment_requests r
      where r.artist_id = v_ctx.artist_id and r.created_at >= p_from and r.created_at < p_to));
  else
    v_result := v_result || jsonb_build_object('finance_hidden', true);
  end if;
  return v_result;
end;
$$;

create or replace function public.gpt_list_failed_deliveries(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'kind', o.kind, 'status', o.status, 'attempt_count', o.attempt_count,
      'max_attempts', o.max_attempts, 'next_attempt_at', o.next_attempt_at,
      'last_error_code', o.last_error_code, 'updated_at', o.updated_at) order by o.updated_at desc)
    from (
      select * from public.integration_outbox o2
      where o2.artist_id = v_ctx.artist_id and o2.status in ('failed', 'dead')
      order by o2.updated_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) o
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.gpt_get_statistics(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_failed_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.gpt_get_statistics(timestamptz, timestamptz) to authenticated;
grant execute on function public.gpt_list_failed_deliveries(integer) to authenticated;
