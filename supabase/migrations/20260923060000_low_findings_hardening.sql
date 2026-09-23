-- 20260923060000_low_findings_hardening.sql
--
-- Audit L-1 and L-2 (2026-09-22).
--   L-1: pin search_path on the two helpers the Supabase advisor flags, and
--        drop the exact duplicate partial index on follow_ups (0077 recreated
--        0005's index under a second name).
--   L-2: two authenticated RPCs answered questions about records the caller
--        cannot see. may_contact_client now answers false to a signed-in
--        caller for a client they cannot access - the same answer as for an
--        uncontactable client. queue_whatsapp_message keeps its documented
--        contract (a foreign conversation is refused with 42501), which
--        needs the conversation UUID and stays within one installation.

alter function crm_private.slugify(text) set search_path = pg_catalog, public;
alter function crm_private.capability_from_grant(public.crm_role, public.artist_access_level, boolean, boolean, boolean, boolean, text)
  set search_path = pg_catalog, public;

drop index if exists public.follow_ups_due_open_idx;

CREATE OR REPLACE FUNCTION public.may_contact_client(p_client_id uuid, p_channel message_template_channel, p_purpose text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_classification public.message_classification;
begin
  -- A client the caller cannot see gets the same answer as one that cannot
  -- be contacted, so the gate reveals nothing about other artists' clients.
  if auth.uid() is not null and not public.can_access_client(p_client_id) then
    return false;
  end if;

  -- The purpose decides the classification, so a caller cannot ask the gate to
  -- treat a promotion as service traffic by passing a different argument.
  select p.classification into v_classification
  from public.message_template_purposes p
  where p.purpose = p_purpose;

  if v_classification is null then
    raise exception 'unknown message purpose %', p_purpose using errcode = '22023';
  end if;

  return crm_private.client_send_block_reason(p_client_id, p_channel, v_classification) is null;
end;
$function$;
