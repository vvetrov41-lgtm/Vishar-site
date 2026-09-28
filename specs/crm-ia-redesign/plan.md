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

## Audit before phases 2-4 (2026-09-28, code at 6d8640b1)

The spec was written against an older screen set. Re-reading the current
code changed the plan:

- Phase 2 is already in production in substance. `DashboardPage` builds
  "Needs you now" from open follow-ups, unanswered conversations, email
  drafts, deposits and failed jobs (`summariseToday`, `pulseToTodayItems`);
  every row opens the record. Adding separate Follow-ups and Conversations
  sections would repeat the same rows. Not implemented.
- Phase 4 for the client record is already in production: `ClientMobileTabs`
  (Work / Messages / History / Details). The enquiry record already opens
  with the next action, then booking, then collapsed WhatsApp, client,
  follow-ups and notes. No change needed there either.
- What remained was the number of destinations: 16 in the sidebar, 12 in
  the phone's More sheet. That is phase 3.

## Phase 3 (this change)

- `/money` and `/settings` hub pages (`HubPage`): an index of the screens
  the shell would have shown this person, each with one line saying what it
  is for. No route removed; each screen keeps its own capability gate.
- Phone More sheet: Work (Enquiries, Follow-ups, Projects, Statistics), then
  Manage (Money, Settings). Twelve links became six for the owner. A hub
  that would list a single screen links to that screen directly.
- Desktop sidebar keeps every screen one click away; the Money and Settings
  group labels link to the hubs. "Setup" is renamed "Settings" in English to
  match the hub (Russian was already "Настройки").
- The More trigger and the hub entry are marked current on any screen the
  hub lists.
