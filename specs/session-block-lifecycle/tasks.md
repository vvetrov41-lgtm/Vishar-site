# Tasks

- [x] T01 Fresh-check canonical branch and read current production rules and missing-job counts (2026-10-30; base 7cab013af612ee36802d5eb424a199746bdc827b).
- [ ] T02 Trace effective definitions, triggers, delivery history and current grouped booking contracts; verify actual-end data and timezone.
- [ ] T03 Design block identity, concurrency, splits/merges, deduplication and pending/in-flight reconciliation.
- [ ] T04 Implement block reminders, first-day aftercare, final-day check-in, grouped confirmation and artist-specific copy.
- [ ] T05 Implement safe channel routing, failure reporting and missing-job reconciliation.
- [ ] T06 Validate required scenarios, access denials, provider failures and migration safety.
- [ ] T07 Publish bounded PR, exact-head CI, staging and safe automated release.
- [ ] T08 Verify production state, delivery and absence of duplicates; document remaining acceptance gaps.

## Deferred enhancements (not part of the deployed session-block rollout)

- [ ] D01 [Issue #1135](https://github.com/vvetrov41-lgtm/Vishar-site/issues/1135): add channel-aware **24-hour consultation reminders**. For a confirmed consultation, select an eligible WhatsApp Utility template when the linked artist-scoped conversation is WhatsApp, otherwise preserve the current Gmail workflow for email-first clients. Require explicit Meta approval for each artist, backend dispatch-time revalidation, cancel/rebook reconciliation, no silent email fallback for WhatsApp-first clients, no duplicate or late backfill, visible artist alert on unavailable route, and production-provider acceptance using legitimate events. Keep the existing 2026-11-02 consultation reminder completed via Gmail; never replay it.

## Production acceptance still outstanding

- [ ] First legitimate WhatsApp session-block notification: verify Meta provider acceptance, eventual delivery status and no duplicate after the scheduled 2026-11-07 11:00 Europe/London reminder. The read-only check is scheduled for 12:00 that day.
- [ ] Kristina: resolve Meta WABA template-management eligibility, obtain four APPROVED Utility templates, and only then perform controlled artist-specific activation and acceptance. Keep her WhatsApp delivery gate OFF until all preflight criteria pass.
