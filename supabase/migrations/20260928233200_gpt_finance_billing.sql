-- Unified GPT v2: Project Finance and Billing & Reconciliation operator parity.
--
-- The Monzo destination and Easy Bank Transfer reads require manage_finance
-- because the CRM RPCs behind them do; view_finance alone would always fail.
--
-- Money actions keep every CRM rule: the CRM RPC owns amounts, policy,
-- idempotency keys and provider routing. The wrapper adds the GPT boundary:
-- registered client, active Artist context, finance ceiling, the human's
-- finance capability, and ownership of every record id.

-- --------------------------------------------------------- Project Finance

create or replace function public.gpt_get_deposit_policy()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'view_finance');
  return public.get_project_deposit_policy(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_configure_deposit_policy(
  p_mode text,
  p_fixed_amount numeric default null,
  p_percentage numeric default null,
  p_minimum_amount numeric default null,
  p_rounding_step numeric default 1.00
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.configure_project_deposit_policy(v_ctx.artist_id, p_mode, p_fixed_amount,
    p_percentage, p_minimum_amount, p_rounding_step);
end;
$$;

create or replace function crm_private.gpt_finance_project(p_project_id uuid, p_capability text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', p_capability);
  select p.artist_id into v_artist from public.projects p where p.id = p_project_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'project');
end;
$$;
revoke all on function crm_private.gpt_finance_project(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.gpt_preview_project_deposit(p_project_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_project(p_project_id, 'view_finance');
  return public.preview_project_deposit(p_project_id);
end;
$$;

create or replace function public.gpt_set_project_deposit_override(p_project_id uuid, p_amount numeric default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_project(p_project_id, 'manage_finance');
  return public.set_project_deposit_override(p_project_id, p_amount);
end;
$$;

create or replace function public.gpt_request_project_deposit(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_delivery_channel text default 'copy_link'
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_project(p_project_id, 'manage_finance');
  return public.request_project_deposit(p_project_id, p_idempotency_key, p_delivery_channel);
end;
$$;

create or replace function public.gpt_confirm_project_deposit_manually(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_occurred_at timestamptz default now()
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_project(p_project_id, 'manage_finance');
  return public.confirm_project_deposit_manually(p_project_id, p_idempotency_key, coalesce(p_occurred_at, now()));
end;
$$;

create or replace function public.gpt_request_grouped_session_deposit(
  p_session_ids uuid[],
  p_idempotency_key uuid,
  p_delivery_channel text default 'copy_link'
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_foreign integer;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  if p_session_ids is null or cardinality(p_session_ids) = 0 then
    raise exception 'at least one session is required' using errcode = '22023';
  end if;
  select count(*)::int into v_foreign
  from unnest(p_session_ids) requested(id)
  left join public.sessions s on s.id = requested.id
  where s.id is null or s.artist_id is distinct from v_ctx.artist_id;
  if v_foreign > 0 then
    raise exception 'a session is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  return public.request_grouped_session_deposit(p_session_ids, p_idempotency_key, p_delivery_channel);
end;
$$;

-- ------------------------------------------------ Billing & Reconciliation

create or replace function crm_private.gpt_finance_invoice(p_invoice_id uuid, p_capability text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', p_capability);
  select i.artist_id into v_artist from public.invoices i where i.id = p_invoice_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'invoice');
end;
$$;
revoke all on function crm_private.gpt_finance_invoice(uuid, text) from public, anon, authenticated, service_role;

create or replace function crm_private.gpt_finance_payment_request(p_payment_request_id uuid, p_capability text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', p_capability);
  select r.artist_id into v_artist from public.payment_requests r where r.id = p_payment_request_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'payment request');
  return v_ctx.artist_id;
end;
$$;
revoke all on function crm_private.gpt_finance_payment_request(uuid, text) from public, anon, authenticated, service_role;

create or replace function crm_private.gpt_finance_candidate(p_candidate_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  select c.artist_id into v_artist from public.payment_reconciliation_candidates c where c.id = p_candidate_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'reconciliation candidate');
  return v_ctx.artist_id;
end;
$$;
revoke all on function crm_private.gpt_finance_candidate(uuid) from public, anon, authenticated, service_role;

create or replace function public.gpt_list_invoices(
  p_project_id uuid default null,
  p_client_id uuid default null,
  p_status public.invoice_status default null,
  p_limit integer default 50
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'view_finance');
  return public.list_invoices(v_ctx.artist_id, p_project_id, p_client_id, p_status, least(greatest(coalesce(p_limit, 50), 1), 100));
end;
$$;

create or replace function public.gpt_get_invoice(p_invoice_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'view_finance');
  return public.get_invoice(p_invoice_id);
end;
$$;

create or replace function public.gpt_create_invoice(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_due_date date default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_project(p_project_id, 'manage_finance');
  return public.create_invoice(p_project_id, p_idempotency_key, p_due_date, p_notes);
end;
$$;

create or replace function public.gpt_set_invoice_line_item(
  p_invoice_id uuid,
  p_description text,
  p_quantity numeric,
  p_unit_amount numeric,
  p_line_item_id uuid default null,
  p_session_id uuid default null,
  p_line_position integer default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_line_invoice uuid; v_session_artist uuid; v_invoice_artist uuid;
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  if p_line_item_id is not null then
    select l.invoice_id into v_line_invoice from public.invoice_line_items l where l.id = p_line_item_id;
    if v_line_invoice is distinct from p_invoice_id then
      raise exception 'line item does not belong to this invoice' using errcode = '42501';
    end if;
  end if;
  if p_session_id is not null then
    select s.artist_id into v_session_artist from public.sessions s where s.id = p_session_id;
    select i.artist_id into v_invoice_artist from public.invoices i where i.id = p_invoice_id;
    perform crm_private.require_gpt_record_artist(v_session_artist, v_invoice_artist, 'session');
  end if;
  return public.set_invoice_line_item(p_invoice_id, p_description, p_quantity, p_unit_amount,
    p_line_item_id, p_session_id, p_line_position);
end;
$$;

create or replace function public.gpt_remove_invoice_line_item(p_line_item_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_invoice uuid;
begin
  select l.invoice_id into v_invoice from public.invoice_line_items l where l.id = p_line_item_id;
  if v_invoice is null then
    raise exception 'line item is outside the active GPT Artist scope' using errcode = '42501';
  end if;
  perform crm_private.gpt_finance_invoice(v_invoice, 'manage_finance');
  return public.remove_invoice_line_item(p_line_item_id);
end;
$$;

create or replace function public.gpt_set_invoice_details(
  p_invoice_id uuid,
  p_due_date date default null,
  p_discount_amount numeric default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  return public.set_invoice_details(p_invoice_id, p_due_date, p_discount_amount, p_notes);
end;
$$;

create or replace function public.gpt_issue_invoice(p_invoice_id uuid, p_issue_date date default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  return public.issue_invoice(p_invoice_id, p_issue_date);
end;
$$;

create or replace function public.gpt_void_invoice(p_invoice_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  return public.void_invoice(p_invoice_id, p_reason);
end;
$$;

create or replace function public.gpt_attach_payment_request_to_invoice(p_payment_request_id uuid, p_invoice_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  perform crm_private.gpt_finance_payment_request(p_payment_request_id, 'manage_finance');
  return public.attach_payment_request_to_invoice(p_payment_request_id, p_invoice_id);
end;
$$;

create or replace function public.gpt_record_invoice_payment(
  p_invoice_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_occurred_at timestamptz default now(),
  p_method_code text default null,
  p_external_reference text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  return public.record_invoice_payment(p_invoice_id, p_idempotency_key, p_amount,
    coalesce(p_occurred_at, now()), p_method_code, p_external_reference);
end;
$$;

create or replace function public.gpt_create_credit_note(
  p_invoice_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_reason text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_invoice(p_invoice_id, 'manage_finance');
  return public.create_credit_note(p_invoice_id, p_idempotency_key, p_amount, p_reason);
end;
$$;

create or replace function public.gpt_attach_monzo_payment_link(p_payment_request_id uuid, p_payment_url text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_payment_request(p_payment_request_id, 'manage_finance');
  return public.attach_monzo_one_off_payment_destination(p_payment_request_id, p_payment_url);
end;
$$;

create or replace function public.gpt_list_monzo_destinations()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.list_monzo_payment_destinations(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_upsert_monzo_destination(p_amount numeric, p_payment_url text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.upsert_monzo_payment_destination(v_ctx.artist_id, p_amount, p_payment_url);
end;
$$;

create or replace function public.gpt_archive_monzo_destination(p_destination_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  select d.artist_id into v_artist from public.monzo_payment_destinations d where d.id = p_destination_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'payment destination');
  return public.archive_monzo_payment_destination(p_destination_id);
end;
$$;

create or replace function public.gpt_get_monzo_transfer_settings()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.get_monzo_easy_bank_transfer_settings(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_configure_monzo_transfer_settings(p_payment_url text, p_is_enabled boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  return public.configure_monzo_easy_bank_transfer(v_ctx.artist_id, p_payment_url, coalesce(p_is_enabled, false));
end;
$$;

create or replace function public.gpt_list_monzo_reconciliation_candidates()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'view_finance');
  return public.list_monzo_reconciliation_candidates(v_ctx.artist_id);
end;
$$;

create or replace function public.gpt_match_monzo_reconciliation_candidate(p_candidate_id uuid, p_payment_request_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_candidate(p_candidate_id);
  perform crm_private.gpt_finance_payment_request(p_payment_request_id, 'manage_finance');
  return public.match_monzo_reconciliation_candidate(p_candidate_id, p_payment_request_id);
end;
$$;

create or replace function public.gpt_ignore_monzo_reconciliation_candidate(p_candidate_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_candidate(p_candidate_id);
  return public.ignore_monzo_reconciliation_candidate(p_candidate_id);
end;
$$;

create or replace function public.gpt_confirm_monzo_reconciliation_candidate(p_candidate_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.gpt_finance_candidate(p_candidate_id);
  return public.confirm_monzo_reconciliation_candidate(p_candidate_id);
end;
$$;

-- --------------------------------------------------------------------- grants

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.gpt_get_deposit_policy()',
    'public.gpt_configure_deposit_policy(text,numeric,numeric,numeric,numeric)',
    'public.gpt_preview_project_deposit(uuid)',
    'public.gpt_set_project_deposit_override(uuid,numeric)',
    'public.gpt_request_project_deposit(uuid,uuid,text)',
    'public.gpt_confirm_project_deposit_manually(uuid,uuid,timestamptz)',
    'public.gpt_request_grouped_session_deposit(uuid[],uuid,text)',
    'public.gpt_list_invoices(uuid,uuid,public.invoice_status,integer)',
    'public.gpt_get_invoice(uuid)',
    'public.gpt_create_invoice(uuid,uuid,date,text)',
    'public.gpt_set_invoice_line_item(uuid,text,numeric,numeric,uuid,uuid,integer)',
    'public.gpt_remove_invoice_line_item(uuid)',
    'public.gpt_set_invoice_details(uuid,date,numeric,text)',
    'public.gpt_issue_invoice(uuid,date)',
    'public.gpt_void_invoice(uuid,text)',
    'public.gpt_attach_payment_request_to_invoice(uuid,uuid)',
    'public.gpt_record_invoice_payment(uuid,uuid,numeric,timestamptz,text,text)',
    'public.gpt_create_credit_note(uuid,uuid,numeric,text)',
    'public.gpt_attach_monzo_payment_link(uuid,text)',
    'public.gpt_list_monzo_destinations()',
    'public.gpt_upsert_monzo_destination(numeric,text)',
    'public.gpt_archive_monzo_destination(uuid)',
    'public.gpt_get_monzo_transfer_settings()',
    'public.gpt_configure_monzo_transfer_settings(text,boolean)',
    'public.gpt_list_monzo_reconciliation_candidates()',
    'public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)',
    'public.gpt_ignore_monzo_reconciliation_candidate(uuid)',
    'public.gpt_confirm_monzo_reconciliation_candidate(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
