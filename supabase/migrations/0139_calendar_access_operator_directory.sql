-- 0139_calendar_access_operator_directory.sql
--
-- Make the Calendar connector's edge identity boundary a projection of the CRM
-- capability graph instead of a hand-maintained list.
--
-- Migration 0137 removed every artist allow-list from the Calendar Worker, so
-- Supabase is already the only authority on *which artist* an operator may
-- connect. One manual step survived: `calendar.vishartattoo.com` sits behind a
-- Cloudflare Access policy whose named-email selectors were curated by hand,
-- and onboarding an artist meant a developer editing that list. Production
-- shows the gap exactly: three profiles currently hold manage-integrations on
-- an active artist, and the Access policy names two of them.
--
-- This RPC is the source the Access sync reads. It answers one question -
-- "which people may manage integrations for at least one active artist right
-- now" - using the same predicate `public.authorize_calendar_actor` and
-- `public.resolve_calendar_artist_route` already use, so the edge can never be
-- broader than the capability it mirrors.
--
-- It does not grant anything. Reaching the connector still proves nothing: the
-- per-artist decision stays in `resolve_calendar_artist_route`, evaluated per
-- request against the artist the operator actually named.
--
-- Forward-only and additive. No earlier migration is edited.

create or replace function public.list_calendar_access_operators()
returns table (
  operator_email text,
  is_owner boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar access operator directory is backend-only'
      using errcode = '42501';
  end if;

  return query
  select
    lower(btrim(p.email)) as operator_email,
    bool_or(pa.role = 'owner') as is_owner
  from public.profiles p
  join crm_private.profile_access pa
    on pa.profile_id = p.id
  join crm_private.artist_access aa
    on aa.profile_id = p.id
  join crm_private.artist_state ast
    on ast.artist_id = aa.artist_id
  where pa.is_active
    and aa.is_active
    and ast.is_active
    and (
      pa.role = 'owner'
      or (pa.role = 'booking_manager' and aa.can_manage_integrations)
    )
    -- The result is written into a Cloudflare Access email selector, so a
    -- malformed or oversized address must never reach the policy payload.
    and p.email is not null
    and lower(btrim(p.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    and length(lower(btrim(p.email))) <= 254
  group by 1
  order by 1;
end;
$$;

revoke all on function public.list_calendar_access_operators()
  from public, anon, authenticated, service_role;
grant execute on function public.list_calendar_access_operators()
  to service_role;

comment on function public.list_calendar_access_operators() is
  'Backend-only directory of the email addresses that currently hold manage-integrations for at least one active artist, with an owner marker. It is the source the Calendar Access sync projects onto the connector hostname so onboarding an artist needs no manual allow-list edit. It returns no profile id, artist id, membership row or capability detail, and grants nothing: per-artist authorization stays in resolve_calendar_artist_route.';
