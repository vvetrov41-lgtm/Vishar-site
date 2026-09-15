from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one exact match, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "supabase/tests/010_schema_constraints.sql",
    "  'calendar_availability_cancel', 'whatsapp_message', 'instagram_message'\n], 'outbox_kind covers every integration job');",
    "  'calendar_availability_cancel', 'whatsapp_message', 'instagram_message',\n  'meta_conversion'\n], 'outbox_kind covers every integration job');",
)

replace_once(
    "supabase/tests/100_booking_sources_integrations.sql",
    "  array['telegram', 'calendar', 'email', 'payments', 'gpt', 'whatsapp', 'instagram'],",
    "  array['telegram', 'calendar', 'email', 'payments', 'gpt', 'whatsapp', 'instagram', 'meta_ads'],",
)

replace_once(
    "supabase/tests/100_booking_sources_integrations.sql",
    "select is((select count(*)::int from public.artist_integrations), 3,\n          'owner sees integration metadata for both artists');",
    "select is((select count(*)::int from public.artist_integrations), 4,\n          'owner sees integration metadata for both artists including Vladimir Meta Ads');",
)

anchor = "  ('public.service_recover_telegram_enquiry_outbox(uuid)', false, false, true),\n"
addition = anchor + (
    "  ('public.service_record_meta_attribution(uuid,text,boolean,text,text,text)', false, false, true),\n"
    "  ('public.claim_meta_conversion_outbox(text,integer,integer)', false, false, true),\n"
    "  ('public.record_meta_conversion_outbox_result(uuid,text,boolean,boolean,text)', false, false, true),\n"
)
replace_once("supabase/tests/050_rls_roles.sql", anchor, addition)
