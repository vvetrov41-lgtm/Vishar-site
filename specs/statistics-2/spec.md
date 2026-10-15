# Statistics 2.0

Statistics must let an artist open the screen on an iPhone and understand in 10-15 seconds how the business is going: are enquiries coming, are they turning into tattoo bookings, how fast are they answered, how full is the diary ahead, and what money has actually arrived versus what is only expected.

Source: audit `docs/audits/2026-10-15-vishar-crm-statistics-audit.md` (website branch `claude/vishar-statistics-audit-98iu9l`) and the P0 correction PR #1095, which fixed the definitions in the browser. This feature moves those definitions to one server-side source and builds the mobile-first screen on it.

## Users and scope

- Artist (Vladimir, Kristina) on a phone, one artist at a time.
- Studio owner with access to several artists: per-artist figures side by side; counts may be summed, rates and medians are recomputed from rows, never averaged.
- GPT/MCP operator reads (`gpt_get_statistics`) and Today pulse must return the same numbers for the same question.

## Requirements

### R1. One definition, three readers
A single private SQL core computes every Statistics figure. The CRM screen, `gpt_get_statistics` and, where they overlap, Today pulse read it. No metric is defined twice. The browser formats, it does not compute business figures.

### R2. Business overview (first screen)
New enquiries; tattoo bookings made (by booking date); enquiry-to-tattoo conversion over mature enquiries; median first reply; tattoo sessions done; each with a change against the previous comparable window or no change at all.

### R3. Enquiry funnel
Cohort of the period's enquiries: answered → consultation → tattoo booked → tattoo done, each as a share of enquiries; maturity and pending count; median days from enquiry to first tattoo booking.

### R4. Marketing attribution
Channel (from campaign tag, then referrer host; manual and conversation-opened separate; booking form is not a channel) → enquiries → consultations → tattoo bookings → deposits paid. Self-reported discovery shown separately, never merged. Unknown stays unknown.

### R5. Calendar occupancy
Tattoo hours per week for the next 12 weeks, consultations separately, empty weeks marked, count of bookings beyond the horizon. No utilisation percentage without a defined capacity.

### R6. Response time
Median first reply over enquiries with a known reply time (canonical `crm_private.enquiry_first_artist_reply` / `enquiry_reply_state`), count answered without a known time, count unanswered; coverage note for periods before reply evidence existed (WhatsApp echoes 2026-09-28, Gmail SENT 2026-10-04).

### R7. Financial overview
Actual: received (cash, by `occurred_at`), refunded, both per currency. Expected, labelled as forecast and never added to actual: open payment requests; booked value of future confirmed tattoo sessions with a price, with price coverage; remaining after allocated deposits (`booking_card_deposit_for_session`). The forecast is shown only when price coverage ≥ 80%. No figure is called revenue.

### R8. Mobile first
Order: needs attention, 2×2 headline, diary ahead, funnel, channels, money, details. At 390×844 the first three blocks are visible without scrolling; no horizontal page scroll; axis labels readable.

### R9. Performance
One RPC call per screen load; no browser paging of raw rows; response under 300 ms for a 730-day window on production volume.

## Non-negotiables

- Authorization per artist inside the RPC (`crm_private.has_artist_capability(artist, 'view')`; finance only with `'view_finance'`), MFA rules unchanged, analytics exclusion respected, fixed `search_path`, `revoke` from `public`/`anon`.
- No contact data leaves the RPC; aggregates only.
- Historical rows are never rewritten. Periods before a data source existed report "no data", not 0.
- No production test enquiries, bookings or payments.

## Acceptance

- RPC numbers equal the PR #1095 browser definitions on fixtures and on a read-only production comparison for 30/90 days, per artist.
- `gpt_get_statistics` returns the same figures as the screen for the same artist and window (parity test).
- Response-time figures equal `pulse_summary` for the last 30 days.
- pgTAP: denial for an artist without membership, no finance without `view_finance`, excluded enquiries absent, no MFA = no rows.
- Exact production SHA readback on both CRM hosts; production readback of the RPC for both artists; Playwright 390×844 check on the operator build.
