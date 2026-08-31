-- 0127_vladimir_whatsapp_legacy_connected_backfill.sql
--
-- Vladimir's production WhatsApp route predates the connected_at bookkeeping
-- added by migration 0121. Reconcile that legacy row only when the database
-- already contains provider-backed inbound traffic for the exact fixed route.
--
-- For this legacy backfill, connected_at means the earliest CRM-observed
-- provider-backed inbound message. It is evidence that the route was already
-- operational by that time, not a claim about the original Meta authorization
-- timestamp.

with first_provider_backed_inbound as (
  select min(m.created_at) as observed_at
  from public.whatsapp_messages m
  join public.whatsapp_conversations c
    on c.id = m.conversation_id
   and c.artist_id = m.artist_id
  where m.artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid
    and c.integration_key = 'vladimir-production'
    and m.direction = 'inbound'
    and m.provider_message_id is not null
    and btrim(m.provider_message_id) <> ''
)
update public.artist_integrations i
set connected_at = evidence.observed_at
from first_provider_backed_inbound evidence
where i.artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid
  and i.integration_type = 'whatsapp'::public.artist_integration_type
  and i.provider = 'meta_cloud_api'
  and i.integration_key = 'vladimir-production'
  and i.is_enabled
  and i.configuration = '{}'::jsonb
  and i.connected_at is null
  and evidence.observed_at is not null;
