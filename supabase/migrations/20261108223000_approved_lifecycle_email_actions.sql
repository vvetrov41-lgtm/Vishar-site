-- Approved first-person lifecycle Emails (72h, 24h, consultation).
-- All changes are one migration transaction: renderer, action capabilities,
-- reviewed templates, HTML buttons and artist-specific locations activate together.
-- Existing queued/sent emails are immutable and remain untouched.
-- No real client messages, booking rows, appointment actions or payments are created.

DO $patch_lifecycle$
DECLARE
  v_fn text := pg_get_functiondef(
    'crm_private.execute_client_lifecycle_job(uuid)'::regprocedure
  );
  v_old text := $old$
  v_actions_required := v_template.purpose in (
      'session_reminder_24h',
      'consultation_reminder'
    )
    and (
      position('{{confirm_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{reschedule_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{cancel_link}}' in coalesce(v_template.body, '')) > 0
    );

  if v_actions_required
     and (
       position('{{confirm_link}}' in coalesce(v_template.body, '')) = 0
       or position('{{reschedule_link}}' in coalesce(v_template.body, '')) = 0
       or position('{{cancel_link}}' in coalesce(v_template.body, '')) = 0
     ) then
$old$;
  v_new text := $new$
  -- Preserve old three-action templates for already scheduled jobs, but
  -- enable the reviewed action shapes: 72h C+R, 24h R, consultation C+R.
  v_actions_required := v_template.purpose in (
      'session_reminder_72h',
      'session_reminder_24h',
      'consultation_reminder'
    )
    and (
      position('{{confirm_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{reschedule_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{cancel_link}}' in coalesce(v_template.body, '')) > 0
    );

  if v_actions_required and not (
    (
      v_template.purpose='session_reminder_72h'
      and position('{{confirm_link}}' in v_template.body)>0
      and position('{{reschedule_link}}' in v_template.body)>0
      and position('{{cancel_link}}' in v_template.body)=0
    ) or (
      v_template.purpose='session_reminder_24h'
      and position('{{reschedule_link}}' in v_template.body)>0
      and (
        (position('{{confirm_link}}' in v_template.body)=0
         and position('{{cancel_link}}' in v_template.body)=0)
        or
        (position('{{confirm_link}}' in v_template.body)>0
         and position('{{cancel_link}}' in v_template.body)>0)
      )
    ) or (
      v_template.purpose='consultation_reminder'
      and position('{{confirm_link}}' in v_template.body)>0
      and position('{{reschedule_link}}' in v_template.body)>0
      -- Legacy 3-action consultation messages are still valid for fallback.
    )
  ) then
$new$;
  v_before_dual text := $du_old$
  -- Resolve at the scheduled execution time, not only on enrolment.
$du_old$;
  v_after_dual text := $du_new$
  -- If an appointment was made late and both windows are already due,
  -- the 24h reminder takes precedence. Never deliver two same-tick
  -- reminders or create competing confirmation capabilities.
  if v_job.message_purpose='session_reminder_72h'
     and v_job.artist_id in (
       'a1111111-1111-4111-8111-111111111111'::uuid,
       'a2222222-2222-4222-8222-222222222222'::uuid
     )
     and v_session.start_at <= now()+interval '24 hours'
     and exists (
       select 1 from public.automation_jobs j24
       where j24.session_id=v_session.id
         and j24.artist_id=v_job.artist_id
         and j24.message_purpose='session_reminder_24h'
         and j24.status='pending'
         and j24.scheduled_at<=now()
     ) then
    update public.automation_jobs
    set status='cancelled',cancelled_at=now(),
        last_error_category='appointment_ineligible'
    where id=p_job_id;
    return 'cancelled';
  end if;

  -- Resolve at the scheduled execution time, not only on enrolment.
$du_new$;
  v_before_confirm text := $c_old$
        if v_job.message_purpose='session_reminder_24h' then
          perform crm_private.register_lifecycle_confirmation(v_confirm_token,v_session.id);
        end if;
$c_old$;
  v_after_confirm text := $c_new$
        -- Group snapshots are issued only for an exposed confirmation URL.
        -- The legacy 24h three-link email remains supported during rollout.
        if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h')
           and position('{{confirm_link}}' in v_template.body)>0 then
          perform crm_private.register_lifecycle_confirmation(v_confirm_token,v_session.id);
        end if;
$c_new$;
BEGIN
  IF position(v_new IN v_fn)>0 THEN RETURN; END IF;
  IF position(v_old IN v_fn)=0 OR position(v_before_confirm IN v_fn)=0
     OR position(v_before_dual IN v_fn)=0 THEN
    RAISE EXCEPTION 'Unexpected live lifecycle executor; refusing template rollout'
      USING errcode='23514';
  END IF;
  v_fn := replace(v_fn,v_old,v_new);
  v_fn := replace(v_fn,v_before_confirm,v_after_confirm);
  v_fn := replace(v_fn,v_before_dual,v_after_dual);
  EXECUTE v_fn;
END;
$patch_lifecycle$;

CREATE OR REPLACE FUNCTION crm_private.render_approved_lifecycle_email_html(
  p_session_id uuid,
  p_purpose text,
  p_body text
)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $render$
DECLARE
  v_row record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_urls text[];
  v_expected integer;
  v_first_name text;
  v_when text;
  v_title text;
  v_description text;
  v_extra text := '';
  v_actions text := '';
  v_reschedule_url text;
  v_confirm_url text;
  v_confirm_label text;
  v_kind public.appointment_type;
BEGIN
  IF p_session_id IS NULL
     OR p_purpose NOT IN ('session_reminder_72h','session_reminder_24h','consultation_reminder')
     OR nullif(btrim(coalesce(p_body,'')),'') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.appointment_type,s.start_at,a.timezone,c.full_name,
         a.display_name AS artist_name,a.id AS artist_id
    INTO v_row
  FROM public.sessions s
  JOIN public.clients c ON c.id=s.client_id AND c.archived_at IS NULL
  JOIN public.artists a ON a.id=s.artist_id
  WHERE s.id=p_session_id AND s.status='confirmed'::public.session_status;
  IF NOT FOUND OR v_row.artist_id NOT IN (
      'a1111111-1111-4111-8111-111111111111'::uuid,
      'a2222222-2222-4222-8222-222222222222'::uuid
  ) THEN RETURN NULL; END IF;

  SELECT * INTO v_settings FROM crm_private.booking_card_artist_settings
  WHERE artist_id=v_row.artist_id AND email_enabled;
  IF NOT FOUND
     OR nullif(btrim(v_settings.arrival_guide_url),'') IS NULL
     OR nullif(btrim(v_settings.preparation_guide_url),'') IS NULL
  THEN RETURN NULL; END IF;

  v_urls := crm_private.consultation_reminder_action_urls(p_body);
  v_expected := cardinality(v_urls);
  IF NOT (
    (p_purpose='session_reminder_72h' AND v_expected=2)
    OR (p_purpose='session_reminder_24h' AND v_expected IN (1,3))
    OR (p_purpose='consultation_reminder' AND v_expected IN (2,3))
  ) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_urls) u
    GROUP BY u HAVING count(*)>1
  ) THEN RETURN NULL; END IF;

  IF p_purpose='session_reminder_24h' THEN
    v_reschedule_url := CASE WHEN v_expected=3 THEN v_urls[2] ELSE v_urls[1] END;
  ELSE
    v_confirm_url := v_urls[1];
    v_reschedule_url := v_urls[2];
  END IF;

  v_first_name := split_part(btrim(v_row.full_name),' ',1);
  v_when := to_char(v_row.start_at AT TIME ZONE v_row.timezone,'FMDay, FMDD FMMonth YYYY')
      || ' at ' || to_char(v_row.start_at AT TIME ZONE v_row.timezone,'HH24:MI');
  v_kind := v_row.appointment_type;

  IF p_purpose='session_reminder_72h' THEN
    IF v_kind NOT IN ('tattoo_session'::public.appointment_type,
                      'touch_up'::public.appointment_type) THEN RETURN NULL; END IF;
    v_title := 'Your tattoo session is coming up in three days';
    v_description := 'Please remember that your deposit is non-refundable if you cancel within 72 hours of your appointment.';
    v_extra := '<p style="margin:18px 0;font-size:14px;color:#ccc;">How to prepare: <a href="'
      || crm_private.booking_card_html_escape(v_settings.preparation_guide_url)
      || '" style="color:#fff;text-decoration:underline;">Preparation guide</a></p>';
    v_confirm_label := 'Confirm attendance';
  ELSIF p_purpose='session_reminder_24h' THEN
    IF v_kind NOT IN ('tattoo_session'::public.appointment_type,
                      'touch_up'::public.appointment_type) THEN RETURN NULL; END IF;
    v_title := 'Your tattoo session is tomorrow';
    v_description := 'No need to reply if everything is still fine. See you tomorrow!';
    v_extra := '<p style="margin:18px 0;font-size:14px;color:#ccc;">Please check the <a href="'
      || crm_private.booking_card_html_escape(v_settings.arrival_guide_url)
      || '" style="color:#fff;text-decoration:underline;">arrival instructions</a> before coming.</p>';
  ELSE
    IF v_kind NOT IN ('in_person_consultation'::public.appointment_type,
                      'video_consultation'::public.appointment_type) THEN RETURN NULL; END IF;
    v_title := CASE WHEN v_kind='video_consultation' THEN 'Your WhatsApp video consultation is tomorrow'
                    ELSE 'Your consultation is tomorrow' END;
    v_description := CASE WHEN v_kind='video_consultation'
      THEN 'I will video call you on WhatsApp at the scheduled time. Please keep your reference images handy.'
      ELSE 'Please bring any reference images or ideas you would like to discuss.' END;
    IF v_kind='in_person_consultation' THEN
      IF nullif(btrim(v_settings.studio_address),'') IS NULL THEN RETURN NULL; END IF;
      v_extra := '<p style="font-size:14px;color:#ddd;">'
        || crm_private.booking_card_html_escape(v_settings.studio_address)
        || '</p><p style="font-size:14px;"><a href="'
        || crm_private.booking_card_html_escape(v_settings.arrival_guide_url)
        || '" style="color:#fff;text-decoration:underline;">Get directions</a></p>';
    END IF;
    v_confirm_label := 'Confirm consultation';
  END IF;

  IF v_confirm_url IS NOT NULL THEN
    v_actions := v_actions || '<a href="'
      || crm_private.booking_card_html_escape(v_confirm_url)
      || '" style="display:block;text-align:center;background:#f5f5f5;color:#151515;'
      || 'border-radius:11px;text-decoration:none;font-size:14px;font-weight:700;'
      || 'padding:14px 18px;margin:16px 0 10px;">'
      || v_confirm_label || '</a>';
  END IF;
  v_actions := v_actions || '<a href="'
    || crm_private.booking_card_html_escape(v_reschedule_url)
    || '" style="display:block;text-align:center;background:#252528;border:1px solid #777;'
    || 'color:#f5f5f5;border-radius:11px;text-decoration:none;font-size:14px;'
    || 'font-weight:700;padding:13px 18px;">Need another time</a>';

  RETURN '<!doctype html><html lang="en"><head><meta name="viewport" '
    || 'content="width=device-width,initial-scale=1"><meta charset="utf-8"></head>'
    || '<body style="background:#111113;margin:0;padding:20px 10px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"'
    || ' style="font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">'
    || '<div style="box-sizing:border-box;max-width:560px;background:#1b1b1d;border:1px solid #38383c;'
    || 'border-radius:16px;padding:26px;color:#fff;text-align:left;">'
    || '<div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#ddd;">'
    || crm_private.booking_card_html_escape(v_row.artist_name)
    || ' / TATTOO</div><div style="border-top:1px solid #45454a;margin:18px 0;"></div>'
    || '<p style="font-size:15px;color:#ddd;">Hi '
    || crm_private.booking_card_html_escape(v_first_name) || ',</p>'
    || '<h1 style="font-size:23px;line-height:31px;margin:12px 0 20px;color:#fff;">'
    || crm_private.booking_card_html_escape(v_title) || '</h1>'
    || '<div style="background:#27272b;border-radius:12px;padding:16px;margin:18px 0;">'
    || '<div style="font-size:11px;color:#bdbdbd;letter-spacing:1.3px;">DATE &amp; TIME</div>'
    || '<div style="font-size:16px;line-height:24px;color:#fff;margin-top:7px;font-weight:700;">'
    || crm_private.booking_card_html_escape(v_when) || '</div></div>'
    || '<p style="font-size:15px;line-height:23px;color:#ddd;">'
    || crm_private.booking_card_html_escape(v_description) || '</p>'
    || v_extra
    || v_actions
    || '<p style="margin:20px 0 0;font-size:12px;line-height:18px;color:#aaa;">'
    || 'Your appointment remains booked unless a different time is agreed. '
    || 'If you have questions, just reply to this email.</p></div></td></tr></table></body></html>';
END;
$render$;

-- The existing consultation BEFORE INSERT trigger points to this function.
-- Replace legacy York House append-only logic with artist current studio
-- settings and first-person WhatsApp call wording.
CREATE OR REPLACE FUNCTION crm_private.decorate_consultation_reminder_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $decorate_consultation$
DECLARE
  v_session record;
  v_address text;
  v_arrival text;
BEGIN
  IF new.automation_job_id IS NULL
     OR new.created_by_kind IS DISTINCT FROM 'system'
     OR new.template_key IS DISTINCT FROM 'consultation_reminder'
     OR new.status IS DISTINCT FROM 'approved'::public.email_message_status
     OR new.html_body IS NOT NULL OR new.booking_card_id IS NOT NULL THEN
    RETURN new;
  END IF;
  SELECT s.id,s.appointment_type,c.email,a.id AS artist_id
    INTO v_session
  FROM public.automation_jobs j
  JOIN public.sessions s ON s.id=j.session_id
  JOIN public.clients c ON c.id=s.client_id
  JOIN public.artists a ON a.id=s.artist_id
  WHERE j.id=new.automation_job_id AND j.artist_id=new.artist_id
    AND j.message_purpose='consultation_reminder'
    AND s.artist_id=new.artist_id AND s.client_id=new.client_id
    AND lower(btrim(c.email))=lower(btrim(new.to_email))
    AND s.appointment_type IN ('in_person_consultation','video_consultation');
  IF NOT FOUND THEN RETURN new; END IF;
  IF v_session.artist_id NOT IN (
    'a1111111-1111-4111-8111-111111111111'::uuid,
    'a2222222-2222-4222-8222-222222222222'::uuid
  ) THEN RETURN new; END IF;

  IF v_session.appointment_type='video_consultation' THEN
    IF position('video call you on WhatsApp' IN new.body)=0 THEN
      new.body:=rtrim(new.body)||E'\n\nI will video call you on WhatsApp at the scheduled time.';
    END IF;
  ELSE
    SELECT b.studio_address,b.arrival_guide_url INTO v_address,v_arrival
    FROM crm_private.booking_card_artist_settings b
    WHERE b.artist_id=new.artist_id;
    IF v_address IS NULL OR v_arrival IS NULL THEN
      RAISE EXCEPTION 'Consultation location unavailable' USING errcode='23514';
    END IF;
    IF position(v_address IN new.body)=0 THEN
      new.body:=rtrim(new.body)||E'\n\nStudio: '||v_address
        ||E'\nArrival instructions: '||v_arrival;
    END IF;
  END IF;
  new.html_body:=crm_private.render_approved_lifecycle_email_html(
    v_session.id,'consultation_reminder',new.body
  );
  IF new.html_body IS NULL THEN
    RAISE EXCEPTION 'Consultation email actions unavailable' USING errcode='23514';
  END IF;
  RETURN new;
END;
$decorate_consultation$;

CREATE OR REPLACE FUNCTION crm_private.decorate_tattoo_reminder_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $decorate_tattoo$
DECLARE v_session_id uuid;
BEGIN
  IF new.automation_job_id IS NULL
     OR new.created_by_kind IS DISTINCT FROM 'system'
     OR new.template_key NOT IN ('session_reminder_72h','session_reminder_24h')
     OR new.status IS DISTINCT FROM 'approved'::public.email_message_status
     OR new.html_body IS NOT NULL OR new.booking_card_id IS NOT NULL
     OR new.artist_id NOT IN (
       'a1111111-1111-4111-8111-111111111111'::uuid,
       'a2222222-2222-4222-8222-222222222222'::uuid
     ) THEN RETURN new;
  END IF;
  SELECT s.id INTO v_session_id
  FROM public.automation_jobs j
  JOIN public.sessions s ON s.id=j.session_id
  JOIN public.clients c ON c.id=s.client_id
  WHERE j.id=new.automation_job_id
    AND j.artist_id=new.artist_id
    AND j.message_purpose=new.template_key
    AND s.artist_id=new.artist_id
    AND s.client_id=new.client_id
    AND lower(btrim(c.email))=lower(btrim(new.to_email));
  IF NOT FOUND THEN RETURN new; END IF;
  new.html_body:=crm_private.render_approved_lifecycle_email_html(
    v_session_id,new.template_key,new.body
  );
  IF new.html_body IS NULL THEN
    RAISE EXCEPTION 'Tattoo reminder email actions unavailable'
      USING errcode='23514';
  END IF;
  RETURN new;
END;
$decorate_tattoo$;

CREATE TRIGGER email_messages_approved_tattoo_reminder_html
BEFORE INSERT ON public.email_messages FOR EACH ROW
EXECUTE FUNCTION crm_private.decorate_tattoo_reminder_email();

REVOKE ALL ON FUNCTION crm_private.render_approved_lifecycle_email_html(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION crm_private.decorate_tattoo_reminder_email()
  FROM PUBLIC,anon,authenticated,service_role;

-- Versioned, artist-scoped copy: do not change workspace defaults, immutable
-- sent messages or already materialized jobs. Explicitly opt the two known
-- artists into the reviewed actions and their own hidden guide URLs.
DO $templates$
DECLARE
  a record;
  v_purpose text;
  v_subject text;
  v_body text;
  v_version integer;
  v_arrival text;
  v_prep text;
  v_action_base text;
BEGIN
  FOR a IN
    SELECT id,workspace_id FROM public.artists
    WHERE id IN (
      'a1111111-1111-4111-8111-111111111111'::uuid,
      'a2222222-2222-4222-8222-222222222222'::uuid
    )
  LOOP
    SELECT b.arrival_guide_url,b.preparation_guide_url,b.client_action_base_url
      INTO v_arrival,v_prep,v_action_base
    FROM crm_private.booking_card_artist_settings b
    WHERE b.artist_id=a.id;
    IF v_arrival NOT LIKE 'https://%' OR v_prep NOT LIKE 'https://%'
       OR v_action_base IS NULL THEN
      RAISE EXCEPTION 'Artist reminder links unavailable'
        USING errcode='23514';
    END IF;

    FOREACH v_purpose IN ARRAY ARRAY[
      'session_reminder_72h','session_reminder_24h','consultation_reminder'
    ] LOOP
      IF v_purpose='session_reminder_72h' THEN
        v_subject:='Your tattoo session in three days | {{appointment_date}}';
        v_body:='Hi {{client_first_name}},'
          || E'\n\nJust a reminder that your tattoo session is coming up in three days.'
          || E'\n\nDate: {{appointment_date}}\nTime: {{appointment_time}}'
          || E'\n\nPlease remember that your deposit is non-refundable if you cancel within 72 hours of your appointment.'
          || E'\n\nYou can find my preparation guide here:\n'||v_prep
          || E'\n\nPlease use the buttons below to let me know if you are still able to make it.'
          || E'\n\nConfirm attendance:\n'||v_action_base||'{{confirm_link}}'
          || E'\n\nNeed another time:\n'||v_action_base||'{{reschedule_link}}';
      ELSIF v_purpose='session_reminder_24h' THEN
        v_subject:='Your tattoo session tomorrow | {{appointment_date}}';
        v_body:='Hi {{client_first_name}},'
          || E'\n\nJust a quick reminder about your tattoo session tomorrow at {{appointment_time}}.'
          || E'\n\nPlease check the arrival instructions before coming:\n'||v_arrival
          || E'\n\nNo need to reply if everything is still fine. See you tomorrow!'
          || E'\n\nNeed another time:\n'||v_action_base||'{{reschedule_link}}';
      ELSE
        v_subject:='Your consultation tomorrow | {{appointment_date}}';
        v_body:='Hi {{client_first_name}},'
          || E'\n\nJust a reminder about our consultation tomorrow, {{appointment_date}} at {{appointment_time}}.'
          || E'\n\nPlease keep any reference images or ideas ready to discuss.'
          || E'\n\nPlease use the buttons below to let me know if the time still works for you.'
          || E'\n\nConfirm consultation:\n'||v_action_base||'{{confirm_link}}'
          || E'\n\nNeed another time:\n'||v_action_base||'{{reschedule_link}}';
      END IF;

      SELECT coalesce(max(t.version),0)+1 INTO v_version
      FROM public.message_templates t WHERE t.artist_id=a.id
        AND t.purpose=v_purpose AND t.channel='email' AND t.locale='en';

      UPDATE public.message_templates SET status='retired'
      WHERE artist_id=a.id AND purpose=v_purpose
        AND channel='email' AND locale='en' AND status='active';

      INSERT INTO public.message_templates(
        workspace_id,artist_id,purpose,channel,locale,version,status,
        subject,body,created_by
      ) VALUES(
        a.workspace_id,a.id,v_purpose,'email','en',v_version,'active',
        v_subject,v_body,NULL
      );
    END LOOP;
  END LOOP;
END;
$templates$;

-- Ensure six artist overrides are active, with no Cancel links or
-- incorrect confirmation stage; fail the entire migration otherwise.
DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.message_templates t
      WHERE t.artist_id IN (
         'a1111111-1111-4111-8111-111111111111'::uuid,
         'a2222222-2222-4222-8222-222222222222'::uuid
      ) AND t.channel='email' AND t.locale='en' AND t.status='active'
        AND t.purpose IN (
          'session_reminder_72h','session_reminder_24h','consultation_reminder')
        AND position('{{cancel_link}}' IN t.body)=0)=6
     AND NOT EXISTS (
       SELECT 1 FROM public.message_templates t
       WHERE t.artist_id IN (
         'a1111111-1111-4111-8111-111111111111'::uuid,
         'a2222222-2222-4222-8222-222222222222'::uuid
       ) AND t.channel='email' AND t.locale='en' AND t.status='active'
       AND t.purpose='session_reminder_24h'
       AND position('{{confirm_link}}' IN t.body)>0
     ) THEN RETURN; END IF;
  RAISE EXCEPTION 'Approved lifecycle email templates did not atomically activate'
    USING errcode='23514';
END;
$verify$;
