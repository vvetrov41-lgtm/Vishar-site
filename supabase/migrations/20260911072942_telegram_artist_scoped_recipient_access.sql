-- Artist-scoped notification recipients do not need workspace-wide membership.
--
-- A booking manager can legitimately have access to one artist without having
-- workspace_access. Telegram enquiry routing still carries workspace_id so the
-- notification can be scoped and audited. Treat that workspace as a consistency
-- boundary for an artist-scoped notification, not as a second membership gate.
-- Workspace-only notifications continue to require workspace_access.

create or replace function crm_private.profile_can_receive_notification(
  p_profile_id uuid,
  p_artist_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
  select exists (
    select 1
    from crm_private.profile_access p
    where p.profile_id = p_profile_id
      and p.is_active
      and (
        p_artist_id is null
        or exists (
          select 1
          from crm_private.artist_access a
          where a.profile_id = p_profile_id
            and a.artist_id = p_artist_id
            and a.is_active
        )
      )
      and (
        p_workspace_id is null
        or (
          p_artist_id is not null
          and exists (
            select 1
            from public.artists a
            join crm_private.workspace_state s
              on s.workspace_id = a.workspace_id
             and s.is_active
            where a.id = p_artist_id
              and a.workspace_id = p_workspace_id
              and a.is_active
          )
        )
        or (
          p_artist_id is null
          and exists (
            select 1
            from crm_private.workspace_access w
            join crm_private.workspace_state s
              on s.workspace_id = w.workspace_id
             and s.is_active
            where w.profile_id = p_profile_id
              and w.workspace_id = p_workspace_id
              and w.is_active
          )
        )
      )
  );
$function$;

comment on function crm_private.profile_can_receive_notification(uuid, uuid, uuid)
is 'Fail-closed notification access: profile + artist access for artist-scoped notifications, workspace membership for workspace-only notifications, and active workspace consistency when both scopes are present.';
