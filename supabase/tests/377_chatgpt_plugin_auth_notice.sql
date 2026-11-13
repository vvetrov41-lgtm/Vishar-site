-- ChatGPT Plugin OAuth notices: synthetic pure-state and grant regression.
-- No production profile, client, OAuth session or notification is modified.
begin;
select no_plan();

select is(
  crm_private.chatgpt_plugin_auth_state(false, false, false),
  'not_configured',
  'never-authorized profiles are not told to reconnect'
);
select is(
  crm_private.chatgpt_plugin_auth_state(true, true, true),
  'authorization_present',
  'unrevoked OAuth consent and usable session are evidence of stored authorization'
);
select is(
  crm_private.chatgpt_plugin_auth_state(true, false, true),
  'reconnect_required',
  'revoked consent requires attention even when an old session exists'
);
select is(
  crm_private.chatgpt_plugin_auth_state(true, true, false),
  'reconnect_required',
  'missing usable session requires attention after a prior OAuth grant'
);
select is(
  crm_private.chatgpt_plugin_auth_state(true, false, false),
  'reconnect_required',
  'lost OAuth authorization is detected'
);
select is(
  crm_private.chatgpt_plugin_auth_state(false, true, true),
  'not_configured',
  'missing verified client history must not produce an arbitrary warning'
);
select ok(
  not has_function_privilege('anon', 'public.refresh_my_chatgpt_plugin_auth_status()', 'EXECUTE'),
  'anonymous users cannot invoke profile-scoped OAuth diagnostic'
);
select ok(
  has_function_privilege('authenticated', 'public.refresh_my_chatgpt_plugin_auth_status()', 'EXECUTE'),
  'authenticated CRM users may request their own OAuth status'
);
select ok(
  not has_function_privilege('authenticated',
    'crm_private.chatgpt_plugin_auth_state(boolean,boolean,boolean)', 'EXECUTE'),
  'browser cannot directly call the private state classifier'
);
select is(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='refresh_my_chatgpt_plugin_auth_status'),
  true,
  'the scoped RPC runs as a definer to inspect auth-owned session metadata'
);
select is(
  (select count(*)::integer from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname='refresh_my_chatgpt_plugin_auth_status'
      and p.proconfig @> array['search_path=pg_catalog']),
  1,
  'privileged diagnostic pins the safe search path'
);

select * from finish();
rollback;
