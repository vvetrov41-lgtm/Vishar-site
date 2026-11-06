-- Annual welcome uses the existing Instagram inbound transaction and outbox.
-- No provider calls, backfill, or activation occur in this migration.
create table crm_private.instagram_welcome_controls (
  artist_id uuid not null references public.artists(id),
  instagram_account_id text not null check (instagram_account_id ~ '^[0-9]{5,40}$'),
  integration_key text not null,
  website text not null check (website in ('https://vishartattoo.com','https://www.kristinavishar.com')),
  mode text not null default 'off' check (mode in ('off','test','live')),
  test_contacts text[] not null default '{}',
  meta_instant_reply_disabled boolean not null default false,
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (artist_id, instagram_account_id),
  check (mode='off' or (meta_instant_reply_disabled and activated_at is not null)),
  check (mode<>'test' or cardinality(test_contacts)>0)
);
create table crm_private.instagram_welcome_contacts (
  artist_id uuid not null references public.artists(id),
  instagram_account_id text not null,
  external_contact_id text not null check (external_contact_id ~ '^[0-9]{5,40}$'),
  state text not null check (state in ('reserved','sending','sent','unknown','unsent')),
  cycle integer not null default 1 check (cycle>0),
  -- Deliberately no cascading FKs to messages/conversations/outbox: deleting a
  -- conversation or reconnecting must never erase the delivery guard.
  outbox_id uuid,
  inbound_message_id uuid,
  reserved_at timestamptz not null default now(),
  send_started_at timestamptz,
  last_sent_at timestamptz,
  next_eligible_at timestamptz,
  provider_message_id text,
  updated_at timestamptz not null default now(),
  primary key (artist_id,instagram_account_id,external_contact_id),
  unique (outbox_id)
);
alter table crm_private.instagram_welcome_controls enable row level security;
alter table crm_private.instagram_welcome_contacts enable row level security;
revoke all on crm_private.instagram_welcome_controls, crm_private.instagram_welcome_contacts
 from public, anon, authenticated, service_role;

insert into crm_private.instagram_welcome_controls(artist_id,instagram_account_id,integration_key,website)
select i.artist_id,i.configuration->>'instagram_user_id',i.integration_key,
 case when i.integration_key='vladimir-instagram' then 'https://vishartattoo.com'
 else 'https://www.kristinavishar.com' end
from public.artist_integrations i
where i.integration_type='instagram' and i.integration_key in ('vladimir-instagram','kristina-instagram')
 and i.configuration->>'instagram_user_id' ~ '^[0-9]{5,40}$';

create function crm_private.instagram_welcome_anniversary(p_sent_at timestamptz)
returns timestamptz language sql immutable strict
set search_path=pg_catalog
as $$ select ((p_sent_at at time zone 'Europe/London') + interval '12 months') at time zone 'Europe/London' $$;
revoke all on function crm_private.instagram_welcome_anniversary(timestamptz) from public,anon,authenticated,service_role;

create function crm_private.instagram_welcome_text(p_website text)
returns text language sql immutable strict set search_path=pg_catalog
as $fn$ select 'Hi! Thanks for your message.

If you’re getting in touch about a tattoo and would like a quicker, more complete reply, please fill in this short enquiry form:
' || p_website || '/booking/

It helps me understand your idea, review your references and give you a more accurate answer.

You can also find answers to common questions here:
' || p_website || '/faq/

Not messaging about a tattoo? Just ignore the links above and send me your message here.' $fn$;
revoke all on function crm_private.instagram_welcome_text(text) from public,anon,authenticated,service_role;

create function public.service_set_instagram_welcome_mode(
 p_artist_id uuid,p_instagram_account_id text,p_mode text,
 p_test_contacts text[] default '{}',p_meta_instant_reply_disabled boolean default false
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $$
declare v_control crm_private.instagram_welcome_controls%rowtype;
begin
 if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
 if p_mode is null or p_mode not in ('off','test','live') or p_test_contacts is null
 or cardinality(p_test_contacts)>20 or exists(select 1 from unnest(p_test_contacts) x where x is null or x !~ '^[0-9]{5,40}$')
 or (p_mode<>'off' and not coalesce(p_meta_instant_reply_disabled,false))
 or (p_mode='test' and cardinality(p_test_contacts)=0)
 then raise exception 'invalid welcome control or Meta cutover not confirmed' using errcode='22023'; end if;
 select * into v_control from crm_private.instagram_welcome_controls
 where artist_id=p_artist_id and instagram_account_id=p_instagram_account_id for update;
 if not found then raise exception 'welcome account unavailable' using errcode='22023'; end if;
 if p_mode<>'off' and not exists(select 1 from public.artist_integrations i
 where i.artist_id=p_artist_id and i.integration_type='instagram' and i.is_enabled
 and i.integration_key=v_control.integration_key
 and i.configuration->>'instagram_user_id'=p_instagram_account_id)
 then raise exception 'welcome route unavailable' using errcode='22023'; end if;
 update crm_private.instagram_welcome_controls set mode=p_mode,test_contacts=p_test_contacts,
 meta_instant_reply_disabled=coalesce(p_meta_instant_reply_disabled,false),
 activated_at=case when mode='off' and p_mode<>'off' then clock_timestamp() else activated_at end,
 updated_at=clock_timestamp()
 where artist_id=p_artist_id and instagram_account_id=p_instagram_account_id;
 return jsonb_build_object('mode',p_mode,'artist_id',p_artist_id);
end $$;
revoke all on function public.service_set_instagram_welcome_mode(uuid,text,text,text[],boolean) from public,anon,authenticated;
grant execute on function public.service_set_instagram_welcome_mode(uuid,text,text,text[],boolean) to service_role;

create function crm_private.queue_instagram_annual_welcome()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $$
declare
 c public.communication_conversations%rowtype;
 cfg crm_private.instagram_welcome_controls%rowtype;
 r crm_private.instagram_welcome_contacts%rowtype;
 account_id text;
 message_id uuid;
 job_id uuid;
begin
 if new.channel<>'instagram' or new.direction<>'inbound' or new.origin<>'contact'
 or new.status<>'received' then return new; end if;
 select * into c from public.communication_conversations where id=new.conversation_id;
 if c.state<>'open' or c.artist_id<>new.artist_id then return new; end if;
 select i.configuration->>'instagram_user_id' into account_id
 from public.artist_integrations i where i.artist_id=c.artist_id
 and i.integration_type='instagram' and i.integration_key=c.integration_key and i.is_enabled;
 select * into cfg from crm_private.instagram_welcome_controls w
 where w.artist_id=c.artist_id and w.instagram_account_id=account_id
 and w.integration_key=c.integration_key for share;
 if not found or cfg.mode='off' or not cfg.meta_instant_reply_disabled
 or new.provider_timestamp is null or new.provider_timestamp<cfg.activated_at
 or new.provider_timestamp<clock_timestamp()-interval '23 hours'
 or new.provider_timestamp>clock_timestamp()+interval '5 minutes'
 or (cfg.mode='test' and not (c.external_contact_id=any(cfg.test_contacts)))
 then return new; end if;
 if c.client_id is not null and exists(select 1 from public.communication_suppressions s
 where s.client_id=c.client_id and s.channel='instagram' and s.is_active)
 then return new; end if;
 insert into crm_private.instagram_welcome_contacts(artist_id,instagram_account_id,external_contact_id,state)
 values(c.artist_id,account_id,c.external_contact_id,'unsent') on conflict do nothing;
 select * into r from crm_private.instagram_welcome_contacts w
 where w.artist_id=c.artist_id and w.instagram_account_id=account_id
 and w.external_contact_id=c.external_contact_id for update;
 if r.state in ('reserved','sending','unknown')
 or (r.next_eligible_at is not null and clock_timestamp()<r.next_eligible_at)
 then return new; end if;
 -- A new inbound must also postdate the previous success, even on anniversary.
 if r.last_sent_at is not null and new.provider_timestamp<=r.last_sent_at then return new; end if;
 insert into public.communication_messages(conversation_id,artist_id,channel,direction,origin,status,message_type,body)
 values(c.id,c.artist_id,'instagram','outbound','automation','queued','text',
 crm_private.instagram_welcome_text(cfg.website)) returning id into message_id;
 insert into public.integration_outbox(kind,dedupe_key,payload,artist_id,client_id,communication_message_id,max_attempts)
 values('instagram_message','instagram:welcome:'||c.artist_id||':'||account_id||':'||c.external_contact_id||':'||r.cycle,
 jsonb_build_object('communication_message_id',message_id),c.artist_id,c.client_id,message_id,1)
 returning id into job_id;
 update crm_private.instagram_welcome_contacts set state='reserved',outbox_id=job_id,
 inbound_message_id=new.id,reserved_at=clock_timestamp(),send_started_at=null,
 provider_message_id=null,updated_at=clock_timestamp()
 where artist_id=c.artist_id and instagram_account_id=account_id and external_contact_id=c.external_contact_id;
 return new;
end $$;
revoke all on function crm_private.queue_instagram_annual_welcome() from public,anon,authenticated,service_role;
create trigger instagram_annual_welcome_inbound after insert on public.communication_messages
for each row when (new.channel='instagram' and new.direction='inbound' and new.origin='contact')
execute function crm_private.queue_instagram_annual_welcome();

-- The existing send intent remains the single provider-call boundary for all
-- clients. Ordinary replies and WhatsApp keep the same path unchanged.
create or replace function public.service_begin_communication_send(p_outbox_id uuid,p_worker_id text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $$
declare
 v_job public.integration_outbox%rowtype;
 r crm_private.instagram_welcome_contacts%rowtype;
 cfg crm_private.instagram_welcome_controls%rowtype;
 c public.communication_conversations%rowtype;
begin
 if not crm_private.is_service_backend() then
 raise exception 'communication send intent is backend-only' using errcode='42501'; end if;
 select * into v_job from public.integration_outbox o where o.id=p_outbox_id
 and o.kind in ('whatsapp_message','instagram_message') for update;
 if not found then raise exception 'communication outbox job is unavailable' using errcode='22023'; end if;
 if v_job.status<>'leased' or v_job.leased_by is distinct from p_worker_id then
 raise exception 'communication outbox lease is not owned by this worker' using errcode='42501'; end if;
 if v_job.provider_send_started_at is not null then return jsonb_build_object('proceed',false,'reason','send_result_unknown'); end if;
 if v_job.dedupe_key like 'instagram:welcome:%' then
   select * into r from crm_private.instagram_welcome_contacts w where w.outbox_id=p_outbox_id;
   if not found or r.state<>'reserved' then return jsonb_build_object('proceed',false,'reason','welcome_blocked'); end if;
   -- Lock order: outbox -> control -> contact. Enqueue never locks old outbox.
   select * into cfg from crm_private.instagram_welcome_controls w
   where w.artist_id=r.artist_id and w.instagram_account_id=r.instagram_account_id for share;
   if not found or cfg.mode='off' or not cfg.meta_instant_reply_disabled
   or (cfg.mode='test' and not (r.external_contact_id=any(cfg.test_contacts)))
   then return jsonb_build_object('proceed',false,'reason','welcome_disabled'); end if;
   select * into r from crm_private.instagram_welcome_contacts w where w.outbox_id=p_outbox_id for update;
   select c0.* into c from public.communication_conversations c0
   join public.communication_messages m on m.conversation_id=c0.id where m.id=v_job.communication_message_id;
   if c.id is null or c.artist_id<>r.artist_id or v_job.artist_id<>r.artist_id
   or c.channel<>'instagram' or c.external_contact_id<>r.external_contact_id or c.state<>'open'
   or c.integration_key<>cfg.integration_key
   or r.reserved_at<cfg.activated_at
   or r.state<>'reserved'
   or not exists(select 1 from public.communication_messages m where m.id=r.inbound_message_id
     and m.provider_timestamp>clock_timestamp()-interval '23 hours' and m.direction='inbound' and m.origin='contact')
   or not exists(select 1 from public.artist_integrations i where i.artist_id=r.artist_id
     and i.integration_type='instagram' and i.is_enabled and i.integration_key=c.integration_key
     and i.configuration->>'instagram_user_id'=r.instagram_account_id)
   or exists(select 1 from public.communication_suppressions s where s.client_id=c.client_id
     and s.channel='instagram' and s.is_active)
   then return jsonb_build_object('proceed',false,'reason','welcome_ineligible'); end if;
   update crm_private.instagram_welcome_contacts set state='sending',send_started_at=clock_timestamp(),updated_at=clock_timestamp()
   where outbox_id=p_outbox_id;
 end if;
 update public.integration_outbox set provider_send_started_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_outbox_id;
 return jsonb_build_object('proceed',true);
end $$;

create function crm_private.record_instagram_welcome_result()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare v_sent_at timestamptz;
begin
 if new.status='succeeded' then
   select coalesce(m.sent_at,clock_timestamp()) into v_sent_at from public.communication_messages m
   where m.id=new.communication_message_id;
   v_sent_at:=coalesce(v_sent_at,clock_timestamp());
   update crm_private.instagram_welcome_contacts set state='sent',last_sent_at=v_sent_at,
     next_eligible_at=crm_private.instagram_welcome_anniversary(v_sent_at),cycle=cycle+1,
     updated_at=clock_timestamp()
   where outbox_id=new.id and state in ('reserved','sending');
 elsif new.status in ('failed','dead') then
   update crm_private.instagram_welcome_contacts set
     state=case when new.last_error_code='communication_send_result_unknown'
       or new.provider_send_started_at is not null then 'unknown' else 'unsent' end,
     cycle=cycle+1,updated_at=clock_timestamp()
   where outbox_id=new.id and state in ('reserved','sending');
 end if;
 return new;
end $$;
revoke all on function crm_private.record_instagram_welcome_result() from public,anon,authenticated,service_role;
create trigger instagram_annual_welcome_result after update of status on public.integration_outbox
for each row when (new.kind='instagram_message' and new.dedupe_key like 'instagram:welcome:%' and new.status is distinct from old.status)
execute function crm_private.record_instagram_welcome_result();
