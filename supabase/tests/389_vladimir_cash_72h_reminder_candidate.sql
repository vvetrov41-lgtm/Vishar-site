-- The v5 72h reminder is inert until provider-approved, separately activated.
-- No real client messages or appointments are created.
begin;
select plan(9);

select is(
  (select count(*)::integer from crm_private.whatsapp_template_proposals
    where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      and kind='reminder_72h_cash'
      and template_name='vishar_lifecycle_reminder_72h_v5'
      and template_language='en_GB'),
  1,'one Vladimir-only cash reminder candidate');

select is(
  (select approval_status from crm_private.whatsapp_template_proposals
    where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      and kind='reminder_72h_cash'),
  'UNKNOWN'::text,'no fake Meta approval');

select ok(
  (select provider_template_id is null and verified_at is null
    from crm_private.whatsapp_template_proposals
    where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      and kind='reminder_72h_cash'),
  'candidate has no provider approval evidence');

select ok(
  not exists(select 1 from crm_private.whatsapp_template_proposals
    where artist_id='a2222222-2222-4222-8222-222222222222'::uuid
      and kind='reminder_72h_cash'),
  'Kristina has no cash reminder candidate');

select ok(
  not exists(select 1 from crm_private.lifecycle_whatsapp_template_registry
    where purpose='session_reminder_72h'
      and template_name='vishar_lifecycle_reminder_72h_v5'),
  'no artist routes live reminder to unapproved v5');

select ok(
  not exists(select 1 from crm_private.lifecycle_whatsapp_payloads
    where template_name='vishar_lifecycle_reminder_72h_v5'),
  'no persisted client message has v5');

select ok(
  has_function_privilege('service_role',
    'public.service_claim_whatsapp_template_proposals(integer)','execute'),
  'maintenance worker can read candidates via existing backend RPC');

select ok(
  not has_function_privilege('anon',
    'public.service_claim_whatsapp_template_proposals(integer)','execute')
  and not has_function_privilege('authenticated',
    'public.service_claim_whatsapp_template_proposals(integer)','execute'),
  'proposal maintenance RPC stays private');

select ok(
  not has_table_privilege('anon','crm_private.whatsapp_template_proposals','select')
  and not has_table_privilege('authenticated','crm_private.whatsapp_template_proposals','select'),
  'proposal table remains inaccessible to browser callers');

select * from finish(true);
rollback;
