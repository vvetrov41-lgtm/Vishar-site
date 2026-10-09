-- The shared aftercare email is Vladimir's; Kristina has her own aftercare guide.
-- Override only Kristina's service template. All existing lifecycle rules and
-- historical queued jobs remain unchanged, and no email is sent on migration.

do $guard$
begin
  if (select count(*) from public.artists a
      join crm_private.artist_state st on st.artist_id=a.id and st.is_active
      where a.slug='kristina') <> 1 then
    raise exception 'Expected one active Kristina artist for aftercare routing';
  end if;
  if (select count(*) from public.message_templates mt
      join public.artists a on a.workspace_id=mt.workspace_id
      where a.slug='kristina'
        and mt.artist_id is null
        and mt.purpose='post_session_aftercare'
        and mt.channel='email' and mt.locale='en' and mt.status='active'
        and position('https://vishartattoo.com/aftercare/' in mt.body)>0) <> 1 then
    raise exception 'Expected one reviewed shared aftercare template';
  end if;
end
$guard$;

insert into public.message_templates (
  workspace_id,artist_id,purpose,channel,locale,version,status,
  subject,body,created_by
)
select a.workspace_id,a.id,mt.purpose,mt.channel,mt.locale,1,
       'active'::public.message_template_status,
       mt.subject,
       replace(mt.body,
         'https://vishartattoo.com/aftercare/',
         'https://www.kristinavishar.com/aftercare/'),
       null
from public.artists a
join crm_private.artist_state st on st.artist_id=a.id and st.is_active
join public.message_templates mt on mt.workspace_id=a.workspace_id
  and mt.artist_id is null
  and mt.purpose='post_session_aftercare'
  and mt.channel='email' and mt.locale='en'
  and mt.status='active'
where a.slug='kristina'
  and not exists (
    select 1 from public.message_templates existing
    where existing.artist_id=a.id and existing.purpose='post_session_aftercare'
      and existing.channel='email' and existing.locale='en'
  );

do $verify$
declare
  n integer;
begin
  select count(*) into n
  from public.message_templates mt
  join public.artists a on a.id=mt.artist_id
  where a.slug='kristina'
    and mt.purpose='post_session_aftercare'
    and mt.channel='email' and mt.locale='en'
    and mt.status='active'
    and position('https://www.kristinavishar.com/aftercare/' in mt.body)>0
    and position('https://vishartattoo.com/aftercare/' in mt.body)=0;
  if n<>1 then
    raise exception 'Kristina aftercare artist template was not activated';
  end if;
  select count(*) into n
  from public.message_templates mt
  join public.artists a on a.workspace_id=mt.workspace_id
  where a.slug='vladimir'
    and mt.artist_id is null
    and mt.purpose='post_session_aftercare'
    and mt.channel='email' and mt.locale='en'
    and mt.status='active'
    and position('https://vishartattoo.com/aftercare/' in mt.body)>0;
  if n<>1 then
    raise exception 'Vladimir shared aftercare template changed unexpectedly';
  end if;
end
$verify$;
