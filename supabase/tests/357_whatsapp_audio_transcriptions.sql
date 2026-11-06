begin;
select no_plan();

select ok(
  to_regclass('crm_private.whatsapp_audio_transcription_jobs') is not null,
  'Audio media-id jobs live in the private CRM schema'
);
select ok(
  exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='crm_private'
            and c.relname='whatsapp_audio_transcription_jobs'
            and c.relrowsecurity),
  'Audio job queue has row-level security'
);
select ok(
  not has_table_privilege('authenticated',
    'crm_private.whatsapp_audio_transcription_jobs', 'SELECT'),
  'Artists cannot select temporary media ids from the queue'
);
select ok(
  not has_table_privilege('anon',
    'crm_private.whatsapp_audio_transcription_jobs', 'SELECT'),
  'Anonymous users cannot select temporary media ids'
);
select ok(
  not has_table_privilege('service_role',
    'crm_private.whatsapp_audio_transcription_jobs', 'SELECT'),
  'Even service role must use bounded RPCs, not query the queue directly'
);

select ok(
  to_regprocedure('public.service_queue_whatsapp_audio_transcription(uuid,text,text,text)') is not null,
  'Only the signed provider webhook can enqueue an audio id'
);
select ok(
  to_regprocedure('public.service_claim_whatsapp_audio_transcriptions(text,integer,integer)') is not null,
  'Leased claims support bounded retry workers'
);
select ok(
  to_regprocedure('public.service_complete_whatsapp_audio_transcription(uuid,text,text,text)') is not null,
  'Completion is separate from media retrieval and sending'
);
select ok(
  not has_function_privilege('authenticated',
    'public.service_queue_whatsapp_audio_transcription(uuid,text,text,text)', 'EXECUTE'),
  'Authenticated users cannot enqueue media ids'
);
select ok(
  not has_function_privilege('anon',
    'public.service_claim_whatsapp_audio_transcriptions(text,integer,integer)', 'EXECUTE'),
  'Anonymous users cannot claim audio media ids'
);
select ok(
  not has_function_privilege('authenticated',
    'public.service_complete_whatsapp_audio_transcription(uuid,text,text,text)', 'EXECUTE'),
  'Authenticated users cannot fabricate transcripts'
);
select ok(
  has_function_privilege('service_role',
    'public.service_queue_whatsapp_audio_transcription(uuid,text,text,text)', 'EXECUTE'),
  'Trusted service backend can persist signed audio id'
);

select ok(
  pg_get_functiondef('public.service_queue_whatsapp_audio_transcription(uuid,text,text,text)'::regprocedure)
    like '%crm_private.is_service_backend()%',
  'Enqueue checks backend authentication even if SQL privileges drift'
);
select ok(
  pg_get_functiondef('public.service_complete_whatsapp_audio_transcription(uuid,text,text,text)'::regprocedure)
    like '%v_job.lease_owner <> p_worker_id%',
  'Only the lease owner can store a transcript'
);

select * from finish(true);
rollback;
