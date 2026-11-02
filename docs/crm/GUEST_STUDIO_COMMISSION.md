# Studio share: guest sessions

Regular studio terms for Vladimir and Kristina remain **30% up to £600 and £180 above £600**, computed independently for each completed, paid GBP tattoo session or touch-up. That is not a payment ledger or a studio debt.

For a guest day at a different studio, the fee may instead be an agreed percentage (e.g. **30% of each guest-day price, no cap**). Record an explicit row by **session UUID** in `crm_private.session_studio_fee_overrides` with `fee_percent=30`, `basis='guest_studio'`, and a concise explanation. An override does not affect any other sessions, even those for the same client, project or artist. It cannot be set by an unprivileged API role. Only authorized operators should insert/remove overrides after confirming the agreement and actual session identity.

The private `crm_private.statistics_studio_share` computation joins this table after the session's artist and analytics exclusion filters. When an override exists it computes `round(price * fee_percent / 100, 2)`; otherwise the ordinary capped formula applies. `statistics_core` remains the source for both CRM and GPT finance statistics; no frontend calculation or deposits added.

**Charlie Sims guest dates, 27/28 Oct 2026:** £980 and £420, with explicitly confirmed guest conditions 70/30: studio £294 + £126 = £420; artist £686 + £294 = £980. The artist reports the studio share already settled. The calculated share should not be presented as an outstanding payment, irrespective of who collected the client payment.

Schema migrations never seed specific customer overrides, to avoid applying production records to staging or introducing synthetic client data. A separately authorized, tightly scoped production data operation should create the two rows after the migration and verify readback.
