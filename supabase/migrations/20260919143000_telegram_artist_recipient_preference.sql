-- Artist-scoped personal Telegram notifications should go to the artist-facing
-- recipient, not every platform owner who also has administrative access.
--
-- Prefer active artist/manager memberships with Telegram enabled. An owner
-- remains the fallback only when that artist has no eligible artist/manager
-- recipient, preserving solo-owner workspaces. Read-only memberships never
-- receive operational Telegram notifications.

create or replace function crm_private.telegram_notification_recipient_eligible(
  p_profile_id uuid,
  p_artist_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
  select exists (
    select 1
    from public.profiles p
    join crm_private.telegram_destinations d
      on d.destination_kind = 'profile'
     and d.profile_id = p.id
     and d.is_active
    join public.notification_preferences pref
      on pref.profile_id = p.id
     and pref.channel = 'telegram'
     and pref.is_enabled
    where p.id = p_profile_id
      and p.is_active
      and crm_private.profile_can_receive_notification(
        p.id, p_artist_id, p_workspace_id
      )
      and (
        p_artist_id is null
        or exists (
          select 1
          from public.artist_memberships am
          where am.profile_id = p.id
            and am.artist_id = p_artist_id
            and am.is_active
            and (
              am.access_level in ('artist', 'manager')
              or (
                am.access_level = 'owner'
                and not exists (
                  select 1
                  from public.artist_memberships preferred_am
                  join public.profiles preferred_p
                    on preferred_p.id = preferred_am.profile_id
                   and preferred_p.is_active
                  join crm_private.telegram_destinations preferred_d
                    on preferred_d.destination_kind = 'profile'
                   and preferred_d.profile_id = preferred_am.profile_id
                   and preferred_d.is_active
                  join public.notification_preferences preferred_pref
                    on preferred_pref.profile_id = preferred_am.profile_id
                   and preferred_pref.channel = 'telegram'
                   and preferred_pref.is_enabled
                  where preferred_am.artist_id = p_artist_id
                    and preferred_am.is_active
                    and preferred_am.access_level in ('artist', 'manager')
                    and crm_private.profile_can_receive_notification(
                      preferred_am.profile_id, p_artist_id, p_workspace_id
                    )
                )
              )
            )
        )
      )
  );
$function$;

comment on function crm_private.telegram_notification_recipient_eligible(uuid, uuid, uuid)
is 'Telegram recipient gate: artist/manager memberships are preferred for artist-scoped notifications; owner is fallback only when no eligible artist/manager destination exists; read-only is excluded.';
