-- Promote only the real Meta-approved first-person consultation card.
-- Never create sessions, clients, reminders, payments or sends here.
-- Original v1 stays available at Meta for a guarded rollback.
create or replace function crm_private.activate_approved_consultation_whatsapp_card(
 p_artist_id uuid
) returns text language plpgsql security invoker
set search_path=pg_catalog,public,crm_private
as $fn$
declare
  v_count integer;
begin
  if p_artist_id is distinct from 'a1111111-1111-4111-8111-111111111111'::uuid
     or not exists(select 1 from public.artists a where a.id=p_artist_id and a.slug='vladimir')
  then
    raise exception 'unapproved consultation artist' using errcode='42501';
  end if;

  -- Serialize against the lifecycle enqueue transaction so no v1 payload is
  -- produced after preflight and before the registry switches.
  lock table crm_private.lifecycle_whatsapp_template_registry in access exclusive mode;
  perform 1 from crm_private.lifecycle_whatsapp_template_registry r
    where r.artist_id=p_artist_id and r.purpose='consultation_reminder'
    for update;
  perform 1 from crm_private.lifecycle_whatsapp_template_candidates c
    where c.artist_id=p_artist_id and c.purpose='consultation_reminder'
    for update;

  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_registry r
  where r.artist_id=p_artist_id and r.purpose='consultation_reminder'
    and r.template_name='vishar_lifecycle_consultation_v2'
    and r.template_language='en_GB'
    and r.approval_status='APPROVED'
    and r.provider_template_id is not null;
  if v_count=1 then return 'already_active'; end if;

  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_candidates c
  where c.artist_id=p_artist_id and c.purpose='consultation_reminder'
    and c.template_name='vishar_lifecycle_consultation_v2'
    and c.template_language='en_GB'
    and c.approval_status='APPROVED'
    and c.provider_template_id is not null
    and c.verified_at > now()-interval '24 hours';
  if v_count<>1 then return 'waiting_for_meta_approval'; end if;

  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_registry r
  where r.artist_id=p_artist_id and r.purpose='consultation_reminder'
    and r.template_name='vishar_lifecycle_consultation_v1'
    and r.template_language='en_GB'
    and r.approval_status='APPROVED'
    and r.provider_template_id is not null;
  if v_count<>1 then
    raise exception 'consultation v1 provider identity drifted' using errcode='23514';
  end if;

  if exists (
    select 1 from crm_private.lifecycle_whatsapp_payloads p
    join public.integration_outbox o on o.communication_message_id=p.communication_message_id
    where p.artist_id=p_artist_id and p.purpose='consultation_reminder'
      and p.template_name='vishar_lifecycle_consultation_v1'
      and o.status in ('pending'::public.outbox_status,'leased'::public.outbox_status)
  ) then
    raise exception 'consultation v1 outbox in flight' using errcode='23514';
  end if;

  update crm_private.lifecycle_whatsapp_template_registry r
     set template_name=c.template_name,
         template_language=c.template_language,
         approval_status=c.approval_status,
         provider_template_id=c.provider_template_id,
         verified_at=c.verified_at,
         next_retry_at=null,last_failure_code=null,updated_at=now()
  from crm_private.lifecycle_whatsapp_template_candidates c
  where r.artist_id=p_artist_id and c.artist_id=r.artist_id
    and r.purpose='consultation_reminder' and c.purpose=r.purpose
    and c.template_name='vishar_lifecycle_consultation_v2'
    and c.approval_status='APPROVED';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'unexpected consultation activation count' using errcode='23514'; end if;

  delete from crm_private.lifecycle_whatsapp_template_candidates c
  where c.artist_id=p_artist_id and c.purpose='consultation_reminder'
    and c.template_name='vishar_lifecycle_consultation_v2';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'consultation candidate cleanup drifted' using errcode='23514'; end if;
  return 'activated';
end;
$fn$;
revoke all on function crm_private.activate_approved_consultation_whatsapp_card(uuid)
  from public,anon,authenticated,service_role;

select crm_private.activate_approved_consultation_whatsapp_card(
 'a1111111-1111-4111-8111-111111111111'::uuid
);
