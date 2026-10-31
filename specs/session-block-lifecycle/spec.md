# Session-block lifecycle messaging

## Outcome
For each artist, a client's consecutive local-calendar tattoo days belonging to the same project form a block. One 72-hour reminder and one 24-hour reminder precede the first session; one aftercare message follows the first completed session; one check-in with the artist's aftercare link follows the final completed session by 24 hours. Separate blocks receive their own messages. One-session blocks follow the same sequence.

## Required behavior
- Both artists and tattoo sessions and touch-ups are in scope; consultation behavior is preserved.
- Reminders list all dates and start times, give accurate cancellation/deposit conditions per date, and the 24-hour message offers a single block confirmation with the studio address.
- Recompute on additions, cancellations and rescheduling, checking authoritative status and current block at dispatch. Never replay a delivered or queued message or send a check-in during the block. Preserve individual appointment and deposit records.
- The recorded actual end, when available, drives post-session timing; otherwise use the authoritative scheduled end. Automatically completed sessions and cancellation protections remain intact.
- Select an eligible communication channel based on conversation and provider restrictions. On an unavailable route, retain a visible failure for the artist; never silently lose the job. Artist/workspace isolation and existing consent, kill-switch and provider controls remain authoritative.
- Restore missing jobs only after proving no earlier send/queue and avoid generating per-day duplicates.

## Acceptance
Staging tests cover one, two and three consecutive days, two separated blocks, moved final day, cancelled day, added day, actual end, replay/concurrency, artist isolation, missing channel and provider failures. Verify all eligible confirmed records have appropriate jobs and verify actual delivery only through later legitimate events. Four messages per three-day block excludes the original booking card.

## Bounded assumptions and gaps
Consecutive dates are interpreted in the artist's configured local timezone. An absent project identifier requires a safe explicit policy, not grouping unrelated work. Provider policy, existing messages and sends in flight require investigation before choosing fallback or deduplication. The current sessions schema has no obvious actual-end field; trace existing completion evidence before introducing one.
