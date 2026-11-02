# Meta Ads ↔ Vishar CRM reconciliation

## Objective
Link a consented enquiry to the exact Meta ad account/campaign/ad set/ad when a paid-social UTM chain is present, while retaining the existing Lead `event_id` and enabling reproducible timezone-aware reporting.

## Functional contract
- Trust the existing CRM service-side enquiry, artist identity, Meta consent record and stored idempotency UUID. The browser must not supply trusted artist or account IDs.
- Derive numeric campaign / ad set / ad IDs only from explicitly paid fb/ig UTM parameters already accepted with an enquiry. Prefer conversion URL; otherwise consented last touch, then consented first touch. Label the evidence source.
- A bare `fbclid`, Facebook referrer, organic Instagram visit, incomplete campaign ID, or unconsented visit never becomes a confirmed ad ID.
- Preserve current Pixel and CAPI Lead event IDs and subsequent QualifiedLead / BookedClient events. This feature does **not** dispatch additional conversion events.
- Store the verified Vladimir Meta account mapping, account timezone `Africa/Cairo`, and use `Europe/London` for CRM local reporting; preserve UTC event timestamps.
- For Meta daily Insights, use the account-local reporting date and `action_report_time=conversion`; group only comparable data. Never claim an Insights aggregate identifies a particular customer.
- Historical backfill touches only existing private Meta-consented attribution rows. Never reconstruct consent.
- Do not expose private attribution tables to public/anon/authenticated roles.
- A missing or invalid ad ID must not interfere with booking, client messaging, payment or existing CAPI.

## Acceptance
1. New Meta-consented `Lead` retains the server/browser UUID and, with paid UTM IDs, has a stable account/campaign/adset/ad candidate.
2. Verified October UTM examples can be represented without implying that every CRM enquiry was Meta-attributed.
3. Example 2026-10-24 22:30 UTC belongs to 25 Oct in Cairo and 24 Oct in London (BST).
4. October 30 after Cairo's DST change uses Cairo +2, not a hard-coded +3.
5. Tests cover permissions and identity validation; no production writes before exact-head CI and release approval.

## Limitations
Meta Ads Insights is aggregated and does not provide a customer-level event-to-enquiry match. CRM IDs and CAPI outbox prove internal dispatch intent; provider acceptance requires separate Meta diagnostics. Attribution-window and impression-based reporting may still differ from CRM counts.
