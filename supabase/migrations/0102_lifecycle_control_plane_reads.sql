-- 0102_lifecycle_control_plane_reads.sql
--
-- Safe browser read surfaces for the existing client lifecycle control plane.
--
-- The underlying message_templates table deliberately remains backend-only.
-- These functions expose only lifecycle policy/template metadata to a signed-in
-- profile that currently has view_automations on the requested artist.
--
-- No rule, template, provider configuration or runtime flag is created or
-- enabled by this migration. Applying it cannot send a client message.

create or replace function public.list_client_lifecycle_templates(
  p_artist_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  artist_id uuid,
  template_scope text,
  purpose text,
  classification public.message_classification,
  purpose_description text,
  channel public.message_template_channel,
  locale text,
  version integer,
  status public.message_template_status,
  subject text,
  body text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    t.id,
    t.workspace_id,
    t.artist_id,
    case when t.artist_id is null then 'workspace' else 'artist' end,
    t.purpose,
    p.classification,
    p.description,
    t.channel,
    t.locale,
    t.version,
    t.status,
    t.subject,
    t.body,
    t.created_at,
    t.updated_at
  from public.artists a
  join public.message_templates t
    on t.workspace_id = a.workspace_id
   and (t.artist_id is null or t.artist_id = a.id)
  join public.message_template_purposes p on p.purpose = t.purpose
  where a.id = p_artist_id
    and public.is_active_user()
    and crm_private.has_artist_capability(a.id, 'view_automations')
    and t.channel = 'email'::public.message_template_channel
    and p.classification = 'service'::public.message_classification
  order by t.purpose, t.locale, t.artist_id nulls first, t.version desc, t.id;
$$;

comment on function public.list_client_lifecycle_templates(uuid) is
  'Lists only service email templates usable by lifecycle automation in the requested artist scope. Does not expose created_by, provider state or client data.';

create or replace function public.list_client_lifecycle_template_purposes(
  p_artist_id uuid
)
returns table (
  purpose text,
  classification public.message_classification,
  description text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select p.purpose, p.classification, p.description
  from public.message_template_purposes p
  where public.is_active_user()
    and crm_private.has_artist_capability(p_artist_id, 'view_automations')
    and p.classification = 'service'::public.message_classification
  order by p.purpose;
$$;

comment on function public.list_client_lifecycle_template_purposes(uuid) is
  'Lists the service-purpose vocabulary available to lifecycle templates for a caller who can view automations on the requested artist.';

create or replace function public.list_client_lifecycle_template_variables(
  p_artist_id uuid
)
returns table (
  variable text,
  description text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select v.variable, v.description
  from public.message_template_variables v
  where public.is_active_user()
    and crm_private.has_artist_capability(p_artist_id, 'view_automations')
  order by v.variable;
$$;

comment on function public.list_client_lifecycle_template_variables(uuid) is
  'Lists the catalogued template variables for a caller who can view automations on the requested artist. The catalogue contains no client values.';

revoke all on function public.list_client_lifecycle_templates(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_client_lifecycle_template_purposes(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_client_lifecycle_template_variables(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_client_lifecycle_templates(uuid) to authenticated;
grant execute on function public.list_client_lifecycle_template_purposes(uuid) to authenticated;
grant execute on function public.list_client_lifecycle_template_variables(uuid) to authenticated;
