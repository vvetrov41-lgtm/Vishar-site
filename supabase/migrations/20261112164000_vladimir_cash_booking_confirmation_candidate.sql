-- Add an optional cash-payment note to Vladimir's tattoo booking confirmations.
-- The approved Meta v2 body and its two URL buttons remain immutable.
-- WhatsApp v3 is PROPOSAL ONLY: never switch active sends before genuine approval.
-- No existing messages, appointments, deposits or consultations are modified.

ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check CHECK (kind IN (
    'booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation',
    'reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video','reminder_72h_button',
    'booking_consultation_directions','reminder_consultation_directions',
    'booking_tattoo_cash'
  ));

INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
VALUES
  ('a1111111-1111-4111-8111-111111111111'::uuid,
   'booking_tattoo_cash','booking_card_tattoo_cash_v3','en_GB')
ON CONFLICT (artist_id,kind) DO NOTHING;

DO $candidate$
BEGIN
 IF (SELECT count(*) FROM crm_private.whatsapp_template_proposals
     WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
       AND kind='booking_tattoo_cash'
       AND template_name='booking_card_tattoo_cash_v3'
       AND template_language='en_GB'
       AND approval_status='UNKNOWN'
       AND provider_template_id IS NULL)=1
    AND NOT EXISTS (
      SELECT 1 FROM crm_private.whatsapp_template_proposals
      WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
        AND kind='booking_tattoo_cash'
    ) THEN
   RETURN;
 END IF;
 RAISE EXCEPTION 'Unexpected WhatsApp cash proposal drift; fail closed'
   USING errcode='23514';
END;
$candidate$;

-- Email can show the optional note immediately after the payment summary.
-- Only the tattoo branch for Vladimir receives it. Existing rendered/sent
-- confirmations remain immutable, as do free consultation and Kristina emails.
DO $email_cash$
DECLARE
 v_source text;
 v_before text;
 v_after text;
BEGIN
 SELECT pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure)
 INTO v_source;
 IF v_source IS NULL THEN
   RAISE EXCEPTION 'Booking email renderer missing' USING errcode='23514';
 END IF;
 v_before := $before$    v_msg := E'Everything is confirmed. See you then!\n\nIf you have any questions, just message me here.';$before$;
 v_after := $after$    IF v_card.artist_id='a1111111-1111-4111-8111-111111111111'::uuid THEN
      v_money_text := v_money_text || E'\nA little note: cash payment is preferred, if that''s convenient for you. Thank you!';
      v_money_html := v_money_html
        || '<p style="font-size:14px;line-height:22px;color:#ddd;">'
        || 'A little note: cash payment is preferred, if that''s convenient for you. Thank you!'
        || '</p>';
    END IF;
    v_msg := E'Everything is confirmed. See you then!\n\nIf you have any questions, just message me here.';$after$;
 IF length(v_source)-length(replace(v_source,v_before,''))<>length(v_before) THEN
   RAISE EXCEPTION 'Booking email renderer drift; no cash copy patch applied'
     USING errcode='23514';
 END IF;
 EXECUTE replace(v_source,v_before,v_after);
END;
$email_cash$;

REVOKE ALL ON FUNCTION crm_private.render_booking_card_email(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
