-- 279_workspace_client_activity_guard.sql
-- The workspace client split may re-key activity_log.client_id only inside the
-- migration transaction. Runtime audit history must remain append-only after it.

begin;
select plan(2);

select is(
  (
    select count(*)::int
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'activity_log'
      and t.tgname = 'activity_log_append_only'
      and not t.tgisinternal
  ),
  1,
  'activity_log append-only row guard still exists after workspace client migration'
);

select is(
  (
    select t.tgenabled::text
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'activity_log'
      and t.tgname = 'activity_log_append_only'
      and not t.tgisinternal
  ),
  'O',
  'activity_log append-only row guard is enabled after workspace client migration'
);

select * from finish();
rollback;
