# Statistics

The CRM's Statistics screen at `/statistics`. Every figure it shows is a count
of the studio's own records; none of it comes from a telemetry system, and
none of it is estimated.

This document is the contract. Where it and the screen disagree, one of them is
a bug — `admin/src/lib/statistics.ts` carries the same definitions in code, and
`admin/src/test/statistics.test.ts` pins them.

## Where the numbers come from

Existing CRM tables, read through ordinary artist-scoped selects:
`enquiries`, `projects`, `sessions`, `booking_sources`, and — behind finance
access only — `payment_transactions`, `payment_requests`, `projects_finance`.

There is no statistics migration. No view, no aggregate RPC, no index and no
analytics table were added, because none was needed: the existing schema
answers every question on the screen, and every row it returns is already
scoped by the policies the rest of the CRM relies on.

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
200–300 the working-queue reads use. A silently clipped page would produce a
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

### Conversion
Cohort-based.

- **Denominator** — enquiries created in the period, as above. Membership is
  decided by `created_at` and no other timestamp.
- **Converted** — an enquiry in that cohort referenced by at least one project
  (`projects.enquiry_id`) or at least one non-draft session
  (`sessions.enquiry_id`, or `sessions.project_id` → that project's
  `enquiry_id`).
- The project or session may have been created **after** the period ended. The
  question is what became of the cohort, not what happened inside a window.
- An enquiry counts once however many projects it produced.
- Over an empty cohort the rate is **not shown**, rather than shown as 0%.

Because a young cohort has had less time to convert, the screen states how many
of the period's enquiries are older than 14 days whenever some are not.

### Projects created
Rows in `projects` with `created_at` inside the period, `archived_at IS NULL`.

### Sessions
Period membership is decided by `start_at` throughout, **including for
cancellations**. One timestamp on both sides of the division; using
`cancelled_at` for the numerator and `start_at` for the denominator would
divide two different populations.

`draft` sessions are never counted anywhere — a draft is a half-written row.

- **Sessions completed** — status `completed`.
- **Sessions planned** — status `proposed` or `confirmed`.
- **Cancellations** — status `cancelled`.
- **No-shows** — status `no_show`, counted and displayed **separately**. A
  client not arriving is not the booking being called off, and merging them
  would make the cancellation rate unreadable.
- **Cancellation rate** — cancelled ÷ every non-draft session due to start in
  the period.

### Hours worked
Sum over `completed` sessions starting in the period. Length is
`duration_hours` where the row carries it; where it does not — older rows
predate the column being filled — the wall-clock span between `start_at` and
`end_at` is used, which is the same quantity measured a different way. A row
that yields neither contributes zero rather than a guess.

### Repeat clients
Identity is `client_id`. Never a matching name, email or phone string: the CRM
already resolves intake to a client row, and that row is the answer.

- **Active** — distinct clients with a completed or planned session starting in
  the period.
- **Repeat** — of those, the ones with **two or more** completed or planned
  sessions with the **same artist** across their whole history (the history the
  viewer is permitted to read). Pairing is (client, artist), so a client seen
  once by each of two artists is a repeat client for neither.

History outside the period is counted, or a client of three years would be
called new because their second visit happens to be their only one this month.

### Sources
Exactly one rule fires per enquiry, in strict priority order:

1. `booking_source_id` — a row in the booking source registry.
2. `communication_channel` — WhatsApp or Instagram.
3. `utm_source` — a campaign tag.
4. `source` — the raw landing path or intake marker the form recorded.
5. Nothing — reported as "No source recorded".

No two values are ever merged. Two registry forms sitting on the same landing
page stay two rows, because they are two registry entries.

Labels for registry forms come from `booking_sources.display_label`. That table
is readable only to whoever may manage booking sources, which a working artist
need not be; when the read is refused the enquiry's own `source` value is used
instead — a second authoritative field on the same row, not a guess — and
distinct forms remain distinct rows either way.

Per source: enquiries in the period, how many converted (same rule as
Conversion above), and the rate.

### Funnel
Enquiry → Project → Session, as a cohort of the enquiries created in the
period. Every stage counts **distinct enquiries**, not rows.

Rows in the period carrying no link back up the chain — a project with no
`enquiry_id`, a session with neither `enquiry_id` nor a linked project — are
**reported separately, never counted as zero**. A project created before the
CRM recorded `enquiry_id` did come from somewhere, and folding it into the
cohort as unconverted would understate every historical period.

### Over time
Enquiries by `created_at` and non-draft sessions by `start_at`, bucketed by
day (≤31 days), week starting Monday (≤120 days) or month. Every bucket in
range is emitted, including empty ones, so a quiet week reads as a gap.

### Booked ahead
Planned sessions starting in the next **90 days**, as a count and a total of
hours.

**No utilisation percentage is shown.** A percentage needs a denominator, and
the CRM holds no provable one: `artist_scheduling_policy` and
`artist_availability_time_off` describe preferences and absences, not contracted
capacity. A made-up denominator would make "73% booked" meaningless, so the
figure is stated in hours instead.

Ninety days rather than thirty because tattoo work is booked months ahead: the
production diary at the time of writing held 60.5 hours between six and eleven
weeks out and nothing inside a month. The window is named in every label.

### Money
Shown only where the database returned finance rows. Four quantities, **never
added together**, each reported **per currency** — adding GBP to anything else
produces a number denominated in nothing:

| Figure | Definition |
| --- | --- |
| Payments received | `payment_transactions` with `status = 'succeeded'`, `direction = 'credit'`, excluding refund types, placed by `occurred_at` — when the money moved |
| Refunded | Succeeded `debit` transactions and `refund` / `partial_refund` types. Shown apart, **never subtracted** from the figure above |
| Deposits requested | `payment_requests` with `purpose = 'deposit'` by `created_at`, whatever became of them. A request is not a payment |
| Quoted on new projects | `projects_finance.estimate_total` for projects created in the period. An estimate, explicitly **not revenue** |

Failed transactions are excluded entirely: a payment that did not go through is
not income. A project with no estimate is skipped, not counted as zero.

## Insights

Deterministic sentences derived from the aggregates above. No model, no
network, no customer data leaves the browser. The same aggregates always give
the same sentences in the same order.

Minimum denominators, below which a comparison is noise and nothing is said:

| Insight | Requires |
| --- | --- |
| Enquiry trend | ≥5 enquiries in **both** windows and a change of ≥10% |
| Conversion trend | ≥8 enquiries in both cohorts and a change of ≥5 points |
| Busiest weekday | ≥8 sessions in the period **and** one day strictly ahead of the rest — a tie has no busiest day |
| Leading source | ≥5 enquiries from that source |
| Cancellations | ≥8 bookings due in **both** windows |

These are floors, not significance tests, and the copy does not claim
otherwise.

## Deliberately not in the first version

- **A utilisation or "load" percentage.** No provable denominator. See above.
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
