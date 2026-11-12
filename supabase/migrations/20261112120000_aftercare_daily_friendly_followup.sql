-- Aftercare for consecutive sessions: full guide once, gentle reminder on later days.
-- The first session day's message and the 24h check-in after the final day stay unchanged.
-- No production jobs are replayed, no provider templates are altered and no sends
-- are triggered by this migration. Meta-approved WhatsApp aftercare remains for
-- day one only; later-day messages use the existing safe email fallback until
-- a separately approved WhatsApp reminder template exists.

CREATE OR REPLACE FUNCTION crm_private.lifecycle_aftercare_followup(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $followup$
  SELECT EXISTS (
    SELECT 1
    FROM crm_private.session_lifecycle_block(p_session_id) current_day
    JOIN crm_private.session_lifecycle_block(p_session_id) earlier_day
      ON earlier_day.local_day < current_day.local_day
    WHERE current_day.session_id = p_session_id
  );
$followup$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_aftercare_followup(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

DO $disposition$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('crm_private.lifecycle_block_disposition(uuid)'::regprocedure)
    INTO v_source;

  v_old := $old$  v_anchor uuid;
  v_other_consumed boolean;$old$;
  v_new := $new$  v_anchor uuid;
  v_other_consumed boolean;
  v_aftercare_day date;$new$;
  IF v_source IS NULL OR length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle disposition declaration changed'; END IF;
  v_source:=replace(v_source,v_old,v_new);

  v_old := $old$  if not exists (select 1 from crm_private.session_lifecycle_block(v_session.id))
  then return 'ineligible'; end if;$old$;
  v_new := $new$  if not exists (select 1 from crm_private.session_lifecycle_block(v_session.id))
  then return 'ineligible'; end if;
  select b.local_day into v_aftercare_day
  from crm_private.session_lifecycle_block(v_session.id) b
  where b.session_id=v_session.id;
  if v_aftercare_day is null then return 'ineligible'; end if;$new$;
  IF length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle block membership contract changed'; END IF;
  v_source:=replace(v_source,v_old,v_new);

  v_old := $old$      and j.status='completed'
      and not ($old$;
  v_new := $new$      and j.status='completed'
      -- Reminders and 24h check-ins are once per block, but aftercare
      -- is once per LOCAL DAY. The same-day duplicate is still blocked.
      and (v_job.message_purpose<>'post_session_aftercare'
           or b.local_day=v_aftercare_day)
      and not ($new$;
  IF length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle deduplication contract changed'; END IF;
  v_source:=replace(v_source,v_old,v_new);

  v_old := $old$    where s.status='completed'
    order by b.end_at,b.session_id limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;$old$;
  v_new := $new$    where s.status='completed' and b.local_day=v_aftercare_day
    order by b.end_at,b.session_id limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;$new$;
  IF length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle aftercare anchor contract changed'; END IF;
  v_source:=replace(v_source,v_old,v_new);

  v_old := $old$  if v_anchor is distinct from v_session.id then return 'defer'; end if;
  return 'eligible';$old$;
  v_new := $new$  if v_anchor is distinct from v_session.id then return 'defer'; end if;
  -- When enabling this behaviour, previously blocked second-day jobs can
  -- still be pending. Do not suddenly message clients many hours/days late.
  if v_job.message_purpose='post_session_aftercare'
     and crm_private.lifecycle_aftercare_followup(v_session.id)
     and v_job.scheduled_at<now()-interval '6 hours'
  then return 'defer'; end if;
  return 'eligible';$new$;
  IF length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle eligible return changed'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$disposition$;

-- The original HTML guide template is generated earlier in alphabetical
-- BEFORE INSERT trigger order. Modify only new second-or-later-day
-- system aftercare emails, retaining the approved per-artist guide URL.
CREATE OR REPLACE FUNCTION crm_private.decorate_aftercare_followup_email()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $copy$
DECLARE
  v_session_id uuid;
  v_guide text;
BEGIN
  IF new.created_by_kind IS DISTINCT FROM 'system'
    OR new.template_key IS DISTINCT FROM 'post_session_aftercare'
    OR new.automation_job_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT j.session_id INTO v_session_id
  FROM public.automation_jobs j
  WHERE j.id=new.automation_job_id
    AND j.artist_id=new.artist_id
    AND j.message_purpose='post_session_aftercare';
  IF v_session_id IS NULL
     OR NOT crm_private.lifecycle_aftercare_followup(v_session_id) THEN
    RETURN new;
  END IF;

  SELECT substring(t.body from 'https://[a-z0-9.-]+/aftercare/')
    INTO v_guide
  FROM public.message_templates t
  JOIN public.artists a ON a.id=new.artist_id
  WHERE t.workspace_id=a.workspace_id
    AND (t.artist_id=new.artist_id OR t.artist_id IS NULL)
    AND t.purpose='post_session_aftercare' AND t.channel='email'
    AND t.locale='en' AND t.status='active'
    AND t.version=new.template_version
  ORDER BY (t.artist_id IS NOT NULL) DESC,t.id
  LIMIT 1;

  IF v_guide IS NULL OR new.html_body IS NULL
     OR position('Thank you for today.' in new.html_body)=0
     OR position('Your fresh tattoo deserves the right care from day one.' in new.html_body)=0
  THEN
    RAISE EXCEPTION 'approved aftercare reminder template unavailable'
      USING errcode='23514';
  END IF;

  new.subject:='A quick reminder about your tattoo aftercare';
  new.body:=crm_private.render_lifecycle_template_text(
    E'Hi {{client_first_name}},\n\nHope today''s session went well! Just a friendly reminder to keep following the aftercare we discussed, even between sessions.\n\nYou can check the same guide here:\n',
    v_session_id
  ) || v_guide || E'\n\nIf you have any questions, just reply and I''ll help.';

  new.html_body:=replace(new.html_body,'Thank you for today.','A quick aftercare reminder.');
  new.html_body:=replace(new.html_body,
    'I hope your tattoo session went well. Your fresh tattoo deserves the right care from day one.',
    'Hope today''s session went well! Just a friendly reminder to keep following the aftercare we discussed, even between sessions.');
  new.html_body:=replace(new.html_body,
    'Open your aftercare guide and follow the healing method we discussed in the studio.',
    'You can use the same guide to double-check any step whenever you need to.');
  new.html_body:=replace(new.html_body,'TATTOO AFTERCARE','AFTERCARE REMINDER');
  RETURN new;
END;
$copy$;
REVOKE ALL ON FUNCTION crm_private.decorate_aftercare_followup_email()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER email_messages_z_aftercare_followup_copy
BEFORE INSERT ON public.email_messages
FOR EACH ROW EXECUTE FUNCTION crm_private.decorate_aftercare_followup_email();

-- Instagram can send freely only while the provider's 24-hour window is open.
-- Its existing enqueue validations and fallback are deliberately unchanged.
DO $instagram$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('crm_private.queue_lifecycle_instagram_job(uuid)'::regprocedure)
    INTO v_source;
  v_old:=$old$   IF j.message_purpose='post_session_aftercare' THEN
     v_text:='Hi '||v_first||', thanks for coming in for your tattoo session. Your aftercare guide: '||v_guide
       ||'. Reply here if you need advice.';
   ELSE$old$;
  v_new:=$new$   IF j.message_purpose='post_session_aftercare' THEN
     IF crm_private.lifecycle_aftercare_followup(s.id) THEN
       v_text:='Hi '||v_first||', hope today went well! Just a friendly reminder to keep up with the aftercare we discussed between sessions. The same guide is here: '||v_guide
         ||'. Any questions, just message me.';
     ELSE
       v_text:='Hi '||v_first||', thanks for coming in for your tattoo session. Your aftercare guide: '||v_guide
         ||'. Reply here if you need advice.';
     END IF;
   ELSE$new$;
  IF v_source IS NULL OR length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'Instagram aftercare copy changed'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$instagram$;

-- For second-day aftercare, reusing the APPROVED Meta v2 would send the same
-- instruction again. Until a DIFFERENT Meta-approved reminder template exists,
-- follow the existing email fallback path rather than inventing provider text.
-- Direct WhatsApp enqueue callers must fail closed too.
DO $whatsapp_guard$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure)
    INTO v_source;
  v_old:=$old$  select * into a from public.artists where id=j.artist_id and is_active;
  if s.id is null or a.id is null$old$;
  v_new:=$new$  select * into a from public.artists where id=j.artist_id and is_active;
  -- Meta's day-one template has a fixed approved body. Never replay it as a
  -- friendly follow-up; a dedicated reminder needs separate Meta approval.
  if j.message_purpose='post_session_aftercare'
     and crm_private.lifecycle_aftercare_followup(s.id) then
    return 'unavailable';
  end if;
  if s.id is null or a.id is null$new$;
  IF v_source IS NULL OR length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'WhatsApp aftercare enqueue boundary changed'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$whatsapp_guard$;

DO $email_fallback$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('crm_private.execute_client_lifecycle_job(uuid)'::regprocedure)
    INTO v_source;
  v_old:=$old$  -- Resolve at the scheduled execution time, not only on enrolment.
  -- A previously recorded one-time fallback must not retry the same WhatsApp$old$;
  v_new:=$new$  -- A later-day aftercare is a FRIENDLY reminder, not a repeat of
  -- the immutable Meta-approved day-one instruction. Until a distinct Meta
  -- template is approved, use the existing scoped Email fallback.
  if v_job.message_purpose='post_session_aftercare'
     and crm_private.lifecycle_aftercare_followup(v_session.id)
     and crm_private.lifecycle_selected_channel(
       v_session.client_id,v_job.artist_id)='whatsapp' then
    insert into crm_private.lifecycle_email_fallbacks (
      job_id,artist_id,client_id,reason
    ) values (
      v_job.id,v_job.artist_id,v_session.client_id,'whatsapp_unavailable'
    ) on conflict(job_id) do nothing;
  end if;

  -- Resolve at the scheduled execution time, not only on enrolment.
  -- A previously recorded one-time fallback must not retry the same WhatsApp$new$;
  IF v_source IS NULL OR length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
  THEN RAISE EXCEPTION 'lifecycle WhatsApp channel selection changed'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$email_fallback$;
