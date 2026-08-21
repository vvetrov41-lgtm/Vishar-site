-- 0080_booking_source_list_scope_hardening.sql
--
-- Phase I-J security hardening. Migration 0079 correctly keeps the underlying
-- booking_sources routing table manage-only, but its no-argument list RPC used
-- the weaker view_booking_sources capability in the final row filter. A caller
-- with a read-only Artist membership could therefore enumerate routing rows by
-- calling list_booking_sources() without an Artist id.
--
-- Keep the public function signature and result shape unchanged. Both explicit
-- and all-accessible-Artist listing now require the same manage-level authority
-- as the table policy and the create/update RPCs.

create or replace function public.list_booking_sources(p_artist_id uuid default null)
returns table (
  id uuid,
  artist_id uuid,
  public_source_id uuid,
  source_kind text,
  display_label text,
  allowed_origin text,
  form_template text,
  form_version text,
  is_active boolean,
  public_path text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not public.is_active_user() then
    raise exception 'an active CRM profile is required' using errcode = '42501';
  end if;

  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'manage_booking_sources');
  end if;

  return query
  select
    s.id,
    s.artist_id,
    s.public_source_id,
    s.source_kind,
    s.display_label,
    s.allowed_origin,
    s.form_template,
    s.form_version,
    s.is_active,
    case when s.source_kind = 'hosted'
      then '/forms/' || s.public_source_id::text
      else null
    end,
    s.created_at,
    s.updated_at
  from public.booking_sources s
  where (p_artist_id is null or s.artist_id = p_artist_id)
    and crm_private.has_artist_capability(s.artist_id, 'manage_booking_sources')
  order by s.created_at, s.id;
end;
$$;

revoke all on function public.list_booking_sources(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_booking_sources(uuid)
  to authenticated;

comment on function public.list_booking_sources(uuid) is
  'Lists booking-source routing configuration only for Artists the signed-in CRM user may manage. NULL means all such Artists, never all merely viewable Artists.';
