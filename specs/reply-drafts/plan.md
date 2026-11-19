# Plan: reply drafts

Small PRs, each green on its own. Merge and release only with Vladimir's
explicit approval.

1. **Spec** (this PR). Docs only.
2. **Examples.** Migration with a service RPC
   `service_get_reply_draft_examples(p_conversation_id, p_limit)` that returns
   masked (client message, artist reply) pairs from the same artist's client
   conversations, with the exclusions in the spec. pgTAP: not-CRM rows and
   another artist's rows never come back. Style file
   `workers/lib/ai/reply-draft-style.js`.
3. **Route.** `POST /reply-draft` in the tattooai Worker next to
   `outgoing-message-review.js`, operator-authenticated like it. New task
   `reply_draft` in `workers/lib/ai/tasks.js` (after PR #1311 lands, to avoid
   a conflict). Number grounding and the existing reply-safety checks.
   Offline evaluation on 30 past conversations: draft vs what the artist
   actually sent.
4. **UI.** "Suggest reply" in `admin/src/pages/ConversationPage.tsx`, en/ru
   copy, window notice, hidden for not-CRM and archived conversations, behind
   `REPLY_DRAFTS_ENABLED`.
5. **Measurement.** Store draft id with the queued message; a Statistics or
   SQL view of edit distance. Review after one week.

Model: start with Workers AI (Gemma, then Qwen fallback). If the offline
evaluation shows the voice is wrong, propose the existing OpenAI provider as a
separate, paid decision.
