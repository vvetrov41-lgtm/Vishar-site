begin;
select plan(16);

select has_table('crm_private', 'meta_ad_account_identity', 'private Meta account registry exists');
select ok((select relrowsecurity from pg_class where oid='crm_private.meta_ad_account_identity'::regclass),
  'Meta account registry has RLS');
select is(has_table_privilege('authenticated','crm_private.meta_ad_account_identity','SELECT'),false,
  'untrusted clients cannot read advertiser account mapping');
select has_column('crm_private','enquiry_meta_attribution','campaign_id','consented attribution stores campaign ID');
select has_column('crm_private','enquiry_meta_attribution','adset_id','consented attribution stores ad set ID');
select has_column('crm_private','enquiry_meta_attribution','ad_id','consented attribution stores ad ID');
select has_view('crm_private','meta_enquiry_reconciliation','private reconciliation projection exists');
select is(has_table_privilege('authenticated','crm_private.meta_enquiry_reconciliation','SELECT'),false,
  'reconciliation is not exposed to authenticated clients');
select is(
  (crm_private.meta_paid_utm_ids('ig','paid','120247800617380778','120248210889150778','120248212423350778')->>'ad_id'),
  '120248212423350778', 'a paid Instagram ad has deterministic numeric identity');
select is(
  (crm_private.meta_paid_utm_ids('fb','paid','120247800617380778','120248210889150778','120248212423350778')->>'campaign_id'),
  '120247800617380778', 'paid Facebook identity also works');
select is(
  crm_private.meta_paid_utm_ids('ig','social','120247800617380778','120248210889150778','120248212423350778'),
  '{}'::jsonb, 'organic social links are never misattributed to ads');
select is(
  crm_private.meta_paid_utm_ids('fb','paid',null,null,'120248212423350778'),
  '{}'::jsonb, 'a partial ad ID without a campaign is not claimed');
select is(
  (crm_private.meta_paid_utm_ids('fb','paid','120247800617380778','untrusted','120248212423350778')->>'adset_id') is null,
  true, 'invalid ad set values are dropped without losing the validated campaign');
select is(
  ('2026-10-24 22:30:00+00'::timestamptz at time zone 'Africa/Cairo')::date,
  '2026-10-25'::date, 'Meta Cairo day may be later than UTC day');
select is(
  ('2026-10-24 22:30:00+00'::timestamptz at time zone 'Europe/London')::date,
  '2026-10-24'::date, 'London BST is converted independently of Cairo');
select is(
  ('2026-10-30 22:30:00+00'::timestamptz at time zone 'Africa/Cairo')::date,
  '2026-10-31'::date, 'Cairo offset follows IANA autumn transition, not hard-coded +3');

select * from finish();
rollback;
