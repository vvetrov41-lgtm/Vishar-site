-- Regression coverage for the PR review fixes around enquiry-content refreshes.
begin;
select no_plan();

select ok(
  position('client_ai_watermark(new.artist_id, new.client_id)' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'enquiry edit refresh source ids are derived from the current client watermark'
);

select ok(
  position('old.idea is not distinct from new.idea' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'idea edits participate in the enquiry refresh change detector'
);

select ok(
  position('old.placement is not distinct from new.placement' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'placement edits participate in the enquiry refresh change detector'
);

select ok(
  position('old.approximate_size is not distinct from new.approximate_size' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'size edits participate in the enquiry refresh change detector'
);

select ok(
  position('old.cover_up is not distinct from new.cover_up' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'cover-up edits participate in the enquiry refresh change detector'
);

select ok(
  position('old.preferred_timing is not distinct from new.preferred_timing' in
    lower(pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure))) > 0,
  'preferred-timing edits participate in the enquiry refresh change detector'
);

select ok(
  pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.enquiries'::regclass
      and tgname = 'enquiries_enqueue_client_ai'
      and not tgisinternal
  )) ilike '%UPDATE OF%placement%approximate_size%cover_up%preferred_timing%idea%archived_at%',
  'enquiry trigger fires for every watermark-bearing editable enquiry field'
);

select * from finish();
rollback;
