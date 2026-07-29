-- supabase/seed.sql
--
-- LOCAL DEVELOPMENT FIXTURES ONLY.
--
-- `supabase db reset` applies this after the migrations. It must never be run
-- against a staging or production project, and the deployment gates in
-- docs/crm/DEPLOYMENT.md do not include it.
--
-- Everything here is obviously fabricated:
--   * every address is on the reserved `.test` TLD (RFC 6761), which can never
--     resolve or receive mail;
--   * every identifier is a fixed, recognisable UUID;
--   * no password is written into this file. Each fixture account is created
--     with a random one, so signing in locally requires setting a password
--     yourself in Supabase Studio (Authentication -> Users -> ... -> Reset).
--
-- No real client, no real enquiry and no real owner identity appears here.

do $$
declare
  v_owner_id   uuid := '00000000-0000-4000-8000-000000000001';
  v_manager_id uuid := '00000000-0000-4000-8000-000000000002';
  v_reader_id  uuid := '00000000-0000-4000-8000-000000000003';
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth schema not present; skipping local seed';
    return;
  end if;

  -- Fixture auth accounts. `encrypted_password` is deliberately random: the
  -- point is to have identities to attach profiles to, not usable logins.
  insert into auth.users (id, email)
  values (v_owner_id, 'owner@vishar-crm.test'),
         (v_manager_id, 'manager@vishar-crm.test'),
         (v_reader_id, 'reader@vishar-crm.test')
  on conflict (id) do nothing;

  -- Promote the fixture owner through the same idempotent path a real owner
  -- would use, so the seed exercises the documented runbook rather than
  -- inserting a privileged row by hand.
  perform public.bootstrap_owner(v_owner_id, 'Local Owner (fixture)');

  insert into public.profiles (id, email, display_name, role, is_active)
  values (v_manager_id, 'manager@vishar-crm.test', 'Local Manager (fixture)', 'booking_manager', true),
         (v_reader_id, 'reader@vishar-crm.test', 'Local Reader (fixture)', 'read_only', true)
  on conflict (id) do nothing;

  raise notice 'Local CRM fixtures created. Set passwords in Supabase Studio before signing in.';
end $$;

-- A single fabricated enquiry, created through the real intake RPC so local
-- development exercises the schema and reconciliation path. The file manifest
-- is left `pending` on purpose: no object is uploaded by a seed, so this row is
-- intentionally absent from the CRM working queue.
do $$
declare
  v_result jsonb;
begin
  if exists (select 1 from public.enquiries where idempotency_key = '00000000-0000-4000-8000-00000000000a') then
    return;
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_result := public.create_enquiry_intake(
    '00000000-0000-4000-8000-00000000000a',
    jsonb_build_object(
      'full_name', 'Fixture Client',
      'email', 'fixture.client@vishar-crm.test',
      'phone', '+44 7700 900000',
      'preferred_contact', 'Email',
      'travelling_from', 'Fixture City'
    ),
    jsonb_build_object(
      'project_type', 'Colour realism',
      'placement', 'Outer forearm',
      'approximate_size', '20 cm',
      'cover_up', 'No',
      'preferred_timing', 'Flexible',
      'idea', 'Fabricated seed enquiry used for local development only.',
      'source', '/booking/',
      'landing_page', 'http://localhost:5173/booking/',
      'privacy_acknowledged', true,
      'privacy_notice_version', '2026-07-29'
    ),
    jsonb_build_array(
      jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 12345)
    )
  );

  raise notice 'Seed enquiry created: %', v_result ->> 'reference_number';
end $$;
