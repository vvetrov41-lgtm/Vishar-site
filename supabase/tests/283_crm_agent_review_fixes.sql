-- Regression coverage for the PR review fixes around enquiry-content refreshes.
begin;
select no_plan();

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%client_ai_watermark(new.artist_id, new.client_id)%',
  'enquiry refresh source ids are derived from the current client watermark'
);

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%old.idea is not distinct from new.idea%',
  'idea edits participate in the enquiry refresh change detector'
);

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%old.placement is not distinct from new.placement%',
  'placement edits participate in the enquiry refresh change detector'
);

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%old.approximate_size is not distinct from new.approximate_size%',
  'size edits participate in the enquiry refresh change detector'
);

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%old.cover_up is not distinct from new.cover_up%',
  'cover-up edits participate in the enquiry refresh change detector'
);

select like(
  pg_get_functiondef('crm_private.enqueue_enquiry_client_ai()'::regprocedure),
  '%old.preferred_timing is not distinct from new.preferred_timing%',
  'preferred-timing edits participate in the enquiry refresh change detector'
);

select like(
  pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.enquiries'::regclass
      and tgname = 'enquiries_enqueue_client_ai'
      and not tgisinternal
  )),
  '%UPDATE OF intake_state, status, project_type, placement, approximate_size, cover_up, preferred_timing, idea, archived_at%',
  'enquiry trigger fires for every watermark-bearing editable enquiry field'
);

select * from finish();
rollback;
