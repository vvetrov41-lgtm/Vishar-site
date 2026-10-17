# Plan

1. Migration `20261017090000_client_silence_follow_up.sql`, fail-closed on the md5 of every replaced function as measured on production 2026-10-17:
   - `crm_private.studio_reaction_acknowledged_at`;
   - `conversation_last_studio_reply_at` (person's message only) and `conversation_awaiting_reply_since` (acknowledging reaction);
   - `attention_comm_facts`, `client_attention`, `pulse_client_attention`, `pulse_attention_batch` on the same turn and reaction rules; `handled` without a studio message is nothing pending;
   - `attention_acknowledgements.resurface_at`, kind `client_silence`; `crm_private.record_attention_acknowledgement`; `acknowledge_attention_item` (unchanged signature), new `snooze_attention_item`, `clear_attention_acknowledgement`;
   - `crm_private.client_silence_cycle_at`, `crm_private.client_silence_context`;
   - `pulse_items` silent branch (acknowledgement, follow-up/appointment/deposit suppression, context, conversation link) and `resurface_at` in visibility;
   - `public.get_waiting_on_clients_count`.
2. pgTAP `339_client_silence_follow_up.sql`; 050 allow-list; 296 expectations for the handled-without-message change.
3. CRM: `WaitingOnClients` block in Today, Statistics counter, hash-router links in Statistics "Needs attention", i18n, tests.
4. Parity: `today.pulse` lists the counter; `attention.snooze` as `implement_now`; MCP Stage 2 list.
5. Exact-head CI, merge, private production release, read-only production acceptance.
