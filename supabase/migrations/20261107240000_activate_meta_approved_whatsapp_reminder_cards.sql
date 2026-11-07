-- Activate new first-person WhatsApp reminder cards ONLY after the real Meta
-- template-maintenance process has verified both v2 identities. No messages
-- are sent, replayed, enqueued, cancelled, or edited by this migration.
-- Clean CI fixtures have UNKNOWN candidate approvals: the function remains
-- inert there, and rollback-only pgTAP tests the approved path separately.

create or replace function crm_private.activate_approved_whatsapp_reminder_v2(
  p_artist_id uuid
) returns text
language plpgsql security invoker
set search_path=pg_catalog,public,crm_private
as $activate$
declare
  v_count integer;
  v_moved integer;
begin
  -- Deliberately non-generic: this rollout is only for Vladimir, never
  -- Kristina, and never changes consultation or aftercare templates.
  if p_artist_id is distinct from 'a1111111-1111-4111-8111-111111111111'::uuid
    or not exists (select 1 from public.artists a
      where a.id=p_artist_id and a.slug='vladimir')
  then
    raise exception 'unapproved reminder artist' using errcode='42501';
  end if;

  -- Serialize against the existing lifecycle enqueue function, which
  -- reads this registry without row-level locks. The enqueue transaction
  -- holds ACCESS SHARE on this table until it commits; ACCESS EXCLUSIVE
  -- therefore waits for every earlier v1 enqueue to finish and prevents
  -- new enqueue transactions reading v1 before promotion commits.
  -- Acquire it before row locks to avoid lock-order deadlocks. The table is
  -- small, and this migration does not call any network provider.
  lock table crm_private.lifecycle_whatsapp_template_registry
    in access exclusive mode;

  -- Lock both source and target rows before checking provider evidence.
  perform 1 from crm_private.lifecycle_whatsapp_template_registry t
    where t.artist_id=p_artist_id
      and t.purpose in ('session_reminder_72h','session_reminder_24h')
    for update;
  perform 1 from crm_private.lifecycle_whatsapp_template_candidates c
    where c.artist_id=p_artist_id
      and c.purpose in ('session_reminder_72h','session_reminder_24h')
    for update;

  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_registry t
  where t.artist_id=p_artist_id
    and ((t.purpose='session_reminder_72h'
      and t.template_name='vishar_lifecycle_reminder_72h_v2')
      or (t.purpose='session_reminder_24h'
      and t.template_name='vishar_lifecycle_reminder_24h_v2'))
    and t.approval_status='APPROVED'
    and t.provider_template_id is not null;
  if v_count=2 then
    return 'already_active';
  end if;

  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_candidates c
  where c.artist_id=p_artist_id
    and ((c.purpose='session_reminder_72h'
      and c.template_name='vishar_lifecycle_reminder_72h_v2')
      or (c.purpose='session_reminder_24h'
      and c.template_name='vishar_lifecycle_reminder_24h_v2'))
    and c.template_language='en_GB'
    and c.approval_status='APPROVED'
    and c.provider_template_id is not null
    and c.verified_at > now()-interval '24 hours'
    -- Historical transient errors do not supersede a newer Meta APPROVED
    -- response with a real provider ID and recent verified_at timestamp.
    ;
  if v_count<>2 then
    return 'waiting_for_meta_approval';
  end if;

  -- Fail closed if another agent already changed a live template identity.
  select count(*) into v_count
  from crm_private.lifecycle_whatsapp_template_registry t
  where t.artist_id=p_artist_id
    and t.template_language='en_GB'
    and t.approval_status='APPROVED'
    and t.provider_template_id is not null
    and ((t.purpose='session_reminder_72h'
      and t.template_name='vishar_lifecycle_reminder_72h_v1')
      or (t.purpose='session_reminder_24h'
      and t.template_name='vishar_lifecycle_reminder_24h_v1'));
  if v_count<>2 then
    raise exception 'old WhatsApp reminder registry drifted'
      using errcode='23514';
  end if;

  -- Queued v1 outbox items would be rejected by the template-identity gate
  -- if the old identity were switched before provider acknowledgement.
  if exists (
    select 1 from crm_private.lifecycle_whatsapp_payloads p
    join public.integration_outbox o
      on o.communication_message_id=p.communication_message_id
    where p.artist_id=p_artist_id
      and p.purpose in ('session_reminder_72h','session_reminder_24h')
      and p.template_name like 'vishar_lifecycle_reminder_%_v1'
      and o.status in ('pending'::public.outbox_status,
                       'leased'::public.outbox_status)
  ) then
    raise exception 'WhatsApp v1 outbox remains in flight'
      using errcode='23514';
  end if;

  update crm_private.lifecycle_whatsapp_template_registry t
  set template_name=c.template_name,
      template_language=c.template_language,
      approval_status=c.approval_status,
      provider_template_id=c.provider_template_id,
      verified_at=c.verified_at,
      next_retry_at=null,
      last_failure_code=null,
      updated_at=now()
  from crm_private.lifecycle_whatsapp_template_candidates c
  where t.artist_id=p_artist_id and c.artist_id=t.artist_id
    and t.purpose=c.purpose
    and t.purpose in ('session_reminder_72h','session_reminder_24h')
    and c.approval_status='APPROVED';
  get diagnostics v_moved=row_count;
  if v_moved<>2 then
    raise exception 'unexpected WhatsApp reminder promotion count'
      using errcode='23514';
  end if;

  -- A promoted candidate is now an active provider target. Remove the
  -- preapproval shadow to avoid duplicate Meta maintenance claims.
  delete from crm_private.lifecycle_whatsapp_template_candidates c
  where c.artist_id=p_artist_id
    and c.purpose in ('session_reminder_72h','session_reminder_24h');
  get diagnostics v_moved=row_count;
  if v_moved<>2 then
    raise exception 'WhatsApp reminder candidate cleanup drifted'
      using errcode='23514';
  end if;
  return 'activated';
end;
$activate$;

revoke all on function crm_private.activate_approved_whatsapp_reminder_v2(uuid)
  from public,anon,authenticated,service_role;

-- Local CI: safe no-op until explicit simulated approval in rollback tests.
-- Production: candidate identities have real Meta approval IDs and will be
-- atomically promoted if no old outbound reminder remains unacknowledged.
select crm_private.activate_approved_whatsapp_reminder_v2(
  'a1111111-1111-4111-8111-111111111111'::uuid
);
