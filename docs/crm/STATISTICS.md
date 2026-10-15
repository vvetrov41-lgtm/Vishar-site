# Statistics

The CRM's Statistics screen at `/statistics`. Every figure it shows is a count
of the studio's own records; none of it comes from a telemetry system, and
none of it is estimated.

This document is the contract. Where it and the screen disagree, one of them is
a bug — `admin/src/lib/statistics.ts` carries the same definitions in code, and
`admin/src/test/statistics.test.ts` pins them.

## Where the numbers come from

Existing CRM tables, read through the security_invoker `statistics_*`
projections: `statistics_enquiries`, `statistics_projects`,
`statistics_sessions` and, behind finance access only,
`statistics_payment_transactions` and `statistics_payment_requests`.

The projections remove explicitly excluded test lineage
(`20260920185324_analytics_exclusion.sql`). On 2026-10-15
(`20261015100000_statistics_projection_attribution.sql`) they gained columns,
appended only: `utm_medium`, `utm_campaign` and `referrer_host` (the referrer's
host, never its URL) on enquiries; `created_at` on sessions; `expires_at` on
payment requests. Every one of them was already readable by `authenticated` on
its base table, so no access was widened. There is no aggregate RPC yet.

PostHog is not involved. The product-analytics workstream measures how the CRM
itself is used and is deliberately not a source of business figures.

## Access

Reads go through `admin/src/lib/statistics-api.ts`. Each is an artist-scoped
select on a table the CRM already reads elsewhere.

- Operational rows (`enquiries`, `projects`, `sessions`) are governed by
  `can_access_artist(artist_id)`, which resolves to
  `crm_private.has_artist_capability(artist_id, 'view')`.
- Finance rows (`payment_transactions`, `payment_requests`) are governed by
  `can_view_artist_finance(artist_id)` →
  `has_artist_capability(artist_id, 'view_finance')`. `projects_finance` is a
  `security_invoker`, `security_barrier` view over `crm_private`, so it is
  scoped by the same rule.
- `sessions.price`, `projects.estimate_total`, `hourly_rate` and
  `deposit_amount` are not granted to `authenticated` at all at the column
  level. The screen never selects them from the base tables.

The artist selector narrows the question; it does not grant anything. With no
artist chosen the browser adds no `artist_id` filter, so the answer is exactly
what row level security allows — re-implementing the scope in the browser would
create a second, weaker copy of it.

The money section renders only when the finance reads returned rows. A refused
finance read is treated as "no money section", never as a page error, so a
viewer without finance access sees a complete screen minus that block.

Reads are paged (500 rows at a time, ceiling 20 000) rather than capped at the
200–300 the working-queue reads use. Reads by id list are sent 100 ids per
request, so no request URL grows with the period. A silently clipped page would produce a
number that is simply false. Hitting the ceiling sets a flag and the screen
says the figures are partial.

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

### Booked ahead
Planned tattoo sessions starting in the next **90 days**, as a count and hours,
and the consultations in the same window as a separate count.

**No utilisation percentage is shown.** The CRM holds no provable capacity
denominator.

### Money
Shown only where the database returned finance rows. Three quantities, **never
added together**, each **per currency**:

| Figure | Definition |
| --- | --- |
| Payments received | `succeeded` `credit` transactions, refund types excluded, by `occurred_at`. Deposits are included here |
| Refunded | Succeeded `debit` or refund-type transactions. Shown apart, never subtracted |
| Waiting to be paid | Requests with status `pending` and no past `expires_at`, read today whatever their creation date. Part-paid requests are counted, not summed, because their remainder is not in the projection |

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
- **Session price and payment status as revenue.** `sessions_finance.price` is
  what a session is priced at, not what was collected; `payment_transactions`
  already answers what was collected. Adding a second, softer revenue figure
  next to the hard one would invite the two to be read as the same thing.
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

- `admin/src/test/statistics.test.ts` — every formula above: period boundaries,
  half-open membership, current vs previous, conversion cohorts, cancellation
  and no-show separation, hours fallback, repeat-client pairing, source
  priority, funnel legacy rows, bucket edges, currency separation, insight
  floors and determinism.
- `admin/src/test/statistics-api.test.ts` — artist scoping, date bounds,
  paging to exhaustion, the truncation flag, unbounded conversion reads, the
  narrow column list, and the finance and registry reads failing closed.
- `admin/src/test/statistics-page.test.tsx` — the money section appearing for
  exactly the roles the database returns finance rows to, the empty period, the
  absence of any utilisation percentage, the custom range guard, and a
  phone-width render.
