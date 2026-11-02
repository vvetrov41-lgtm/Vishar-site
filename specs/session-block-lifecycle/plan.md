# Technical plan

Base at investigation: agent/platform-telegram-self-service @ 7cab013af612ee36802d5eb424a199746bdc827b. Recheck before publication and release.

1. Trace the effective ordered SQL definitions, job materialisation, execution, outbox, provider acknowledgement, group booking confirmation and all callers. Inventory deployed templates, channels, timezone and real production migration state. Preserve grants, RLS, isolation and server-authoritative routing.
2. Define block membership and stable deduplication across mutations and delivery states; reconcile existing pending work without replaying sent or in-flight messages. Model single sessions, split/merge, moved/cancelled/additional days, actual completion and late provider acknowledgements.
3. Implement block-aware schedule, message rendering, grouped confirmation and aftercare/check-in. Integrate provider-safe channel selection with actionable failures and maintain existing auto-completion and consultation behavior.
4. Recover genuinely missing eligible bookings with idempotent safeguards. Do not issue per-day lifecycle sends for grouped sessions. Include continuous gap detection.
5. Test migrations and all positive, denial, concurrency and failure cases using isolated data, then exact-head CI and staging. Use the repository release path and immutable release preflights. Confirm production migration and runtime readback, queue behavior, isolation and later real delivery.
6. Prepare rollback that prevents duplicate sends and preserves delivery history. Do not treat green CI or a merged PR as proof of deployment.
