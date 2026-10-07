-- 328_today_pulse_fast_path.sql
--
-- The Today pulse uses a narrow attention projection. It must stay behaviourally
-- identical to the fields it previously read from client_attention, while
-- excluding ai_brief_stale exactly as pulse_items already did.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, workspace_id, full_name, email) values (
  'd4700000-0000-4000-8000-000000000001',
  (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
  'Pulse Fast Path',
  'pulse-fast-path@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint,
  status, intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at, placement, approximate_size, created_at
) values (
  'd4710000-0000-4000-8000-000000000001',
  'd4700000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-9901',
  'd4710000-0000-4000-8000-000000000002',
  repeat('e', 64),
  'reviewing', 'complete', 'Pulse Fast Path', 'pulse-fast-path@example.test',
  '2026-08-05', now(), 'left forearm', '10 cm', now() - interval '10 days'
);

insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values (
  'd4720000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'd4700000-0000-4000-8000-000000000001',
  'linked', 'vladimir-production', '447700909901'
);

insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body,
  provider_timestamp, created_at
) values (
  'd4730000-0000-4000-8000-000000000001',
  'd4720000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'outbound', 'provider_app', 'sent', 'Synthetic follow-up',
  now() - interval '8 days', now() - interval '8 days'
);

insert into public.client_ai_state (
  artist_id, workspace_id, client_id, summary, brief, source_watermark, provider, model
)
select
  'a1111111-1111-4111-8111-111111111111',
  c.workspace_id,
  c.id,
  'Synthetic current brief for fast-path parity.',
  jsonb_build_object(
    'project_summary', 'Synthetic tattoo enquiry',
    'stage', 'awaiting_artist_review',
    'placement', 'chest',
    'style', null,
    'colour', null,
    'size', '20 cm',
    'cover_up_context', null,
    'constraints', '[]'::jsonb,
    'decisions_made', '[]'::jsonb,
    'open_questions', '[]'::jsonb,
    'promises_to_client', '[]'::jsonb,
    'waiting_on', 'client',
    'last_interaction', null,
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed')
    )
  ),
  crm_private.client_ai_watermark(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001'
  ),
  'workers_ai',
  'test-model'
from public.clients c
where c.id = 'd4700000-0000-4000-8000-000000000001';

select results_eq(
  $$select unnest(crm_private.pulse_fact_conflicts(
      'a1111111-1111-4111-8111-111111111111',
      'd4700000-0000-4000-8000-000000000001'))$$,
  $$values ('fact_conflict_placement'::text), ('fact_conflict_size'::text)$$,
  'the fast fact path keeps both current placement and size contradictions'
);

select is(
  crm_private.pulse_conflicts(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001'
  ),
  array_remove(
    crm_private.attention_conflicts(
      'a1111111-1111-4111-8111-111111111111',
      'd4700000-0000-4000-8000-000000000001'
    ),
    'ai_brief_stale'
  ),
  'pulse conflicts equal the old Today-visible conflict set'
);

create temp table fast_path_snapshot on commit drop as
with n as (select clock_timestamp() as t),
full_attention as (
  select crm_private.client_attention(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001',
    n.t
  ) as a
  from n
),
fast_attention as (
  select crm_private.pulse_client_attention(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001',
    n.t
  ) as a
  from n
)
select f.a as full_a, q.a as fast_a
from full_attention f, fast_attention q;

select is(
  (select fast_a from fast_path_snapshot),
  (select jsonb_build_object(
    'client_id', 'd4700000-0000-4000-8000-000000000001'::uuid,
    'last_outbound_at', full_a -> 'last_outbound_at',
    'workflow_stage', full_a -> 'workflow_stage',
    'sla_state', full_a -> 'sla_state',
    'sla_reason', full_a -> 'sla_reason',
    'conflicts', to_jsonb(array_remove(
      array(select jsonb_array_elements_text(full_a -> 'conflicts')),
      'ai_brief_stale'
    ))
  ) from fast_path_snapshot),
  'the narrow projection matches every field Today consumed from client_attention'
);

select is(
  crm_private.pulse_client_attention(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001',
    clock_timestamp()
  ) ->> 'sla_reason',
  'client_follow_up_due',
  'the fast path preserves the waiting-on-client SLA'
);

select is(
  (select a from crm_private.pulse_attention_batch('a1111111-1111-4111-8111-111111111111', now())
   where client_id='d4700000-0000-4000-8000-000000000001'),
  crm_private.pulse_client_attention('a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001', now()),
  'batch attention preserves the per-client result in this booking state');

insert into public.sessions (
  id, artist_id, client_id, appointment_type, status, start_at, end_at, duration_hours
) values (
  'd4740000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'd4700000-0000-4000-8000-000000000001',
  'in_person_consultation', 'confirmed', date_trunc('hour', now()) + interval '10 days',
  date_trunc('hour', now()) + interval '10 days 30 minutes', 0.5
);

select is(
  crm_private.pulse_client_attention(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001',
    clock_timestamp()
  ) ->> 'sla_reason',
  'nothing_pending',
  'a confirmed future consultation still suppresses the went-quiet nudge'
);

select is(
  (select a from crm_private.pulse_attention_batch('a1111111-1111-4111-8111-111111111111', now())
   where client_id='d4700000-0000-4000-8000-000000000001'),
  crm_private.pulse_client_attention('a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001', now()),
  'batch attention preserves the per-client result in this booking state');

update public.sessions
set status = 'proposed'
where id = 'd4740000-0000-4000-8000-000000000001';

select is(
  crm_private.pulse_client_attention(
    'a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001',
    clock_timestamp()
  ) ->> 'sla_reason',
  'client_follow_up_due',
  'a merely proposed consultation still waits on the client'
);

select is(
  (select a from crm_private.pulse_attention_batch('a1111111-1111-4111-8111-111111111111', now())
   where client_id='d4700000-0000-4000-8000-000000000001'),
  crm_private.pulse_client_attention('a1111111-1111-4111-8111-111111111111',
    'd4700000-0000-4000-8000-000000000001', now()),
  'batch attention preserves the per-client result in this booking state');

select ok(
  position(
    'crm_private.pulse_attention_batch(p_artist_id, (select t from now_))'
    in pg_get_functiondef('crm_private.pulse_items(uuid,boolean,boolean,timestamptz)'::regprocedure)
  ) > 0,
  'pulse_items is routed through the narrow attention projection'
);
select ok(
  position(
    'crm_private.client_attention(p_artist_id, ac.client_id, (select t from now_))'
    in pg_get_functiondef('crm_private.pulse_items(uuid,boolean,boolean,timestamptz)'::regprocedure)
  ) = 0,
  'pulse_items no longer calls the full per-client attention projection'
);

select ok(not has_function_privilege(
  'authenticated',
  'crm_private.pulse_client_attention(uuid,uuid,timestamptz)',
  'execute'
), 'the fast-path projection remains private');
select ok(not has_function_privilege(
  'service_role',
  'crm_private.pulse_fact_conflicts(uuid,uuid)',
  'execute'
), 'the optimized fact-conflict helper remains private');

select ok(not has_function_privilege('authenticated', 'crm_private.pulse_attention_batch(uuid,timestamptz)', 'execute'),
  'the artist batch remains inaccessible to browser roles');
select ok(not has_function_privilege('service_role', 'crm_private.pulse_attention_batch(uuid,timestamptz)', 'execute'),
  'the batch is not an alternative service-role RPC');
select is((select count(*) from crm_private.pulse_attention_batch('a2222222-2222-4222-8222-222222222222', now())
  where client_id='d4700000-0000-4000-8000-000000000001'), 0::bigint,
  'the batch does not cross artist boundaries');

-- Ack covers the observed message, never a later inbound; operator marks stand.
insert into public.communication_messages (
  id,conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp,created_at
) values ('d4730000-0000-4000-8000-000000000002',
  'd4720000-0000-4000-8000-000000000001','a1111111-1111-4111-8111-111111111111',
  'whatsapp','inbound','contact','received','text','Synthetic question',now()-interval '5 days',now()-interval '5 days');
insert into crm_private.client_reply_marks(artist_id,client_id,message_at,reply_state,source)
values('a1111111-1111-4111-8111-111111111111','d4700000-0000-4000-8000-000000000001',
  now()-interval '5 days','reply_required','classifier');
insert into public.attention_acknowledgements(artist_id,item_kind,entity_id,observed_at,acknowledged_at)
values('a1111111-1111-4111-8111-111111111111','conversation_reply','d4720000-0000-4000-8000-000000000001',
  now()-interval '5 days',now()-interval '1 day');
select is((select a from crm_private.pulse_attention_batch('a1111111-1111-4111-8111-111111111111',now())
  where client_id='d4700000-0000-4000-8000-000000000001'),
  crm_private.pulse_client_attention('a1111111-1111-4111-8111-111111111111','d4700000-0000-4000-8000-000000000001',now()),
  'batch acknowledgement overrides classifier reply-required identically');
insert into public.communication_messages (
  id,conversation_id,artist_id,channel,direction,origin,status,message_type,body,provider_timestamp,created_at
) values ('d4730000-0000-4000-8000-000000000003',
  'd4720000-0000-4000-8000-000000000001','a1111111-1111-4111-8111-111111111111',
  'whatsapp','inbound','contact','received','text','Synthetic newer question',now()-interval '2 days',now()-interval '2 days');
select is((select a from crm_private.pulse_attention_batch('a1111111-1111-4111-8111-111111111111',now())
  where client_id='d4700000-0000-4000-8000-000000000001'),
  crm_private.pulse_client_attention('a1111111-1111-4111-8111-111111111111','d4700000-0000-4000-8000-000000000001',now()),
  'a late acknowledgement cannot cover newer inbound in the batch');
insert into crm_private.client_reply_marks(artist_id,client_id,message_at,reply_state,source)
values('a1111111-1111-4111-8111-111111111111','d4700000-0000-4000-8000-000000000001',
  now()-interval '2 days','no_reply_needed','operator');
select ok((select bool_and(b.a=crm_private.pulse_client_attention(a.id,b.client_id,now()))
  from public.artists a cross join lateral crm_private.pulse_attention_batch(a.id,now()) b),
  'batch and per-client results match all active clients, including operator overrides');

select * from finish(true);
rollback;
