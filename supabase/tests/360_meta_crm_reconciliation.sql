begin;
select plan(22);

select has_table('crm_private', 'meta_ad_account_identity', 'private Meta account registry exists');
select ok((select relrowsecurity from pg_class where oid='crm_private.meta_ad_account_identity'::regclass),
  'Meta account registry has RLS');
select is(has_table_privilege('authenticated','crm_private.meta_ad_account_identity','SELECT'),false,
  'untrusted clients cannot read advertiser account mapping');
select has_column('crm_private','enquiry_meta_attribution','campaign_id','consented attribution stores campaign ID');
select has_column('crm_private','enquiry_meta_attribution','adset_id','consented attribution stores ad set ID');
select has_column('crm_private','enquiry_meta_attribution','ad_id','consented attribution stores ad ID');
select has_view('crm_private','meta_enquiry_reconciliation','private reconciliation projection exists');
select has_trigger('crm_private','enquiry_touch_attribution','meta_identity_late_touch','late consented touches are reconciled');
select is(has_function_privilege('authenticated','crm_private.fill_meta_identity_after_touch()','EXECUTE'),false,
  'late-touch reconciler cannot be executed by authenticated clients');
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

-- Real ordering regression: Meta consent RPC arrives before the separate
-- consented touch RPC. The new touch row must fill missing ad identity without
-- changing the Lead event ID or creating a duplicate Meta Lead.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table meta_late_touch_fixture as
select public.create_enquiry_intake(
  'aaaaaaaa-3333-4333-8333-333333333333',
  jsonb_build_object(
    'full_name','Meta Reconciliation Test',
    'email','meta.reconciliation@example.test',
    'phone','+44 7700 900123',
    'preferred_contact','Email'
  ),
  jsonb_build_object(
    'project_type','Black and grey realism',
    'placement','Forearm','approximate_size','20 cm',
    'cover_up','No','preferred_timing','Flexible',
    'idea','Tattoo test, not sent to Meta',
    'source','/booking/',
    'landing_page','https://vishartattoo.com/booking/',
    'privacy_acknowledged',true,
    'privacy_notice_version','2026-09-14'
  ),
  jsonb_build_array(jsonb_build_object(
    'mime_type','image/jpeg','safe_extension','jpg',
    'byte_size',2048,'original_filename','reference.jpg'
  ))
) as r;
select public.mark_enquiry_file_uploaded(id)
from public.enquiry_files
where enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture);
select public.finalize_enquiry_intake(
  (select (r->>'enquiry_id')::uuid from meta_late_touch_fixture)
);
select public.service_record_meta_attribution(
  (select (r->>'enquiry_id')::uuid from meta_late_touch_fixture),
  'aaaaaaaa-3333-4333-8333-333333333333',
  true,null,null,'https://vishartattoo.com/booking/'
);
select is(
  (select campaign_id from crm_private.enquiry_meta_attribution
    where enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture)),
  null::text, 'Meta consent without paid UTM retains unknown ad identity'
);
create temporary table meta_late_touch_before as
select count(*)::integer as lead_jobs
from public.integration_outbox
where kind = 'meta_conversion'
  and payload->>'event_name' = 'Lead'
  and enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture);

with captured as (
  select jsonb_build_object(
    'kind','utm',
    'path','/booking/',
    'referrerHost','facebook.com',
    'utmSource','fb','utmMedium','paid',
    'utmCampaign','120247800617380778',
    'utmContent','120248212423350778',
    'utmTerm','120248210889150778',
    'observedAt',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) as touch
)
select public.service_record_enquiry_touch_attribution(
  (select (r->>'enquiry_id')::uuid from meta_late_touch_fixture),
  'aaaaaaaa-3333-4333-8333-333333333333'::uuid,
  true, captured.touch, captured.touch
) from captured;

select is(
  (select ad_id from crm_private.enquiry_meta_attribution
    where enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture)),
  '120248212423350778', 'late consented paid touch fills Meta ad identity'
);
select is(
  (select ad_identity_source from crm_private.enquiry_meta_attribution
    where enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture)),
  'last_touch_utm', 'late touch is labelled as last-touch evidence'
);
select is(
  (select count(*)::integer from public.integration_outbox
    where kind = 'meta_conversion'
      and payload->>'event_name' = 'Lead'
      and enquiry_id=(select (r->>'enquiry_id')::uuid from meta_late_touch_fixture)),
  (select lead_jobs from meta_late_touch_before),
  'late attribution cannot enqueue duplicate Meta Lead'
);

select * from finish();
rollback;
