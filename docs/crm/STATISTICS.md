# Statistics

The CRM's Statistics screen at `/statistics`, under More on a phone (Today
keeps the tab-bar slot). Every figure it shows is a count of the studio's own
records; none of it comes from a telemetry system. The one estimate, the
value of upcoming sessions without a saved price, is labelled as such and
kept apart from confirmed prices and money received (see Money).

On a phone the first screen holds the four headline figures and "Needs
attention" above the bottom navigation; charts follow. `npm run
check:mobile-layout` (admin, run in CI's Private CRM job) renders the screen
with every attention item at once and fails if either block reaches the tab
bar, or anything scrolls sideways, at 390x844, 393x852 and 430x932, in
English and Russian.

This document is the contract. Where it and the screen disagree, one of them is
a bug — `admin/src/lib/statistics.ts` carries the same definitions in code, and
`admin/src/test/statistics.test.ts` pins them.

## Where the numbers come from

One call: `public.get_statistics(artist_ids, from, to)`
(`supabase/migrations/20261015120000_statistics_core.sql`). It returns, per
artist, the current window and the equal window before it, each computed by
`crm_private.statistics_core`. `public.gpt_get_statistics` reads the same core,
and response time reuses `crm_private.enquiry_reply_state`, the evidence Today's
pulse reads. No metric is defined in the browser: `admin/src/lib/statistics-overview.ts`
only sums counts across artists and decides what to say.

The core reads the `statistics_*` projections, so explicitly excluded test
lineage (`20260920185324_analytics_exclusion.sql`) is absent from every figure.

PostHog is not involved.

## Access

- `get_statistics` checks `crm_private.has_artist_capability(artist, 'view')`
  for every artist before reading anything for it. An artist the caller may not
  view is an error (`42501`), never an empty answer.
- Money is included only where the caller holds `view_finance` on that artist.
- With no artist chosen, the server answers for every artist the caller may
  view, one entry each. The screen adds counts and same-currency money; it never
  averages rates and shows medians per artist.
- `statistics_core` and its helpers are not executable by any API role.
- Only aggregates leave the database.

## Periods

A period is a half-open interval `[from, to)` of whole **local** days, so a
record timestamped exactly at midnight belongs to one period and not to two.

| Preset | Days | Window |
| --- | --- | --- |
| 7 days | 7 | today and the six days before it |
| 30 days | 30 | today and the 29 days before it |
| 90 days | 90 | today and the 89 days before it |
| 12 months | 365 | today and the 364 days before it |
| Custom | as picked | two inclusive local dates |

"12 months" is 365 fixed days, not the same date last year: a calendar year
would put 366 days against 365 in a leap year and quietly change every delta.

The **previous period** is the interval of identical length immediately before
`from`. The two windows are contiguous and equal in length, which is what makes
a percentage change between them mean anything.

## Metric definitions

### New enquiries
Rows in `enquiries` with `created_at` inside the period, `archived_at IS NULL`,
`intake_state = 'complete'`. Half-finished intakes are excluded exactly as they
are excluded from the working queue: nobody ever worked them.

### Tattoo work and consultations

`tattoo_session` and `touch_up` are tattoo work. `in_person_consultation` and
`video_consultation` are consultations. The two are never added together
anywhere on the screen: a consultation is not a conversion, not a session
worked, not an hour tattooed and not a repeat visit. This is the database's
own rule (`20260907070000_enquiry_auto_project_booking.sql`: booking a
consultation "must not convert an enquiry into tattoo work").

### Consultation held, awaiting its outcome, or no-show

A past date does not prove the client came, so a consultation counts as
**held** only with status `completed`. An ended consultation still
`confirmed` is **awaiting its outcome** ("elapsed, unverified"): derived from
the clock, never stored, so no new session status exists and calendar sync,
cards and reminders are unchanged. It is never counted as held. Cancelled
consultations keep their status; `no_show` is reported apart.

The outcome is recorded:

- by the operator, in Calendar's "Consultations: did they take place?" list
  ("Took place" = `completed`, "Client did not come" = `no_show`), through the
  existing `set_appointment_status`; Statistics' "Needs attention" links there;
- automatically on evidence: a tattoo session or touch-up for the same client
  and artist, not draft and not cancelled, created at or after the
  consultation started, completes it
  (`crm_private.resolve_evidenced_consultations`, run in the automation tick;
  `activity_log` `completion_source = follow_on_booking` with the evidence
  session id). The clock alone completes nothing.

The funnel's "had a consultation" step and each channel's consulted count use
held consultations only.

### Conversion (enquiry to tattoo)
Cohort-based, over mature enquiries only.

- **Cohort** — enquiries created in the period. Membership is decided by
  `created_at` and no other timestamp.
- **Mature** — enquiries at least **14 days** old. Only these form the
  denominator. Younger ones are reported as "pending", with how many of them
  have already booked; they never count as unconverted.
- **Converted** — an enquiry with at least one tattoo session or touch-up,
  reached through `sessions.enquiry_id` or through the session's project, that
  is neither `draft` nor `cancelled`. A no-show still counts.
- **Not converted** — a consultation of any status, a project with no tattoo
  session, a cancelled tattoo booking.
- The booking may have been made after the period ended.
- An enquiry counts once however many sessions it produced.
- With no mature enquiry the rate is **not shown**.

### Tattoo bookings made
Tattoo sessions and touch-ups whose **booking** was made in the period
(`sessions.created_at`), whatever date they are for, drafts excluded. A booking
cancelled later stays counted and is shown as cancelled. This is the only
figure that shows a week's sales while the work is months ahead.

### Response time
From `crm_private.enquiry_reply_state` over the period's enquiries: the median
hours to the first reply a person sent (WhatsApp/Instagram accepted by the
provider, CRM email sent, Gmail SENT), the number with a known time, the number
answered without a known time (operator attestation, Gmail lookup pending) and
the number unanswered. Reply evidence is complete only from 2026-09-28
(WhatsApp echoes) and 2026-10-04 (Gmail SENT).

### Comparison with the previous period
A change is stated only when the CRM holds complete history for the previous
window: the earliest visible enquiry must be no later than the previous
window's start. Otherwise the screen says there is no comparison and shows no
change badge and no trend insight. A change in a rate is stated only when both
windows have a rate.

### Sessions
Period membership is decided by `start_at` throughout, **including for
cancellations**. Every figure below is tattoo work only; consultations are
reported apart (held, cancelled, and ahead).

`draft` sessions are never counted anywhere.

- **Tattoo sessions done** — status `completed`. Tattoo work is set to
  `completed` automatically after its end time
  (`crm_private.auto_complete_due_tattoo_sessions`) unless it was cancelled or
  marked a no-show first, so this means "due and not called off" rather than
  "confirmed in person".
- **Cancellations** — status `cancelled`.
- **No-shows** — status `no_show`, counted separately.
- **Cancellation rate** — cancelled ÷ every non-draft tattoo session due in
  the period.

### Hours tattooed
Sum over `completed` tattoo sessions and touch-ups starting in the period. Consultations never count as hours. Length is
`duration_hours` where the row carries it; where it does not — older rows
predate the column being filled — the wall-clock span between `start_at` and
`end_at` is used, which is the same quantity measured a different way. A row
that yields neither contributes zero rather than a guess.

### Returning clients
Identity is `client_id`.

- **Active** — distinct (artist, client) pairs with a completed or planned
  tattoo session or touch-up starting in the period.
- **Returning** — of those, the ones with live tattoo work on **two or more
  different projects** with the same artist across their visible history.
  Several sessions of one piece are one project, not a return. A legacy
  session with no project never adds a project.

### Channels
The technical source of each enquiry, first rule that applies:

1. `communication_channel` — opened from a WhatsApp or Instagram conversation.
2. `source = 'crm_manual'` — typed into the CRM.
3. `utm_medium` is paid (`paid`, `cpc`, `ppc`, `cpm`, `paid_social`, ...) — a
   paid campaign; Instagram and Facebook placements are one "Meta ads" channel.
4. any other `utm_source` — a campaign tag.
5. `referrer_host` — social, search, AI assistant or another site. The
   studio's own sites are reported as "own website, origin unknown".
6. nothing — "direct or not recorded". Never called organic.

The booking form (`booking_source_id`) is not a channel: every website enquiry
carries it, and ranking it first hid every campaign tag behind one row.

Per channel: enquiries, how many had a consultation, how many booked tattoo
work. No rate column: young enquiries have not failed to book.

### Self-reported discovery source

The separate **How clients heard about you** block uses
`enquiries.discovery_source`. Its canonical taxonomy lives in
`config/discovery-sources.json`; booking Worker validation and generated
public/hosted booking choices consume the same registry.

Historical aliases are normalised through that registry. NULL/empty values are
shown as **Not recorded**. A non-empty value that is not yet in the registry is
still emitted as its own row with a humanised fallback label instead of being
collapsed into Not recorded. This makes the statistics block forward-compatible
during rollout or unexpected schema drift and, crucially, never hides real
attribution data.

`scripts/test-discovery-source-registry.mjs` is a fail-closed contract check.
It verifies that the registry matches the final
`enquiries_discovery_source_known` database constraint, the current CRM AI
validator contract, and Vladimir's static booking form. The public and hosted
Worker forms render their options directly from the registry. A taxonomy change
therefore cannot silently reach production with statistics or booking forms on
a different vocabulary.

### Funnel
Enquiry → had a consultation → booked a tattoo → tattoo done, as a cohort of
the enquiries created in the period. Every stage counts **distinct enquiries**
and is shown as a share of the enquiries, because a tattoo can be booked
without a consultation. Tattoo work with no link to an enquiry is reported
separately.

### Over time
Enquiries by `created_at` and non-draft sessions by `start_at`, bucketed by
day (≤31 days), week starting Monday (≤120 days) or month. Every bucket in
range is emitted, including empty ones, so a quiet week reads as a gap.

### Diary ahead
Twelve weeks from the artist's current local Monday (`artists.timezone`; each
boundary converted on its own so a clock change cannot shift a week): tattoo
sessions and hours per week, consultations per week as a separate count, and
the number of tattoo sessions booked beyond the twelve weeks.

**No utilisation percentage is shown.** The CRM holds no provable capacity
denominator.

### Money
Shown only where the database returned finance. Three money concepts are
kept apart and never added into one another; each is per currency:

- **Actual received**: succeeded payment transactions only.
- **Confirmed value**: `sessions.price`, the price saved on one session. It is
  the only value booking cards, payment requests and the balance after a
  deposit use.
- **Estimated value**: computed on every read by
  `crm_private.session_value_estimate` from the artist's own rates
  (`crm_private.artist_session_pricing`) or the project's own hourly rate,
  and the planned length. It is the server copy of `suggestSessionPrice()`
  (the price the CRM suggests while booking); the same cases pin both. It is
  never written to `sessions.price`, never sent to a client and never used for
  a payment request. A later change of the artist's rates moves estimates
  only; a saved price never changes.

How a price becomes confirmed: when a tattoo session is booked, the CRM
pre-fills the price field with the same suggestion (the project's own rate,
else the artist's own rates), visibly and editably. Booking with the amount in
the field saves it as the session's confirmed price. While the operator has
not typed, the amount follows the chosen length; a typed amount is kept.
"Price TBD" books without a price, and Statistics keeps estimating that
session until a price is saved. Editing an existing session never replaces
its saved price; it only offers a one-tap suggestion.

Changes after booking, read on the next load (no stored copy to go stale):
a reschedule counts the session at its new date and new length, so its
estimate follows; a cancelled session leaves the forecast and its deposit is
no longer taken off; a saved price never changes when the session is moved,
lengthened or shortened, or when the artist's rates change. Checked through
the CRM's own `reschedule_appointment` and `set_appointment_status` in
`1846_statistics_session_value.sql`.

An artist without rates has no basis for an estimate. Another artist's rates
are never borrowed: those sessions are counted with their hours as "without a
basis", and the screen says the rates are missing.

| Figure | Definition |
| --- | --- |
| Payments received | `succeeded` `credit` transactions, refund types excluded, by `occurred_at`. Deposits are included here |
| Refunded | Succeeded `debit` or refund-type transactions. Shown apart, never subtracted |
| Upcoming confirmed sessions (forecast) | Confirmed tattoo sessions from now on, plus touch-ups that carry a saved price (touch-ups are often free, so none is estimated). Consultations, cancelled and past sessions never enter. A rescheduled session counts at its new date |
| Confirmed price | Sum of `sessions.price` of those sessions, with their count |
| Estimated from rates | For each session without a saved price: the project's hourly rate × length; at the artist's standard rate a session of at least the configured day length is the day price; without a project rate, the artist's day price or hourly rate × length. Shown with "≈" and a dashed outline |
| Expected value | Confirmed plus estimated |
| Forecast still to collect | Expected value minus the paid deposit `crm_private.booking_card_deposit_for_session` allocates to each session, once, never below zero per session. While any estimate is in it, it is labelled a forecast ("Прогнозируемый остаток к получению"), shown with "≈", and the part at confirmed prices alone is printed beside it. Only when every price is confirmed is it labelled "Still to collect at confirmed prices" |
| Completeness | "{confirmed} of {total} sessions have a confirmed price", always shown. The former rule that hid the forecast below 80% coverage was removed on 2026-10-15 |
| Waiting to be paid | Requests with status `pending` and no past `expires_at`, read today whatever their creation date. Unexpired part-paid requests are counted, not summed, because their remainder is not in the projection |

Removed 2026-10-15: "Deposits requested" (summed cancelled and re-issued
requests: £2,250 shown for £1,250 actually requested and paid) and "Quoted on
new projects" (an estimate on 3 of 8 projects, read next to real money).

## Insights

Deterministic sentences derived from the aggregates above, shown directly under
the period controls.

| Insight | Requires |
| --- | --- |
| Channel with no bookings | ≥8 mature enquiries from one channel (not direct, manual or own site) and none booked |
| Enquiry trend | comparable periods, ≥5 enquiries in both and a change of ≥10% |
| Conversion trend | comparable periods, ≥8 mature enquiries in both and a change of ≥5 points |
| Tattoo cancellations | comparable periods, ≥8 tattoo bookings due in both |

These are floors, not significance tests.

## Deliberately not in the first version

- **A utilisation or "load" percentage.** No provable denominator. See above.
- **Server-side aggregation.** Planned as Statistics 2.0 (`specs/statistics-2/`).
- **Session price as revenue.** `sessions.price` and the estimate are what a
  session is worth, not what was collected; `payment_transactions` answers
  what was collected, and the screen keeps them in separate blocks.
- **Client-level or enquiry-level drill-down.** The screen is aggregates only,
  and reads no contact column to produce them.
- **Cross-artist comparison.** Each viewer sees their own permitted scope; a
  league table would need a scope the authorization model does not grant.
- **Export.** No CSV or PDF yet.
- **Per-artist timezones.** Periods are whole days in the *browser's* local
  timezone, not each artist's `artists.timezone`. For a single-timezone studio
  these are the same; for a studio spanning timezones a period boundary could
  place a late-evening record on the neighbouring day. Fixing it properly means
  choosing whose day a multi-artist aggregate belongs to, which is a product
  decision rather than a bug fix.

## Tests

- `supabase/tests/1845_statistics_core.sql` — every definition on fixtures
  (consultation is not a conversion, two projects make a returning client,
  cancelled/paid/expired requests are not owed, maturity, channel rules, a
  draft dated by its confirmation, diary weeks across a clock change) and the
  denials (another artist, no finance, anonymous, window limit); GPT reads the
  same core.
- `supabase/tests/1844_statistics_projection_attribution.sql` — the projection
  columns, host-only referrer, exclusion lineage.
- `admin/src/test/statistics-overview.test.ts` — combining artists (counts only,
  medians per artist), attention items, insights, the forecast combined
  across artists.
- `supabase/tests/1846_statistics_session_value.sql` — estimate cases, the
  three money concepts, deposits taken off once, cancelled/consultation/
  free touch-up/past sessions out, a reschedule, a longer session, a new
  artist rate (saved prices untouched, nothing written to `sessions.price`),
  an artist without rates, the GPT forecast from the same core.
- `supabase/tests/1847_consultation_outcome.sql` — a past date is not held,
  evidence completes (and is audited), no evidence / earlier booking /
  cancelled booking / cancelled or upcoming consultation stay as they are,
  held / no-show / awaiting counted apart, backend-only resolution.
- `admin/src/test/consultation-outcomes.test.tsx` — the outcome list and its
  two answers through the status RPC.
- `admin/src/test/session-pricing.test.ts` — the same estimate cases against
  the CRM's price suggestion.
- `admin/scripts/check-mobile-layout.mjs` — the first phone screen, measured
  in Chromium (see the top of this document).
- `admin/src/test/statistics-api.test.ts` — one RPC call, artist scope left to
  the database, refusal surfaced as an error.
- `admin/src/test/statistics-page.test.tsx` — order on a phone, money for
  exactly the viewer the database returns it to, actual vs expected money, no
  change without history.
