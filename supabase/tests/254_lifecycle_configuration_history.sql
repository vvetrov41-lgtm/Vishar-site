begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and API boundary
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege(
    'authenticated',
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  'authenticated CRM users can execute the configuration history RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the configuration history RPC'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  'the service backend cannot impersonate a browser configuration-history read'
);
select is(
  (select prosecdef from pg_proc
   where oid = 'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure),
  true,
  'configuration history is SECURITY DEFINER'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(proconfig)
   from pg_proc
   where oid = 'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure),
  'configuration history pins its search path'
);
select ok(
  pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%metadata%'
  and pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%subject%'
  and pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%body%'
  and pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%client%'
  and pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%provider%'
  and pg_get_function_result(
    'public.list_lifecycle_configuration_history(uuid,integer,timestamptz,uuid)'::regprocedure
  ) not ilike '%error%',
  'the result contract excludes raw metadata, message copy, client, provider and error fields'
);

-- ---------------------------------------------------------------------------
-- Two isolated Artists and one read-only automation viewer
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('fc100000-0000-4000-8000-000000000001', 'audit-reader@example.test'),
  ('fc100000-0000-4000-8000-000000000002', 'audit-foreign-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fc100000-0000-4000-8000-000000000001', 'audit-reader@example.test',
   'Audit Reader', 'booking_manager', true),
  ('fc100000-0000-4000-8000-000000000002', 'audit-foreign-reader@example.test',
   'Foreign Audit Reader', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fc200000-0000-4000-8000-000000000001', 'audit-read-home', 'Audit Read Home', 'studio', true),
  ('fc200000-0000-4000-8000-000000000002', 'audit-read-foreign', 'Audit Read Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fc300000-0000-4000-8000-000000000001', 'fc200000-0000-4000-8000-000000000001',
   'audit-read-home-artist', 'Audit Read Home Artist', true),
  ('fc300000-0000-4000-8000-000000000002', 'fc200000-0000-4000-8000-000000000002',
   'audit-read-foreign-artist', 'Audit Read Foreign Artist', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fc100000-0000-4000-8000-000000000001', 'fc300000-0000-4000-8000-000000000001',
   'read_only', false, false, false, false, true, 'explicit'),
  ('fc100000-0000-4000-8000-000000000002', 'fc300000-0000-4000-8000-000000000002',
   'read_only', false, false, false, false, true, 'explicit');

create function pg_temp.as_history_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_history_profile(uuid) to authenticated;

create temporary table configuration_history_side_effects_before as
select
  (select count(*) from public.automation_jobs) as jobs,
  (select count(*) from public.email_messages) as emails,
  (select count(*) from public.integration_outbox) as outbox;

insert into public.activity_log (
  id, occurred_at, artist_id, event_type, actor_profile_id, actor_kind, metadata
) values
  (
    'fc400000-0000-4000-8000-000000000001', '2026-08-26 10:01:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.rule_created',
    'fc100000-0000-4000-8000-000000000001', 'staff',
    jsonb_build_object(
      'rule_id', 'fc500000-0000-4000-8000-000000000001',
      'after', jsonb_build_object(
        'message_purpose', 'session_reminder_24h',
        'message_channel', 'email',
        'message_locale', 'en',
        'schedule_anchor', 'session_start',
        'anchor_offset_minutes', -1440,
        'is_enabled', false,
        'version', 1
      )
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000002', '2026-08-26 10:02:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.rule_updated',
    'fc100000-0000-4000-8000-000000000001', 'staff',
    jsonb_build_object(
      'rule_id', 'fc500000-0000-4000-8000-000000000001',
      'before', jsonb_build_object('is_enabled', false, 'version', 1),
      'after', jsonb_build_object('is_enabled', true, 'version', 1)
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000003', '2026-08-26 10:03:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.rule_timing_updated',
    'fc100000-0000-4000-8000-000000000001', 'staff',
    jsonb_build_object(
      'rule_id', 'fc500000-0000-4000-8000-000000000001',
      'before', jsonb_build_object(
        'schedule_anchor', 'session_start', 'anchor_offset_minutes', -1440, 'version', 1
      ),
      'after', jsonb_build_object(
        'schedule_anchor', 'session_end', 'anchor_offset_minutes', 1440, 'version', 2
      ),
      'pending_jobs_rescheduled', 0
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000004', '2026-08-26 10:04:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.template_created',
    'fc100000-0000-4000-8000-000000000001', 'staff',
    jsonb_build_object(
      'template_id', 'fc600000-0000-4000-8000-000000000001',
      'purpose', 'session_reminder_24h', 'channel', 'email', 'locale', 'en',
      'version', 2, 'status', 'draft'
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000005', '2026-08-26 10:05:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.template_updated',
    'fc100000-0000-4000-8000-000000000001', 'staff',
    jsonb_build_object(
      'template_id', 'fc600000-0000-4000-8000-000000000001',
      'purpose', 'session_reminder_24h', 'channel', 'email', 'locale', 'en',
      'version', 2,
      'before', jsonb_build_object('status', 'draft'),
      'after', jsonb_build_object('status', 'active'),
      'previous_active_versions_retired', 1
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000006', '2026-08-26 10:06:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.rule_updated',
    null, 'system',
    jsonb_build_object(
      'rule_id', 'malformed-legacy-id',
      'purpose', 'untrusted free text',
      'channel', 'unreviewed-provider',
      'locale', 'unbounded locale text',
      'version', '999999999999999999'
    )
  ),
  (
    'fc400000-0000-4000-8000-000000000007', '2026-08-26 10:07:00+00',
    'fc300000-0000-4000-8000-000000000001', 'automation.health_checked',
    null, 'system', '{}'
  ),
  (
    'fc400000-0000-4000-8000-000000000008', '2026-08-26 10:08:00+00',
    'fc300000-0000-4000-8000-000000000002', 'automation.template_updated',
    'fc100000-0000-4000-8000-000000000002', 'staff',
    jsonb_build_object(
      'template_id', 'fc600000-0000-4000-8000-000000000002',
      'purpose', 'session_reminder_24h', 'channel', 'email', 'locale', 'en',
      'version', 1,
      'before', jsonb_build_object('status', 'draft'),
      'after', jsonb_build_object('status', 'active'),
      'previous_active_versions_retired', 0
    )
  );

-- ---------------------------------------------------------------------------
-- Typed projection, isolation and exact cursor semantics
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.as_history_profile('fc100000-0000-4000-8000-000000000001');
set local role authenticated;

select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )),
  6,
  'an authorized viewer sees only supported configuration events for one Artist'
);

select is(
  (select actor_display_name
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000005'),
  'Audit Reader',
  'history identifies the internal actor without placing a name in metadata'
);

select is(
  (select row(
     rule_id, purpose, channel, locale, version,
     is_enabled_after, schedule_anchor_after, anchor_offset_minutes_after
   )::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000001'),
  row(
    'fc500000-0000-4000-8000-000000000001'::uuid,
    'session_reminder_24h', 'email', 'en', 1, false, 'session_start', -1440
  )::text,
  'rule creation is normalized into typed safe initial state'
);

select is(
  (select row(is_enabled_before, is_enabled_after, version)::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000002'),
  row(false, true, 1)::text,
  'rule enablement exposes the bounded before and after state'
);

select is(
  (select row(
     schedule_anchor_before, schedule_anchor_after,
     anchor_offset_minutes_before, anchor_offset_minutes_after,
     version, pending_jobs_rescheduled
   )::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000003'),
  row('session_start', 'session_end', -1440, 1440, 2, 0)::text,
  'timing history exposes typed before/after timing and the rescheduled count'
);

select is(
  (select row(
     entity_kind, template_id, purpose, channel, locale, version,
     status_before, status_after, previous_active_versions_retired
   )::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000005'),
  row(
    'template', 'fc600000-0000-4000-8000-000000000001'::uuid,
    'session_reminder_24h', 'email', 'en', 2,
    'draft', 'active', 1
  )::text,
  'template activation exposes only immutable slot and status-transition state'
);

select is(
  (select row(rule_id, purpose, channel, locale, version)::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )
   where activity_id = 'fc400000-0000-4000-8000-000000000006'),
  row(null::uuid, null::text, null::text, null::text, null::integer)::text,
  'malformed legacy identifiers and unreviewed values normalize to null without failing the history read'
);

select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000002', 100, null, null
   )),
  0,
  'a viewer cannot read another Artist configuration history'
);

select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 2, null, null
   )),
  2,
  'the first cursor page honors its bounded limit'
);

select is(
  (select array_agg(activity_id order by occurred_at desc, activity_id desc)::text
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100,
     '2026-08-26 10:05:00+00', 'fc400000-0000-4000-8000-000000000005'
   )),
  array[
    'fc400000-0000-4000-8000-000000000004'::uuid,
    'fc400000-0000-4000-8000-000000000003'::uuid,
    'fc400000-0000-4000-8000-000000000002'::uuid,
    'fc400000-0000-4000-8000-000000000001'::uuid
  ]::text,
  'the exact occurred-at plus id cursor returns the next page without overlap'
);

select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100,
     '2026-08-26 10:05:00+00', null
   )),
  0,
  'a partial cursor fails closed'
);

select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 0, null, null
   )),
  1,
  'a zero limit is clamped to one row'
);

reset role;

select is(
  (select count(*)::integer from public.activity_log
   where id between 'fc400000-0000-4000-8000-000000000001'::uuid
                and 'fc400000-0000-4000-8000-000000000008'::uuid),
  8,
  'history reads append no activity rows'
);
select is(
  (select count(*) from public.automation_jobs),
  (select jobs from configuration_history_side_effects_before),
  'configuration history creates no automation job'
);
select is(
  (select count(*) from public.email_messages),
  (select emails from configuration_history_side_effects_before),
  'configuration history creates no email'
);
select is(
  (select count(*) from public.integration_outbox),
  (select outbox from configuration_history_side_effects_before),
  'configuration history creates no provider outbox row'
);

update crm_private.profile_access
set is_active = false
where profile_id = 'fc100000-0000-4000-8000-000000000001';

select pg_temp.as_history_profile('fc100000-0000-4000-8000-000000000001');
set local role authenticated;
select is(
  (select count(*)::integer
   from public.list_lifecycle_configuration_history(
     'fc300000-0000-4000-8000-000000000001', 100, null, null
   )),
  0,
  'an inactive identity receives no configuration history'
);
reset role;

select * from finish(true);
rollback;
