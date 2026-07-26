# PATCH PLAN - /cover-up-tattoo-manchester/

Status: proposal only. No production file is modified by this document.
Target file: `cover-up-tattoo-manchester/index.html` (387 lines).
Scope rule accepted from the owner: close the identified gaps without any
mandatory increase in page length.

## Verification That Reset This Plan

The four gaps in the first version of `PAGE_TZ.md` came from comparing
competitor headings against this page's headings. Reading the page body
changed the finding. Verified against the live file:

| Claimed gap | Actual state | Evidence |
| --- | --- | --- |
| Success and failure criteria | Present | Line 272 block: darker-covers-darker, size, laser optional, both styles. FAQ line 295 lists ink colour, density, darkness, size, placement, scarring, skin condition, space |
| Laser as an alternative | Present in three places | Line 162 process step 2; line 272 "Laser is optional"; FAQ "Do I need laser removal before a cover-up?" |
| Design constraints | Present | Lines 151, 163, 272 |
| Session and healing reality | Partially present | Line 164 states cover-ups take longer due to layering; session split and inter-session healing are not stated |

Two items survive verification. Both are edits to existing text, not additions.

## Patch 1 - Extractable answer passage

**Problem.** The page opens on atmosphere. `<h1>` at line 127 reads
"Cover-ups." - two words, no service term, no location, no entity. The first
body text at line 143 is "A Second Chance for Your Skin". Nothing in the
opening states what the service is, where it happens, who performs it, or what
the first step is, in one passage that survives being quoted alone.

The page extracts to 6,333 characters of clean content, so this is not an
access or rendering problem. The material is reachable; it is simply not
shaped for extraction.

**Change.** Rewrite the existing first paragraph at line 145-147 in place.
Three to five sentences, each independently true when quoted out of context,
stating: custom cover-up tattooing in Manchester by a realism artist working in
Salford; every case begins with a photo assessment; suitability depends on the
existing tattoo rather than on budget.

**Not changed.** Word count stays flat - this replaces existing sentences.
No new section, no new heading.

**Risk.** Low. Copy-only edit inside one paragraph. No schema, layout or
component change.

## Patch 2 - Make the session structure explicit

**Problem.** Line 164 states cover-ups "typically take longer than equivalent
fresh tattoos due to the additional layering required" and stops there. A
reader planning a multi-session project cannot tell how the work divides or why
gaps between sessions exist. Both parsed competitor pages treat process depth
as a distinct module.

**Change.** Extend process step 4 at line 164 by two or three sentences: how
cover-up work is staged across sessions, and why healing between sessions
affects the result. Keep it conditional - actual session counts depend on
assessment.

**Constraint.** Do not state a specific number of sessions as a general rule,
do not state timings, and do not add aftercare instruction. Link to the
existing aftercare page instead.

**Risk.** Low. Text extension inside an existing step; no structural change.

## Deliberately Not Proposed

- **Rewriting `<h1>`.** "Cover-ups." carries no topic or location, and the same
  pattern runs across the whole site. Changing it would improve topical
  signalling, but it is a brand and design decision that reaches beyond this
  page, and the owner has not asked for a redesign. Raised, not planned.
- **Padding to competitor length.** Coverage is already comparable; the
  competitor pages are longer, not more complete.
- **Schema changes.** The graph is sound: `Service` with `provider` pointing at
  the `#person` node, `areaServed` Manchester and Salford, `Offer` at 140 GBP
  per hour, plus `FAQPage` and `BreadcrumbList`. Nothing to fix.
- **New FAQ entries.** The six questions proposed in the earlier brief are
  already answered on the page.

## Facts That Must Not Move

- The 140 GBP hourly rate stays exactly as written.
- No booking windows, waiting times or availability.
- No awards, review counts or client numbers introduced.
- No superlatives.
- British English throughout.
- No Regrets Studios stays incidental to location and studio process.
- Cover-up outcomes stay conditional on assessment.

## Execution Order

1. Owner approves this plan.
2. Patch 1 and Patch 2 applied to `cover-up-tattoo-manchester/index.html`.
3. `npm run validate` or the repository's static validation before commit.
4. Re-run `llm-access-audit` on the page and compare clean-content extraction
   against the 6,333-character baseline recorded here.

No step begins before point 1.
