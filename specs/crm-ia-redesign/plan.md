# Plan: CRM IA redesign

## Phase 1 (implemented)

- `EnquiriesPage`: the view toggle, status select and search share one
  flex row in one card; labels are visually hidden but kept for assistive
  technology. The board's "active only" hint is one line under the toolbar.
- `DetailHeader` (DetailContext): Back and a "Artist: X" chip in one row.
  When the CRM filter points to another artist, or the artist is
  unavailable, the existing notice with its switch action is shown instead.
  Used by enquiry, project and invoice records.
- `ProjectDetailPage`: a sticky jump bar (Sessions, Money, Notes, Activity;
  buttons, because the router uses the URL hash) and the money parts grouped
  after sessions: estimate, deposit, invoices. `Section` accepts an `id`.

## Later phases

See spec. Each phase: code, tests, exact-head CI, merge, release, readback.
