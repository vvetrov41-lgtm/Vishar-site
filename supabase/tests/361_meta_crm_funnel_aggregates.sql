begin;
select plan(24);

select has_function('public', 'service_meta_crm_funnel', array['text','date','date'],
  'funnel aggregate RPC exists');
select is(has_function_privilege('anon', 'public.service_meta_crm_funnel(text,date,date)', 'EXECUTE'), false,
  'anon cannot call the funnel RPC');
select is(has_function_privilege('authenticated', 'public.service_meta_crm_funnel(text,date,date)', 'EXECUTE'), false,
  'authenticated CRM users cannot call the funnel RPC');
select is(has_function_privilege('service_role', 'public.service_meta_crm_funnel(text,date,date)', 'EXECUTE'), true,
  'only the service backend can call it');
select ok((select prosecdef from pg_proc where oid = 'public.service_meta_crm_funnel(text,date,date)'::regprocedure),
  'runs as security definer');
select ok((select proconfig::text like '%search_path=pg_catalog, public, crm_private%' from pg_proc
  where oid = 'public.service_meta_crm_funnel(text,date,date)'::regprocedure), 'fixed search_path');

-- Without the service role claim it refuses.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.service_meta_crm_funnel('2128002004809955', '2026-10-01', '2026-10-31') $$,
  '42501', null, 'non-service callers are refused');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.service_meta_crm_funnel('act_2128002004809955', '2026-10-01', '2026-10-31') $$,
  '22023', null, 'the account is digits only');
select throws_ok($$ select public.service_meta_crm_funnel('2128002004809955', '2026-07-01', '2026-10-31') $$,
  '22023', null, 'at most 90 days');
select throws_ok($$ select public.service_meta_crm_funnel('899170029105750', '2026-10-01', '2026-10-31') $$,
  'P0002', null, 'an account without a verified registry row is refused (no artist fallback)');

-- Three consented paid enquiries on one ad and day, one excluded from analytics, one
-- unconsented enquiry with the same UTMs: only the two counted rows remain, so the
-- enquiry count (2) is suppressed.
create temporary table funnel_fixture (n int, enquiry_id uuid);
do $$
declare i int; r jsonb; v_id uuid; v_key uuid;
begin
  for i in 1..4 loop
    v_key := ('bbbbbbbb-4444-4444-8444-00000000000' || i)::uuid;
    r := public.create_enquiry_intake(v_key,
      jsonb_build_object('full_name','Funnel Test '||i,'email','funnel'||i||'@example.test','preferred_contact','Email'),
      jsonb_build_object('project_type','Black and grey realism','placement','Forearm','approximate_size','20 cm',
        'cover_up','No','preferred_timing','Flexible','idea','Tattoo test, not sent to Meta','source','/booking/',
        'landing_page','https://vishartattoo.com/booking/','privacy_acknowledged',true,'privacy_notice_version','2026-09-14'),
      jsonb_build_array(jsonb_build_object('mime_type','image/jpeg','safe_extension','jpg','byte_size',2048,'original_filename','reference.jpg')));
    v_id := (r->>'enquiry_id')::uuid;
    perform public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f where f.enquiry_id = v_id;
    perform public.finalize_enquiry_intake(v_id);
    if i <= 3 then
      perform public.service_record_meta_attribution(v_id, v_key::text, true, null, null, 'https://vishartattoo.com/booking/');
    end if;
    perform public.service_record_enquiry_touch_attribution(v_id, v_key, true,
      jsonb_build_object('kind','utm','path','/booking/','referrerHost','facebook.com','utmSource','fb','utmMedium','paid',
        'utmCampaign','120247800617380778','utmContent','120248212423350778','utmTerm','120248210889150778',
        'observedAt',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      jsonb_build_object('kind','utm','path','/booking/','referrerHost','facebook.com','utmSource','fb','utmMedium','paid',
        'utmCampaign','120247800617380778','utmContent','120248212423350778','utmTerm','120248210889150778',
        'observedAt',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    insert into funnel_fixture values (i, v_id);
  end loop;
  update public.enquiries set excluded_from_analytics = true
  where id = (select enquiry_id from funnel_fixture where n = 3);
end $$;

create temporary table funnel_result as
select public.service_meta_crm_funnel('2128002004809955',
  (current_date - 2), (current_date + 2)) as j;

select is((select j->>'account_id' from funnel_result), 'act_2128002004809955', 'account echoed with act_ prefix');
select is((select jsonb_array_length(j->'rows') from funnel_result), 1, 'one ad-day row');
select is((select j->'rows'->0->'enquiries' from funnel_result), 'null'::jsonb,
  'two counted enquiries are suppressed to null (excluded and unconsented ones are not counted)');
select ok((select (j::text !~* 'example\.test|Funnel Test|bbbbbbbb') from funnel_result),
  'no names, emails or enquiry ids in the output');

-- Two consented enquiries stay suppressed even if the request covers the whole month.
select is((
  select public.service_meta_crm_funnel('2128002004809955',
    date_trunc('month', now() at time zone 'Africa/Cairo')::date,
    (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month - 1 day')::date)
    ->'campaign_totals'->0->'enquiries'
), 'null'::jsonb, 'monthly campaign total of two stays hidden');

-- Re-including the excluded test row gives three consented enquiries: shown, not suppressed.
update public.enquiries set excluded_from_analytics = false
where id = (select enquiry_id from funnel_fixture where n = 3);
create temporary table funnel_result_3 as
select public.service_meta_crm_funnel('2128002004809955', (current_date - 2), (current_date + 2)) as j;
select is((select (j->'rows'->0->>'enquiries')::int from funnel_result_3), 3,
  'three consented enquiries are counted; the unconsented fourth is not');
select is((select j->'rows'->0->>'ad_id' from funnel_result_3), '120248212423350778', 'grouped by numeric ad id');
select is((select (j->'rows'->0->>'deposits_count')::int from funnel_result_3), 0, 'zero stays zero, not null');

select is((
  select (public.service_meta_crm_funnel('2128002004809955',
    date_trunc('month', now() at time zone 'Africa/Cairo')::date,
    (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month - 1 day')::date)
    ->'campaign_totals'->0->>'enquiries')::int
), 3, 'three consented enquiries become visible for a complete month');
select ok((select not (j ? 'campaign_totals') from funnel_result_3),
  'partial date ranges never include campaign totals');

-- Complementary suppression: distinct, individually hidden daily ad cells.
-- Use deterministic account-local calendar days; this works near midnight,
-- DST changes and the first/last day of any month.
create temporary table funnel_shift as
select f.enquiry_id, f.n,
 timezone('Africa/Cairo', date_trunc('month',now() at time zone 'Africa/Cairo')
       + interval '10 days 12 hours'
       + (case when f.n=3 then 1 else 0 end)*interval '1 day') as event_at
from funnel_fixture f where f.n<=3;
update public.enquiries e set created_at = s.event_at
from funnel_shift s where e.id=s.enquiry_id;
update public.integration_outbox o
set payload=jsonb_set(o.payload,'{event_time}',
  to_jsonb((extract(epoch from s.event_at)::bigint)::text),true)
from funnel_shift s where o.enquiry_id=s.enquiry_id
  and o.kind='meta_conversion';

select is((
 select (public.service_meta_crm_funnel('2128002004809955',
    date_trunc('month',now() at time zone 'Africa/Cairo')::date,
    (date_trunc('month',now() at time zone 'Africa/Cairo') + interval '1 month - 1 day')::date)
    ->'campaign_totals'->0->>'enquiries')::int
),3,'two suppressed daily cells of sizes 2 and 1 can produce a safe monthly count of 3');
select ok((
 select bool_and(r.value->'enquiries'='null'::jsonb)
 from jsonb_array_elements((public.service_meta_crm_funnel('2128002004809955',
    date_trunc('month',now() at time zone 'Africa/Cairo')::date,
    (date_trunc('month',now() at time zone 'Africa/Cairo') + interval '1 month - 1 day')::date)
    ->'rows')) r(value)
),'both individual daily cells remain suppressed');

-- All three hidden cells of size 1 would be trivially inferred from a
-- monthly count of 3. Even with more than one hidden day, suppress it.
update public.enquiries e
set created_at = timezone('Africa/Cairo',date_trunc('month',now() at time zone 'Africa/Cairo')
                           + interval '12 days 12 hours')
where e.id=(select enquiry_id from funnel_fixture where n=3);
update public.integration_outbox o
set payload=jsonb_set(o.payload,'{event_time}',to_jsonb((
 extract(epoch from timezone('Africa/Cairo',
   date_trunc('month',now() at time zone 'Africa/Cairo') + interval '12 days 12 hours'))::bigint)::text),true)
where o.enquiry_id=(select enquiry_id from funnel_fixture where n=3)
 and o.kind='meta_conversion';
update public.enquiries e
set created_at = timezone('Africa/Cairo',date_trunc('month',now() at time zone 'Africa/Cairo')
                           + interval '11 days 12 hours')
where e.id=(select enquiry_id from funnel_fixture where n=2);
update public.integration_outbox o
set payload=jsonb_set(o.payload,'{event_time}',to_jsonb((
 extract(epoch from timezone('Africa/Cairo',
   date_trunc('month',now() at time zone 'Africa/Cairo') + interval '11 days 12 hours'))::bigint)::text),true)
where o.enquiry_id=(select enquiry_id from funnel_fixture where n=2)
 and o.kind='meta_conversion';

select is((
 select public.service_meta_crm_funnel('2128002004809955',
    date_trunc('month',now() at time zone 'Africa/Cairo')::date,
    (date_trunc('month',now() at time zone 'Africa/Cairo') + interval '1 month - 1 day')::date)
    ->'campaign_totals'->0->'enquiries'
), 'null'::jsonb,'extreme sum of three single-enquiry days remains suppressed');

-- Cross-metric P1 regression: no monthly consultation/project/deposit total
-- may be published over hidden daily cells. The Worker adds an independent
-- behavioural check with the [1,1,2] enquiries / [0,1,2] consultation case.
select ok((
  select pg_get_functiondef('public.service_meta_crm_funnel(text,date,date)'::regprocedure)
    like '%when d.consultations_hidden=0 then c.consultations else null end%'
   and pg_get_functiondef('public.service_meta_crm_funnel(text,date,date)'::regprocedure)
    like '%when d.projects_hidden=0 then c.confirmed_projects else null end%'
   and pg_get_functiondef('public.service_meta_crm_funnel(text,date,date)'::regprocedure)
    like '%when d.deposits_hidden=0 then c.deposits_count else null end%'
), 'monthly secondary metrics cannot combine with hidden ad/day cells to reveal an enquiry');

select * from finish();
rollback;
