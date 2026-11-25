# Healing and reviews: channel choice

Status: proposed implementation. Extends the two-step healing/review flow introduced by #1318, #1319 and #1320. Original draft #1301 already described Instagram and email.

## Requirements

- R1: Today shows WhatsApp, Instagram and Email for both healing question and Google review request. Show which channels are sendable now and why others are unavailable. A client without WhatsApp must not be blocked if another route exists.
- R2: Recommend the latest eligible communication channel for the artist and client; fall back to the client's preferred contact when eligible, then a deterministic order. Allow the artist to override before confirming. No automatic sending or silent fallback after a send attempt.
- R3: Keep the existing healing suggestion eligibility, 14-day snooze, dismissal, two-step flow and artist-specific Google review URL. Review request requires a verified client reply to the healing question, with the artist deciding whether to ask. Existing requests remain readable.
- R4: WhatsApp healing question continues to use the approved utility template when required; free-form sends only when permitted. Instagram must use the existing authorized messaging route/window; never open an unauthorized conversation or use a guessed handle. Email may start a new thread to the client's verified CRM address via the artist's connected mailbox, without requiring a Meta conversation.
- R5: Show exact body and chosen channel before the artist sends. Email shows subject too. Preserve the original healing-question wording. Show a truthful queued/sent/failed status; no success on an uncertain result. No messages to real clients during testing.
- R6: Track email and Meta sends and replies with durable identifiers. Email replies must be tied to the actual healing email thread, not inferred from an unrelated latest inbound message. Keep raw provider IDs private. After a reply, recommend that channel if eligible but allow an explicitly selected alternative.
- R7: Server revalidates artist membership, client linkage, channel permissions, suppression, current provider/account route and reply eligibility at mutation time. Existing global opt-outs remain effective. One healing ask and one review ask per existing workflow; lock and operation id prevent cross-channel duplicates and retries. No replay after ambiguous delivery without reconciliation.
- R8: Same behavior for Vladimir and Kristina, scoped to each artist's own integrations. No fake delivery or cross-artist routing.
- R9: Maintain operator parity through bounded GPT/MCP operations or explicitly record gap/planned status, not an unrestricted RPC proxy.

## Acceptance

A client without an open WhatsApp conversation but with reachable email can select Email and send only after confirmation. A client with an eligible Instagram conversation can select Instagram. Closed Meta windows are explained and cannot be bypassed. A reply in the correct healing email/Meta conversation opens the review stage, and the artist can select an eligible channel for that second send. A reply to an unrelated email does not count. Retries and double taps do not create additional outbound messages. Existing WhatsApp cards continue working. Both artist profiles respect permissions. All changes must pass exact-head CI and staging/production readback before being called complete.
