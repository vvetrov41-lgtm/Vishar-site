-- 20260926120000_email_html_transport.sql
--
-- Add an optional HTML alternative to CRM email messages so booking cards can
-- render as visual emails while retaining the existing plain-text body as the
-- canonical fallback. Existing email rows and send paths remain valid.

alter table public.email_messages
  add column if not exists html_body text;

alter table public.email_messages
  drop constraint if exists email_messages_html_body_shape;

alter table public.email_messages
  add constraint email_messages_html_body_shape
  check (
    html_body is null
    or (
      btrim(html_body) <> ''
      and char_length(html_body) <= 30000
    )
  );

comment on column public.email_messages.html_body is
  'Optional reviewed HTML alternative for provider delivery. body remains the required plain-text fallback and canonical text representation.';

-- PostgreSQL cannot CREATE OR REPLACE a function when its OUT row type changes,
-- so replace the backend-only claim in one migration transaction.
drop function public.claim_email_outbox(text, integer, integer);

create function public.claim_email_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  email_message_id uuid,
  client_id uuid,
  enquiry_id uuid,
  integration_key text,
  mailbox_email text,
  to_email text,
  subject text,
  body text,
  html_body text,
  thread_context_id uuid,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_limit integer := coalesce(p_limit, 10);
  v_lease_seconds integer := coalesce(p_lease_seconds, 120);
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 20 or v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'invalid email claim bounds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind = 'approved_email'::public.outbox_kind
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ), leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id, l.artist_id, l.email_message_id, l.client_id, l.enquiry_id,
    i.integration_key, lower(btrim(i.external_account_label)),
    m.to_email, m.subject, m.body, m.html_body, m.gmail_thread_context_id,
    l.attempt_count, l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and m.client_id = l.client_id
      and m.status = 'approved'::public.email_message_status
      and lower(btrim(m.to_email)) = lower(btrim(cl.email))
      and i.id is not null
      and i.provider = 'google'
      and i.is_enabled
      and (m.gmail_thread_context_id is null or exists (
        select 1 from crm_private.gmail_thread_contexts gc
        where gc.id = m.gmail_thread_context_id
          and gc.artist_id = l.artist_id
          and gc.client_id = l.client_id
          and gc.enquiry_id = l.enquiry_id
      ))
    ) as job_valid
  from leased l
  left join public.email_messages m on m.id = l.email_message_id
  left join public.clients cl on cl.id = l.client_id
  left join public.artist_integrations i
    on i.artist_id = l.artist_id
   and i.integration_type = 'email'::public.artist_integration_type
   and i.provider = 'google'
   and i.is_enabled
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_email_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_email_outbox(text, integer, integer)
  to service_role;
