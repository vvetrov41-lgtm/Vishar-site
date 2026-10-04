# Plan

1. Migration `20261004180000_actionable_inbound_and_operator_states.sql`:
   - classifier and waiting functions;
   - `not_crm` columns and RPC;
   - acknowledgement undo;
   - `get_conversation_attention`;
   - archive-reopen trigger;
   - client-side relink triggers;
   - Inbox projection (`p_needs_reply`);
   - `pulse_items`, `unanswered_waiting_since`, the reminder sweep and `attention_comm_facts` on the same rule;
   - backfill.
2. pgTAP `326_actionable_inbound_operator_states.sql`, plus adjusted 050, 221, 299 and 1004.
3. CRM UI: conversation operator-state panel; Today's `/inbox?view=unmatched` decision list (no tab in the queue).
4. Parity row `attention.conversation_states.set` (N).
5. Release through the private production release; read back production.
