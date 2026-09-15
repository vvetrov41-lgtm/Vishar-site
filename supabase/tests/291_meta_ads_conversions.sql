-- 291_meta_ads_conversions.sql
--
-- End-to-end database contract for consented Meta Ads attribution and durable
-- CRM conversion events. Provider credentials are intentionally outside SQL.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.meta_files()
returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'reference.jpg'
  ));
$$;

create function pg_temp.meta_enquiry_meta()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'project_type', 'Black and grey realism',
    'placement', 'Forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Private tattoo idea that must never enter Meta payloads.',
    'source', '/booking/',
    'landing_page', 'https://booking.vishartattoo.com/',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-09-14'
  );
$$;

-- Seed contract: Vladimir only, safe metadata only, disabled until the backend
-- secret is configured and production activation is deliberate.
select is(
  (select count(*)::int from public.artist_integrations
   where integration_type = 'meta_ads' and integration_key = 'meta_ads_vladimir'),
  1,
  'Vladimir has exactly one Meta Ads integration metadata row'
);

select ok(
  (select not is_enabled from public.artist_integrations
   where integration_type = 'meta_ads' and integration_key = 'meta_ads_vladimir'),
  'Meta Ads integration is disabled by default'
);

select is(
  (select configuration ->> 'dataset_id' from public.artist_integrations
   where integration_key = 'meta_ads_vladimir'),
  '1729215778134902',
  'Vladimir Meta integration points at the intended dataset'
);

select is(
  (select configuration ->> 'graph_api_version' from public.artist_integrations
   where integration_key = 'meta_ads_vladimir'),
  'v26.0',
  'Meta Graph API version is pinned explicitly'
);

select is(
  (select configuration ->> 'optimization_event' from public.artist_integrations
   where integration_key = 'meta_ads_vladimir'),
  'Lead',
  'campaign optimization remains the standard Lead event'
);

select ok(
  (select not (configuration ?| array['access_token','token','secret','test_event_code'])
   from public.artist_integrations where integration_key = 'meta_ads_vladimir'),
  'database integration metadata contains no Meta credential or test code'
);

select is(
  (select count(*)::int from public.artist_integrations i
   join public.artists a on a.id = i.artist_id
   where i.integration_type = 'meta_ads' and a.slug = 'kristina'),
  0,
  'Kristina does not inherit Vladimir Meta integration'
);

-- Create and finalise one real enquiry. No Meta event may exist yet because
-- attribution consent has not been recorded.
create temporary table meta_primary as
select public.create_enquiry_intake(
  'aaaaaaaa-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name', 'Meta Test Client',
    'email', ' META.TEST@Example.test ',
    'phone', '+44 7700 900123',
    'preferred_contact', 'Email'
  ),
  pg_temp.meta_enquiry_meta(),
  pg_temp.meta_files()
) as r;

select public.mark_enquiry_file_uploaded(f.id)
from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary);

select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from meta_primary));

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)),
  0,
  'no Meta conversion is queued before explicit Meta attribution consent'
);

-- Activation remains artist-scoped. Tests enable only Vladimir's metadata;
-- production still requires the separate backend secret and drain flag.
update public.artist_integrations
set is_enabled = true
where integration_key = 'meta_ads_vladimir';

select throws_ok(
  format(
    $$select public.service_record_meta_attribution(%L::uuid, %L, false, null, null, %L)$$,
    (select r ->> 'enquiry_id' from meta_primary),
    'aaaaaaaa-1111-4111-8111-111111111111',
    'https://booking.vishartattoo.com/'
  ),
  '22023', null,
  'Meta attribution refuses anything other than explicit granted consent'
);

select throws_ok(
  format(
    $$select public.service_record_meta_attribution(%L::uuid, %L, true, null, null, %L)$$,
    (select r ->> 'enquiry_id' from meta_primary),
    'bbbbbbbb-1111-4111-8111-111111111111',
    'https://booking.vishartattoo.com/'
  ),
  '23514', null,
  'Lead event id must equal the enquiry idempotency key'
);

create temporary table meta_first_touch as
select public.service_record_meta_attribution(
  (select (r ->> 'enquiry_id')::uuid from meta_primary),
  'aaaaaaaa-1111-4111-8111-111111111111',
  true,
  'fb.1.1789460000000.browser123',
  'fb.1.1789460000000.click123',
  'https://booking.vishartattoo.com/'
) as r;

select ok((select (r ->> 'recorded')::boolean from meta_first_touch),
          'first consented Meta attribution is recorded');

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'Lead'),
  1,
  'recording attribution after completed intake catches up exactly one Lead'
);

select is(
  (select payload ->> 'event_id' from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'Lead'),
  'aaaaaaaa-1111-4111-8111-111111111111',
  'server Lead uses the same idempotency UUID as browser eventID'
);

-- A replay with different browser identifiers/source must not overwrite the
-- first consented touch and must not duplicate Lead.
create temporary table meta_replay as
select public.service_record_meta_attribution(
  (select (r ->> 'enquiry_id')::uuid from meta_primary),
  'aaaaaaaa-1111-4111-8111-111111111111',
  true,
  'fb.1.1789460000001.otherbrowser',
  null,
  'https://vishartattoo.com/booking/'
) as r;

select ok((select not (r ->> 'recorded')::boolean from meta_replay),
          'replayed attribution does not replace first touch');
select ok((select (r ->> 'first_touch_preserved')::boolean from meta_replay),
          'replayed attribution reports first-touch preservation');
select is(
  (select fbp from crm_private.enquiry_meta_attribution
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)),
  'fb.1.1789460000000.browser123',
  'first-touch fbp is immutable'
);
select is(
  (select event_source_url from crm_private.enquiry_meta_attribution
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)),
  'https://booking.vishartattoo.com/',
  'first-touch source URL is immutable'
);
select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'Lead'),
  1,
  'attribution replay cannot duplicate Lead'
);

-- CRM lifecycle conversions are deterministic and idempotent.
update public.enquiries
set status = 'accepted'
where id = (select (r ->> 'enquiry_id')::uuid from meta_primary);

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'QualifiedLead'),
  1,
  'first accepted transition queues one QualifiedLead'
);
select is(
  (select payload ->> 'event_id' from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'QualifiedLead'),
  'qualified:' || (select r ->> 'enquiry_id' from meta_primary),
  'QualifiedLead event id is deterministic per enquiry'
);

update public.enquiries
set status = 'accepted'
where id = (select (r ->> 'enquiry_id')::uuid from meta_primary);
select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'QualifiedLead'),
  1,
  'repeated accepted state cannot duplicate QualifiedLead'
);

insert into public.projects (
  client_id, enquiry_id, artist_id, status, title, deposit_amount, deposit_status
)
select
  e.client_id, e.id, e.artist_id, 'draft', 'Meta conversion test project', 250, 'requested'
from public.enquiries e
where e.id = (select (r ->> 'enquiry_id')::uuid from meta_primary);

update public.projects
set deposit_status = 'paid'
where enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary);

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'BookedClient'),
  1,
  'first real project deposit-paid transition queues one BookedClient'
);
select is(
  (select payload ->> 'event_id' from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'BookedClient'),
  'booked:' || (select r ->> 'enquiry_id' from meta_primary),
  'BookedClient event id is deterministic per enquiry'
);

update public.projects
set deposit_status = 'paid'
where enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary);
select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)
     and payload ->> 'event_name' = 'BookedClient'),
  1,
  'repeated paid state cannot duplicate BookedClient'
);

select ok(
  (select bool_and(
     (select array_agg(k order by k)
      from jsonb_object_keys(o.payload) as keys(k))
     = array['event_id','event_name','event_time','schema_version']::text[]
   )
   from public.integration_outbox o
   where o.kind = 'meta_conversion'
     and o.enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_primary)),
  'Meta outbox payload contains only bounded event metadata, never tattoo content or contact PII'
);

-- Artist isolation: even a consented, complete Kristina enquiry cannot use
-- Vladimir's enabled dataset row.
create temporary table meta_kristina as
select public.create_enquiry_intake(
  'aaaaaaaa-2222-4222-8222-222222222222',
  jsonb_build_object('full_name', 'Kristina Meta Test', 'email', 'kristina-meta@example.test'),
  pg_temp.meta_enquiry_meta(),
  pg_temp.meta_files()
) as r;

update public.enquiries
set artist_id = 'a2222222-2222-4222-8222-222222222222'
where id = (select (r ->> 'enquiry_id')::uuid from meta_kristina);

select public.mark_enquiry_file_uploaded(f.id)
from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_kristina);
select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from meta_kristina));

select public.service_record_meta_attribution(
  (select (r ->> 'enquiry_id')::uuid from meta_kristina),
  'aaaaaaaa-2222-4222-8222-222222222222',
  true,
  null,
  null,
  'https://booking.vishartattoo.com/'
);

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'meta_conversion'
     and enquiry_id = (select (r ->> 'enquiry_id')::uuid from meta_kristina)),
  0,
  'Kristina enquiry cannot route through Vladimir Meta integration'
);

-- Leasing, validation, ownership and bounded retry/dead-letter behavior.
create temporary table meta_claim as
select * from public.claim_meta_conversion_outbox('meta-test-worker', 1, 120);

select is((select count(*)::int from meta_claim), 1,
          'Meta drain leases one ready job');
select ok((select job_valid from meta_claim),
          'leased job passes fail-closed relational validation');
select is((select dataset_id from meta_claim), '1729215778134902',
          'claimed job resolves Vladimir dataset server-side');
select is((select graph_api_version from meta_claim), 'v26.0',
          'claimed job resolves pinned Graph API version server-side');
select is((select email from meta_claim), 'META.TEST@Example.test',
          'raw email is read only at claim time rather than copied into outbox payload');

select throws_ok(
  format(
    $$select public.record_meta_conversion_outbox_result(%L::uuid, 'wrong-worker', false, true, 'network_error')$$,
    (select outbox_id from meta_claim)
  ),
  '42501', null,
  'a worker cannot acknowledge another worker lease'
);

select public.record_meta_conversion_outbox_result(
  (select outbox_id from meta_claim),
  'meta-test-worker',
  false,
  true,
  'network_error'
);

select is(
  (select status::text from public.integration_outbox where id = (select outbox_id from meta_claim)),
  'failed',
  'retryable Meta failure returns the job to failed state'
);
select is(
  (select attempt_count from public.integration_outbox where id = (select outbox_id from meta_claim)),
  1,
  'retryable failure increments attempt count once'
);
select ok(
  (select next_attempt_at > now() from public.integration_outbox where id = (select outbox_id from meta_claim)),
  'retryable failure schedules bounded backoff rather than immediate spin'
);

update public.integration_outbox
set next_attempt_at = now() - interval '1 second'
where id = (select outbox_id from meta_claim);

create temporary table meta_reclaim as
select * from public.claim_meta_conversion_outbox('meta-test-worker-2', 1, 120);

select is((select outbox_id from meta_reclaim), (select outbox_id from meta_claim),
          'failed job can be leased again when its retry time is due');

select public.record_meta_conversion_outbox_result(
  (select outbox_id from meta_reclaim),
  'meta-test-worker-2',
  false,
  false,
  'invalid_request'
);

select is(
  (select status::text from public.integration_outbox where id = (select outbox_id from meta_claim)),
  'dead',
  'non-retryable Meta failure dead-letters immediately'
);

select * from finish();
rollback;
