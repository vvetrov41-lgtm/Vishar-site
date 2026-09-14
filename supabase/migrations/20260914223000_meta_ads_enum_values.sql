-- Meta Ads / Conversions API enum values.
-- Keep enum extension in its own committed migration so later migrations can
-- safely use the new values on every supported PostgreSQL/Supabase version.

alter type public.artist_integration_type add value if not exists 'meta_ads';
alter type public.outbox_kind add value if not exists 'meta_conversion';
