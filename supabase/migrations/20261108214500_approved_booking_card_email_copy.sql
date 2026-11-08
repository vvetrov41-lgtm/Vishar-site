-- Approved first-person booking confirmations, 8 Nov 2026.
-- Email only. WhatsApp Meta-approved templates remain unchanged until provider approval.
-- Preserves the canonical booking-card eligibility, deposit allocation, idempotent
-- delivery, token security, short-lived action capabilities and immutable sent history.
-- There are deliberately NO Confirm/Reschedule/Cancel controls immediately on booking.
-- Keep each artist's links in protected server-side settings, not SQL
-- function source. This also makes future address updates data-only changes.
ALTER TABLE crm_private.booking_card_artist_settings
  ADD COLUMN IF NOT EXISTS arrival_guide_url text,
  ADD COLUMN IF NOT EXISTS preparation_guide_url text;

UPDATE crm_private.booking_card_artist_settings
SET arrival_guide_url='https://vishartattoo.com/arrival/7f2bc57edcd447adbe549e36a5a1830f/',
    preparation_guide_url='https://vishartattoo.com/faq/'
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid;

UPDATE crm_private.booking_card_artist_settings
SET arrival_guide_url='https://www.kristinavishar.com/arrival/8be014526ee14b7190c8c559c59624ea/',
    preparation_guide_url='https://www.kristinavishar.com/faq/'
WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid;

-- Both links are required for enabled email booking confirmations. Do not
-- silently fall back to an unrelated public Maps pin or untrusted URL.
DO $guards$
BEGIN
  IF (SELECT count(*) FROM crm_private.booking_card_artist_settings
      WHERE artist_id IN (
        'a1111111-1111-4111-8111-111111111111'::uuid,
        'a2222222-2222-4222-8222-222222222222'::uuid
      )
        AND arrival_guide_url LIKE 'https://%'
        AND preparation_guide_url LIKE 'https://%') <> 2 THEN
    RAISE EXCEPTION 'Booking-card arrival URLs missing for a configured artist'
      USING errcode='23514';
  END IF;
END;
$guards$;

CREATE OR REPLACE FUNCTION crm_private.render_booking_card_email(
  p_booking_card_id uuid,
  p_confirm_token text,
  p_reschedule_token text
)
RETURNS TABLE(subject text, body text, html_body text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
DECLARE
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client_name text;
  v_artist_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_when text;
  v_when_html text;
  v_deposit text;
  v_remaining text;
  v_title text;
  v_msg text;
  v_group record;
  v_grouped boolean := false;
  v_video boolean := false;
  v_arrival_url text;
  v_prep_url text;
  v_money_text text := '';
  v_money_html text := '';
  v_location_text text := '';
  v_location_html text := '';
  v_actions_text text := '';
  v_actions_html text := '';
BEGIN
  -- Retain the existing dispatch contract and fail-closed capability validation,
  -- even though the booked confirmation no longer displays action links.
  IF p_booking_card_id IS NULL
     OR coalesce(p_confirm_token,'') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_reschedule_token,'') !~ '^[0-9a-f]{64}$'
     OR p_confirm_token = p_reschedule_token THEN
    RETURN;
  END IF;

  SELECT b.* INTO v_card
  FROM crm_private.booking_cards b
  WHERE b.id=p_booking_card_id AND b.superseded_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT x.* INTO v_settings
  FROM crm_private.booking_card_artist_settings x
  WHERE x.artist_id=v_card.artist_id AND x.email_enabled;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT c.full_name,a.display_name INTO v_client_name,v_artist_name
  FROM public.clients c
  JOIN public.artists a ON a.id=v_card.artist_id
  WHERE c.id=v_card.client_id AND c.archived_at IS NULL;

  IF NOT FOUND
     OR nullif(btrim(v_client_name),'') IS NULL
     OR nullif(btrim(v_artist_name),'') IS NULL
     OR nullif(btrim(v_settings.client_action_base_url),'') IS NULL
  THEN RETURN; END IF;

  v_arrival_url := v_settings.arrival_guide_url;
  v_prep_url := v_settings.preparation_guide_url;
  IF v_arrival_url IS NULL OR v_arrival_url NOT LIKE 'https://%'
     OR v_prep_url IS NULL OR v_prep_url NOT LIKE 'https://%' THEN
    RETURN; -- No link guessing or unintended public location fallback.
  END IF;

  v_video := v_card.appointment_type='video_consultation'::public.appointment_type;
  -- Use the current artist-scoped location (Exhibition House), not the
  -- legacy consultation_email_location() York House override.

  v_first_name := split_part(btrim(v_client_name),' ',1);
  v_date := to_char(v_card.start_at AT TIME ZONE v_card.timezone,'FMDay, FMDD FMMonth YYYY');
  v_time := to_char(v_card.start_at AT TIME ZONE v_card.timezone,'HH24:MI');
  SELECT * INTO v_group FROM crm_private.booking_group_card_summary(v_card.id);
  v_grouped := FOUND AND v_group.session_count>1;
  v_when := CASE WHEN v_grouped THEN v_group.dates_text ELSE v_date || ' at ' || v_time END;
  v_when_html := replace(crm_private.booking_card_html_escape(v_when),E'\n','<br>');

  IF v_card.card_kind='tattoo_deposit_paid' THEN
    v_title := CASE WHEN v_grouped THEN 'Your tattoo sessions are booked'
                    ELSE 'Your tattoo session is booked' END;
    v_deposit := crm_private.booking_card_money(
      CASE WHEN v_grouped THEN v_group.total_deposit ELSE v_card.deposit_paid END,
      v_card.currency
    );
    v_remaining := crm_private.booking_card_money(
      CASE WHEN v_grouped THEN v_group.total_remaining ELSE v_card.remaining_balance END,
      v_card.currency
    );
    IF v_deposit IS NULL OR v_remaining IS NULL THEN RETURN; END IF;
    v_money_text := E'Deposit received: ' || v_deposit || E'\n'
      || CASE WHEN v_grouped THEN 'Remaining balance across the booked dates: '
              ELSE 'Remaining balance on the day: ' END || v_remaining;
    v_money_html := '<div style="margin:22px 0;padding:18px;border:1px solid #38383a;border-radius:13px;background:#252528;color:#f5f5f7;">'
      || '<div style="margin-bottom:8px;"><strong>Deposit received:</strong> '
      || crm_private.booking_card_html_escape(v_deposit) || '</div>'
      || '<div><strong>'
      || CASE WHEN v_grouped THEN 'Remaining balance across the booked dates:'
              ELSE 'Remaining balance on the day:' END
      || '</strong> ' || crm_private.booking_card_html_escape(v_remaining) || '</div></div>';
    v_msg := E'Everything is confirmed. See you then!\n\nIf you have any questions, just message me here.';
  ELSIF v_card.card_kind='consultation_booked' THEN
    v_title := CASE WHEN v_video THEN 'Your WhatsApp video consultation is booked'
                    ELSE 'Your consultation is booked' END;
    v_msg := CASE WHEN v_video THEN
        E'I\'ll video call you on WhatsApp at the scheduled time.\n\nWe\'ll go through your tattoo ideas and discuss any questions you have.\n\nSpeak soon!'
      ELSE
        E'We\'ll go through your tattoo ideas and discuss the details in person.\n\nSee you then!'
      END;
  ELSE
    RETURN;
  END IF;

  subject := v_title || ' with ' || v_artist_name;
  IF NOT v_video THEN
    IF nullif(btrim(v_settings.studio_address),'') IS NULL THEN RETURN; END IF;
    v_location_text := E'Location: ' || v_settings.studio_address || E'\n\n';
    v_location_html := '<div style="padding:16px 0;color:#d3d3d6;font-size:14px;line-height:21px;">'
      || '<strong style="color:#fff;">Location:</strong> '
      || crm_private.booking_card_html_escape(v_settings.studio_address)
      || '</div>';
    v_actions_text := E'Get directions: ' || v_arrival_url;
    v_actions_html := '<a href="' || v_arrival_url
      || '" style="display:block;text-align:center;background:#fff;color:#111;text-decoration:none;border-radius:999px;'
      || 'font-size:14px;font-weight:700;padding:15px 18px;margin:12px 0;">Get directions</a>';
    IF v_card.card_kind='tattoo_deposit_paid' THEN
      v_actions_text := v_actions_text || E'\nHow to prepare: ' || v_prep_url;
      v_actions_html := v_actions_html || '<a href="' || v_prep_url
        || '" style="display:block;text-align:center;color:#f5f5f7;border:1px solid #6c6c71;'
        || 'text-decoration:none;border-radius:999px;font-size:14px;font-weight:700;'
        || 'padding:14px 18px;margin:10px 0;">How to prepare</a>';
    END IF;
  END IF;

  body := 'Hi ' || v_first_name || E',\n\n'
    || v_title || E' for ' || v_when || E'.\n\n'
    || v_location_text
    || CASE WHEN v_money_text<>'' THEN v_money_text || E'\n\n' ELSE '' END
    || v_msg
    || CASE WHEN v_actions_text<>'' THEN E'\n\n' || v_actions_text ELSE '' END;

  html_body := '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<meta charset="utf-8"></head><body style="margin:0;padding:24px 12px;background:#111113;color:#fff;'
    || 'font-family:Arial,Helvetica,sans-serif;">'
    || '<div style="max-width:560px;margin:0 auto;padding:28px;background:#1b1b1d;border:1px solid #38383b;border-radius:16px;">'
    || '<div style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#ddd;">'
    || crm_private.booking_card_html_escape(v_artist_name) || ' / TATTOO</div>'
    || '<div style="height:1px;background:#424246;margin:18px 0 24px;"></div>'
    || '<p style="font-size:15px;color:#ddd;line-height:22px;">Hi '
    || crm_private.booking_card_html_escape(v_first_name) || ',</p>'
    || '<h1 style="font-size:25px;font-weight:700;line-height:32px;color:#fff;">'
    || crm_private.booking_card_html_escape(v_title) || '</h1>'
    || '<div style="margin:17px 0;font-size:15px;line-height:24px;color:#eee;">'
    || v_when_html || '</div>'
    || v_location_html || v_money_html
    || '<p style="font-size:15px;line-height:24px;color:#ddd;white-space:pre-line;">'
    || replace(crm_private.booking_card_html_escape(v_msg),E'\n','<br>') || '</p>'
    || v_actions_html
    || '</div></body></html>';

  RETURN NEXT;
END;
$function$;

-- Keep privileged renderer inaccessible through the public data API.
REVOKE ALL ON FUNCTION crm_private.render_booking_card_email(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
