# Unmatched inbound: actionability and operator states

## Problem (production, 2026-10-04)

Today showed 20 "messages from unknown senders" (Vladimir 19, Kristina 1). None had a CRM reply, but the count mixed three defects:

- A. Today and reminders read the newest stored row. Reactions, unsupported events, edits and revokes counted as a client message, and an outbound reaction or queued send counted as an answer.
- B. Exact WhatsApp linking ran only on the conversation side. A client whose phone was added or normalised later (Mark Abramov) stayed unmatched.
- C. Archive hid a conversation forever, including a real client's new message.

## Model

- One server rule: `crm_private.communication_event_is_actionable(type)`. Reaction, unsupported, edit and revoke are not actionable. Everything else is, unknown types included (fail open).
- The conversation waits on the studio while its newest actionable inbound is newer than the newest provider-accepted studio reply from `crm` or `provider_app`. Queued, failed, automation, edit and revoke do not count as a reply.
- `not_crm`: the conversation is personal. It hides an unlinked conversation until the operator clears it, and stops applying once a client is linked.
- Handled outside the CRM: the existing version-scoped `attention_acknowledgements(conversation_reply)`. A newer actionable inbound returns the item. It is undone with `clear_attention_acknowledgement`.
- Archive: a new actionable inbound reopens the conversation, unless it is unlinked and `not_crm`.
- Client-side exact E.164 relink happens on client, enquiry or project writes. It fails closed on ambiguity or cross-artist scope.
- Automatic links carry provenance (`auto_linked_at`). When the exact match stops being unique, or the client changes phone or is archived, the automatic link is withdrawn and re-matched. An operator link or promotion clears the provenance and is never withdrawn. Links made before this change have no provenance and are left alone.
- The studio's turn is a provider-accepted message or reaction sent after the client's newest actionable message (20261004190000). An edit, a revoke or an unsupported echo is not a turn. Production readback showed 5 of 5 studio reactions acknowledging a client's closing line.
- No history is deleted. The backfill touches only derived links and reopens archived conversations when the order is proven by the activity log. Nothing is auto-marked `not_crm`.
