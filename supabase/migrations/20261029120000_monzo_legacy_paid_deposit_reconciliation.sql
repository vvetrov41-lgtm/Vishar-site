-- Historical manually marked project deposits can precede a CRM payment request.
-- Recover a verified Monzo transfer exactly once into the existing immutable
-- ledger, only when the client, project and ONE session agree with the active
-- session tier. No synthetic bank events, new provider charges or notifications.

create or replace function crm_private.monzo_legacy_paid_deposit_options(p_candidate_id uuid)
returns jsonb language sql stable security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
  select coalesce(jsonb_agg(x.item order by x.distance_seconds, x.session_at), '[]'::jsonb)
  from (
    select abs(extract(epoch from (p.created_at-c.occurred_at))) as distance_seconds,
           s.start_at as session_at,
           jsonb_build_object(
             'project_id',p.id,'session_id',s.id,'client_name',cl.full_name,
             'project_title',p.title,'session_start_at',s.start_at,
             'amount',p.deposit_amount,'currency',p.currency
           ) as item
    from public.payment_reconciliation_candidates c
    join public.projects p on p.artist_id=c.artist_id
      and p.deposit_status='paid' and p.deposit_amount=c.amount
      and p.currency=c.currency and p.archived_at is null and p.status <> 'cancelled'
      and abs(extract(epoch from (p.created_at-c.occurred_at))) <= 604800
    join public.clients cl on cl.id=p.client_id
    join public.sessions s on s.project_id=p.id and s.artist_id=p.artist_id
      and s.status='confirmed' and s.appointment_type='tattoo_session'
    join lateral crm_private.resolve_session_deposit_tier(p.artist_id,s.id) tier
      on tier.amount=c.amount and tier.currency=c.currency
    where c.id=p_candidate_id
      and c.provider='monzo_easy_bank_transfer'
      and c.status in ('unmatched','ambiguous','candidate')
      and c.matched_payment_request_id is null
      and (select count(*) from public.sessions ss where ss.project_id=p.id)=1
      and not exists (select 1 from public.payment_requests r where r.project_id=p.id)
      and not exists (select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id=c.id)
      and not exists (select 1 from public.payment_transactions t
         where t.provider=c.provider and t.provider_transaction_id=c.provider_transaction_id)
    order by distance_seconds,s.start_at limit 20
  ) x;
$function$;
revoke all on function crm_private.monzo_legacy_paid_deposit_options(uuid) from public,anon,authenticated;

-- Fail closed if another rollout changed notification hooks.
do $guard$
begin
  if (select md5(pg_get_functiondef(p.oid)) from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='crm_private' and p.proname='queue_paid_deposit_confirmation')
      is distinct from '413beeb9de1a662904f652e82176a30f'
     or (select md5(pg_get_functiondef(p.oid)) from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='crm_private' and p.proname='refresh_booking_card_from_payment')
      is distinct from 'dbbd5050f6ef93f07a3b12e35e119df7' then
    raise exception 'legacy deposit migration aborted: notification hook drift' using errcode='23514';
  end if;
end;
$guard$;

create or replace function crm_private.queue_paid_deposit_confirmation()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare v_email_id uuid;
begin
  if new.purpose <> 'deposit' or new.status <> 'paid' or old.status='paid'
     or new.policy_snapshot->>'origin'='legacy_paid_project_reconciliation' then
    return new;
  end if;
  begin
    v_email_id:=crm_private.create_deposit_email(new.id,'deposit_confirmation');
    if v_email_id is not null then
      perform crm_private.enqueue_outbox(
        'approved_email'::public.outbox_kind,
        'email:deposit:' || new.id::text || ':confirmation',
        jsonb_build_object('email_message_id',v_email_id),
        new.client_id,null,new.project_id,new.session_id,v_email_id
      );
    end if;
  exception when others then
    raise warning 'deposit confirmation queue failed, sqlstate=%',sqlstate;
  end;
  return new;
end;
$function$;

create or replace function crm_private.refresh_booking_card_from_payment()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare v_session_id uuid;
begin
  -- Historical recovery must not send a second card to a client who already
  -- confirmed their booking.
  if new.policy_snapshot->>'origin'='legacy_paid_project_reconciliation' then
    return new;
  end if;
  begin
    if new.session_id is not null then
      perform crm_private.sync_booking_card(new.session_id);
    end if;
    for v_session_id in
      select m.session_id from public.session_deposit_groups g
      join public.session_deposit_group_members m on m.group_id=g.id
      where g.payment_request_id=new.id and m.released_at is null
    loop
      perform crm_private.sync_booking_card(v_session_id);
    end loop;
    if new.session_id is null and new.project_id is not null then
      perform crm_private.sync_project_booking_cards(new.project_id);
    end if;
  exception when others then
    raise warning 'booking card payment sync failed, sqlstate=%',sqlstate;
  end;
  return new;
end;
$function$;

-- Extend the existing scoped list without changing its prior matching logic.
create or replace function public.list_monzo_reconciliation_candidates(p_artist_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
declare
  v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_finance');

  select coalesce(jsonb_agg(q.item order by q.sort_rank, q.occurred_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      c.occurred_at,
      case
        when exists (
          select 1 from public.payment_transactions pt
          where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
            and pt.status = 'succeeded'
        ) or exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
        ) then 0
        when c.status = 'matched' then 1
        when c.status = 'candidate' then 2
        when c.status = 'ambiguous' then 3
        when c.status = 'unmatched' then 4
        else 5
      end as sort_rank,
      jsonb_build_object(
        'id', c.id,
        'amount', c.amount,
        'currency', c.currency,
        'occurred_at', c.occurred_at,
        'status', c.status,
        'confirmed', (
          exists (
            select 1 from public.payment_transactions pt
            where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
              and pt.status = 'succeeded'
          ) or exists (
            select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
          )
        ),
        'linked_existing_receipt', exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
        ),
        'suggested_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.suggested_payment_request_id),
        'matched_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.matched_payment_request_id),
        'match_options', crm_private.monzo_reconciliation_match_options(c.id),
        'recorded_receipt_options', crm_private.monzo_recorded_receipt_options(c.id),
        'legacy_paid_deposit_options', crm_private.monzo_legacy_paid_deposit_options(c.id)
      ) as item
    from public.payment_reconciliation_candidates c
    where c.artist_id = p_artist_id
      and c.provider = 'monzo_easy_bank_transfer'
    order by
      case
        when exists (
          select 1 from public.payment_transactions pt
          where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
            and pt.status = 'succeeded'
        ) or exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
        ) then 0
        when c.status = 'matched' then 1
        when c.status = 'candidate' then 2
        when c.status = 'ambiguous' then 3
        when c.status = 'unmatched' then 4
        else 5
      end,
      c.occurred_at desc
    limit 50
  ) q;

  return v_result;
end;
$function$;

create or replace function public.reconcile_monzo_legacy_paid_deposit(
  p_candidate_id uuid, p_session_id uuid
) returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_session public.sessions%rowtype;
  v_project public.projects%rowtype;
  v_event public.payment_webhook_events%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_previous_request public.payment_requests%rowtype;
  v_tier record;
  v_request_id uuid;
  v_result jsonb;
begin
  if p_candidate_id is null or p_session_id is null then
    raise exception 'bank transfer and session are required' using errcode='22023';
  end if;
  select * into v_candidate from public.payment_reconciliation_candidates
    where id=p_candidate_id for update;
  if not found or v_candidate.provider<>'monzo_easy_bank_transfer' then
    raise exception 'verified Monzo transfer not found' using errcode='23503';
  end if;
  perform crm_private.require_artist_access(v_candidate.artist_id,'manage_finance');
  perform crm_private.require_active_artist(v_candidate.artist_id);

  -- A retry can return the existing immutable provider receipt, never post it again.
  select * into v_existing from public.payment_transactions t
    where t.provider=v_candidate.provider
      and t.provider_transaction_id=v_candidate.provider_transaction_id;
  if found then
    select * into v_previous_request from public.payment_requests
      where id=v_existing.payment_request_id;
    if v_previous_request.artist_id<>v_candidate.artist_id
       or v_previous_request.session_id is distinct from p_session_id
       or v_previous_request.policy_snapshot->>'origin'<>'legacy_paid_project_reconciliation'
       or v_existing.idempotency_key<>v_candidate.id
       or v_existing.status<>'succeeded'
       or v_existing.amount<>v_candidate.amount
       or v_existing.currency<>v_candidate.currency then
      raise exception 'bank transfer belongs to another receipt' using errcode='23514';
    end if;
    return jsonb_build_object('candidate_id',v_candidate.id,
      'payment_request_id',v_previous_request.id,
      'payment_transaction_id',v_existing.id,'confirmed',true,'replayed',true);
  end if;

  if v_candidate.status not in ('unmatched','ambiguous','candidate')
     or v_candidate.matched_payment_request_id is not null
     or exists (select 1 from public.monzo_recorded_receipt_links lr
       where lr.candidate_id=v_candidate.id) then
    raise exception 'bank transfer is already assigned' using errcode='22023';
  end if;
  select * into v_event from public.payment_webhook_events
    where provider=v_candidate.provider
      and provider_event_id=v_candidate.provider_event_id for update;
  if not found or v_event.artist_id<>v_candidate.artist_id
     or v_event.provider_account_key<>v_candidate.provider_account_key
     or v_event.processing_status<>'succeeded' then
    raise exception 'verified bank evidence is missing or mismatched' using errcode='23514';
  end if;

  select * into v_session from public.sessions where id=p_session_id for update;
  if not found or v_session.artist_id<>v_candidate.artist_id
     or v_session.project_id is null or v_session.status<>'confirmed'
     or v_session.appointment_type<>'tattoo_session' then
    raise exception 'eligible confirmed session not found' using errcode='22023';
  end if;
  select * into v_project from public.projects
    where id=v_session.project_id for update;
  if not found or v_project.artist_id<>v_candidate.artist_id
     or v_project.deposit_status<>'paid'
     or v_project.deposit_amount<>v_candidate.amount
     or v_project.currency<>v_candidate.currency
     or v_project.archived_at is not null or v_project.status='cancelled'
     or abs(extract(epoch from (v_project.created_at-v_candidate.occurred_at)))>604800
     or (select count(*) from public.sessions s where s.project_id=v_project.id)<>1
     or exists (select 1 from public.payment_requests r where r.project_id=v_project.id) then
    raise exception 'project does not have an unrecorded matching paid deposit' using errcode='22023';
  end if;
  select * into v_tier from crm_private.resolve_session_deposit_tier(v_project.artist_id,v_session.id);
  if not found or v_tier.amount<>v_candidate.amount or v_tier.currency<>v_candidate.currency then
    raise exception 'historical deposit does not match the session policy' using errcode='22023';
  end if;
  if exists (select 1 from public.payment_transactions t where t.idempotency_key=v_candidate.id)
     or exists (select 1 from public.payment_requests r where r.idempotency_key=v_candidate.id) then
    raise exception 'bank transfer idempotency key was used previously' using errcode='23514';
  end if;

  insert into public.payment_requests(
    idempotency_key,artist_id,client_id,project_id,session_id,
    purpose,amount,currency,provider,provider_account_key,
    policy_id,policy_version,policy_snapshot,created_by
  ) values (
    v_candidate.id,v_candidate.artist_id,v_project.client_id,v_project.id,v_session.id,
    'deposit',v_candidate.amount,v_candidate.currency,v_candidate.provider,
    v_candidate.provider_account_key,v_tier.policy_id,v_tier.policy_version,
    jsonb_build_object('origin','legacy_paid_project_reconciliation','client_already_notified',true),
    auth.uid()
  ) returning id into v_request_id;

  update public.payment_reconciliation_candidates
     set status='matched',matched_payment_request_id=v_request_id,
         suggested_payment_request_id=null,updated_at=now()
   where id=v_candidate.id;

  v_result:=public.confirm_monzo_reconciliation_candidate(v_candidate.id);
  return v_result || jsonb_build_object('legacy_project_deposit',true);
end;
$function$;
revoke all on function public.reconcile_monzo_legacy_paid_deposit(uuid,uuid)
  from public,anon,service_role;
grant execute on function public.reconcile_monzo_legacy_paid_deposit(uuid,uuid) to authenticated;
