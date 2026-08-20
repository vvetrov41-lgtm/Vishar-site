from pathlib import Path

ROOT = Path('.')


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


# CI follow-up for the 0073 operator authorization change. This script changes
# tests only. The production migration and Worker implementation remain exactly
# the already-reviewed e42882b product code.

replace_once(
    'supabase/tests/050_rls_roles.sql',
    """  ('public.service_set_instagram_integration(uuid,text,text,text,text[])', false, false, true),
  ('public.service_disable_instagram_integration(uuid,text,text)', false, false, true),
  ('public.service_resolve_instagram_route(text)', false, false, true),
""",
    """  ('public.service_authorize_instagram_connection(uuid,uuid)', false, false, true),
  ('public.service_set_instagram_integration(uuid,text,text,text,text[])', false, false, true),
  ('public.service_disable_instagram_integration(uuid,text,text)', false, false, true),
  ('public.service_resolve_instagram_route(text)', false, false, true),
""",
)

fixture = """select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);

-- This suite runs on a clean database with no CRM users. Seed only the private
-- authorization mirrors the service RPC reads, inside this transaction, so the
-- positive case proves backend-owned profile + artist capability evaluation
-- without depending on auth.uid() or a browser-supplied profile id.
insert into crm_private.profile_access (profile_id, role, is_active)
values ('66666666-6666-4666-8666-666666666666', 'owner', true)
on conflict (profile_id) do update
  set role = excluded.role,
      is_active = excluded.is_active;

insert into crm_private.artist_access (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '66666666-6666-4666-8666-666666666666',
  'a1111111-1111-4111-8111-111111111111',
  'owner', true, true, true, true, true
)
on conflict (profile_id, artist_id) do update
  set access_level = excluded.access_level,
      can_view_finance = excluded.can_view_finance,
      can_manage_finance = excluded.can_manage_finance,
      can_manage_sessions = excluded.can_manage_sessions,
      can_manage_integrations = excluded.can_manage_integrations,
      is_active = excluded.is_active;

select is(
  (select integration_key
   from public.service_authorize_instagram_connection(
     '66666666-6666-4666-8666-666666666666',
     'a1111111-1111-4111-8111-111111111111'
   )),
  'vladimir-instagram',
  'the trusted connector can authorize an active owner membership without a browser-supplied profile id'
);
"""

replace_once(
    'supabase/tests/220_instagram_channel.sql',
    """select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);


select is(
  (select integration_key
   from public.service_authorize_instagram_connection(
     (select profile_id from crm_private.profile_access where role = 'owner' and is_active limit 1),
     'a1111111-1111-4111-8111-111111111111'
   )),
  'vladimir-instagram',
  'the trusted connector can authorize an active owner membership without a browser-supplied profile id'
);
""",
    fixture,
)
