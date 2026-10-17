# Client silence follow-up

## Problem (production, 2026-10-17)

Today showed 36 items; 25 were "client went quiet" (Vladimir only) and none could be dismissed or postponed. Of those:

- 7 had no studio message at all. The clock started when the operator cleared a reply or enquiry item in Today (20260924035000 treated "handled" as the studio's turn).
- 3 started from a reaction the artist put on the client's closing line.
- 2 clients also had an open manual follow-up, so the same person appeared twice.

Statistics had no view of this state. Manual follow-ups were barely used (7 ever).

## Behaviour

- **The studio's turn** is a person's message: provider-accepted, from the CRM or the provider app, an actionable type, or a sent email that is not `system`. Reactions, automations (booking cards), system email and clearing a Today item are not a turn.
- **A studio reaction** after the client's newest message acknowledges it ("seen, nothing owed", as since 20261004190000) unless the message asks something: it contains a question mark, or the reply classifier marked it `reply_required`. The classifier can keep an item open; it never hides one on its own. Today's reply row and the client facts follow the same rule.
- **Clearing a Today reply/enquiry item** still answers the client's message but does not start waiting on the client.
- **A cycle** is `(artist, client, time of the studio's last message)` while the client has not written since. Any new message from either side ends it; a new studio message starts the next one.
- **One acknowledgement per cycle** (`attention_acknowledgements`, kind `client_silence`, `observed_at` = cycle time). It covers both the 7-day and the 21-day item. "Don't remind": `resurface_at` null. "Later": `resurface_at` = 3 days / a week / a month. Undo: `clear_attention_acknowledgement`.
- **Manual follow-ups win.** An open follow-up for the client (directly, or through its enquiry or project) hides the automatic item. One completed or cancelled after the cycle started closes that cycle.
- **No item** while a proposed appointment exists (it has its own row), a confirmed one is ahead, or a deposit is paid on an open project.
- **Granularity is the client.** Messages are not tied to an enquiry or project, so one row per client and artist. A follow-up on any of the client's enquiries/projects with this artist covers the client.
- **Today:** a folded block "Waiting on clients · N" after the schedule. Each row: name, days since the studio's message, channel, how the message began, whether the client reacted. Tap opens the conversation. `#/?waiting=1` opens the block.
- **Statistics:** "Clients to follow up now: N" in "Needs attention", from `get_waiting_on_clients_count`, which counts the same `pulse_items` rows. Independent of the period. When the server pulse is off it says "temporarily unavailable", never 0.
- Nothing sends a message, closes an enquiry or changes a booking.

## Out of scope

- AI for the meaning of the studio's last message (no new models or calls). The existing classifier is reused only as a reason to keep a reply open.
- Storing the reaction emoji and the message it points at. Not stored today: WhatsApp drops `reaction.emoji` and `reaction.message_id`; Instagram reactions are not stored at all. Planned model: `communication_messages.reaction_emoji text`, `reaction_target_provider_message_id text`, Instagram `message_reactions` handler (react/unreact). The rules above do not need it.
- GPT exposure of "later" (`attention.snooze`, parity `implement_now`).
