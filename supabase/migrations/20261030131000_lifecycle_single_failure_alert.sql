-- A missing destination or integration is actionable even for one booking.
-- Alert only the artist team; never include the client's address or message.
create or replace function crm_private.alert_lifecycle_destination_failure()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, crm_private as $function$
begin
  if new.action_type <> 'send_client_message'::public.automation_action_type
     or new.status <> 'failed'::public.automation_job_status
     or old.status = 'failed'::public.automation_job_status
     or new.last_error_category not in ('destination_unavailable', 'integration_unavailable')
  then return new; end if;

  insert into public.notifications (
    recipient_profile_id, artist_id, notification_type, title, body,
    priority, status, dedupe_key, scheduled_at, delivered_at
  )
  select r.profile_id, new.artist_id, 'automation.lifecycle_destination_failed',
    'Automatic message needs attention',
    'An automatic client message could not be prepared because its destination or sending integration is unavailable. Review the booking and Automations for this artist.',
    'high', 'delivered',
    'lifecycle_destination:' || new.id::text || ':' || r.profile_id::text,
    now(), now()
  from crm_private.automation_notification_recipients(new.artist_id) r
  on conflict (dedupe_key) do nothing;
  return new;
end;
$function$;
revoke all on function crm_private.alert_lifecycle_destination_failure() from public, anon, authenticated, service_role;
create trigger automation_jobs_lifecycle_destination_alert
after update of status, last_error_category on public.automation_jobs
for each row execute function crm_private.alert_lifecycle_destination_failure();
