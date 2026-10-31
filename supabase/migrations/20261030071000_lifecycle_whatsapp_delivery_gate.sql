-- Meta Utility template management is separate from client delivery.
-- Even if a Worker provisions and verifies all four templates, delivery
-- remains off until a service-authorised release gate explicitly opens it.
create table crm_private.lifecycle_whatsapp_delivery_gates (
  artist_id uuid primary key references public.artists(id) on delete restrict,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table crm_private.lifecycle_whatsapp_delivery_gates enable row level security;
revoke all on crm_private.lifecycle_whatsapp_delivery_gates
  from public,anon,authenticated,service_role;
insert into crm_private.lifecycle_whatsapp_delivery_gates(artist_id)
select a.id from public.artists a where a.slug in ('vladimir','kristina')
on conflict(artist_id) do nothing;

create or replace function public.service_set_lifecycle_whatsapp_delivery_enabled(
 p_artist_id uuid,p_enabled boolean
)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare
 v_approved integer;
 v_active integer;
begin
 if not crm_private.is_service_backend() then
  raise exception 'lifecycle WhatsApp activation is backend-only' using errcode='42501';
 end if;
 if p_artist_id is null or p_enabled is null then
  raise exception 'explicit artist and boolean are required' using errcode='22023';
 end if;
 if p_enabled then
  select count(*) into v_approved
  from crm_private.lifecycle_whatsapp_template_registry t
  where t.artist_id=p_artist_id
   and t.approval_status='APPROVED'
   and t.provider_template_id is not null
   and t.verified_at>now()-interval '24 hours';
  select count(*) into v_active
  from public.artist_integrations i
  where i.artist_id=p_artist_id and i.integration_type='whatsapp'
   and i.provider='meta_cloud_api' and i.is_enabled;
  if v_approved<>4 or v_active<>1 then
   raise exception 'lifecycle WhatsApp delivery requires four fresh Meta approvals and one active artist route'
    using errcode='23514';
  end if;
 end if;
 update crm_private.lifecycle_whatsapp_delivery_gates g
 set enabled=p_enabled,updated_at=now() where g.artist_id=p_artist_id;
 if not found then
  raise exception 'unknown lifecycle WhatsApp artist' using errcode='22023';
 end if;
 return jsonb_build_object('artist_id',p_artist_id,'enabled',p_enabled);
end;
$function$;
revoke all on function public.service_set_lifecycle_whatsapp_delivery_enabled(uuid,boolean)
 from public,anon,authenticated,service_role;
grant execute on function public.service_set_lifecycle_whatsapp_delivery_enabled(uuid,boolean)
 to service_role;
