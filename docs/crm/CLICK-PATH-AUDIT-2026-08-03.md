# CRM click-path audit — 2026-08-03

- **Repository:** `vvetrov41-lgtm/Vishar-site`
- **Branch:** `agent/multi-artist-payments-foundation`
- **Starting head:** `c78f03dad0388f5ad5471b141b5cc0b193fcd99b`
- **Related decision:** `docs/crm/adr/0001-responsive-navigation-and-artist-scope.md`
- **Audit type:** implementation and route audit against the current CRM source

This pass evaluates the current responsive shell, route tree, role-filtered navigation and critical operational journeys. It does not replace an authenticated hosted-device pass through Cloudflare Access.

## Scope

### Roles

- owner
- booking manager
- read only

### Responsive surfaces

- narrow mobile: `320–380px`
- phone and portrait tablet: below `900px`
- wide tablet and desktop: `900px` and above

### Critical tasks

- change artist context;
- review and progress a new enquiry;
- assign an enquiry;
- convert an accepted enquiry into a project;
- open a client and move between related records;
- schedule and progress a session;
- record a deposit status;
- reach users and activity according to role;
- return safely from detail routes.

## Current route and navigation model

### Primary mobile destinations

The implementation currently derives primary destinations by filtering the general navigation list. The resulting order is:

1. Dashboard
2. Enquiries
3. Clients
4. Sessions
5. More

The architecture target is Dashboard, Enquiries, Sessions, Clients, More. The current use of a `Set` controls membership but not target ordering.

### Overflow destinations

For an owner, `More` currently contains:

- Projects
- Users
- Activity

Role filtering removes destinations that the profile cannot use. Future finance, integrations and settings will also need an overflow grouping rule before they are exposed.

### Detail routes

- `/enquiries/:id`
- `/clients/:id`
- `/projects/:id`

Parent destinations remain active because the shell uses prefix matching.

## Journey audit

## 1. Switch artist context

**Path:** current page → artist selector → choose artist

**Minimum interaction count:** 2 taps

**What works**

- The selector is full-width on mobile.
- Values come from accessible active artists.
- Persisted values are revalidated before reuse.
- Operational list pages refetch when the selected artist changes.

**Friction and risk**

- The selector remains visible on Clients and Users even though those results are not filtered by `selectedArtistId`.
- A user can switch artist while viewing an enquiry or project detail, but those detail loaders do not depend on the selected scope. The header and record can therefore describe different contexts without explanation.
- Failure to load accessible artists is stored as `error=true` but is not shown in the shell.

**Result:** needs correction before further artist-scoped sections are added.

## 2. Review a new enquiry

**Path:** Dashboard → Open queue → enquiry row → enquiry detail

**Minimum interaction count:** 3 taps

**What works**

- The dashboard provides a direct queue link.
- The enquiry list supports status and reference search.
- Rows expose reference, status, assignment state and project type.
- Detail access is capability-guarded.

**Friction and risk**

- The detail page places contact, project information and reference images before transition and assignment controls.
- On a phone, the most common operational actions can require a long scroll before the user can progress or assign the enquiry.
- There is no contextual back control or breadcrumb; return relies on browser history or reopening Enquiries from the bottom bar.

**Result:** functionally complete, but action placement is inefficient on mobile.

## 3. Assign and progress an enquiry

**Path:** enquiry detail → transition action → assignment selector

**Minimum interaction count:** 2 interactions after reaching the detail page

**What works**

- Transition options are derived from the allow-list and role.
- Assignment choices come from assignable profiles.
- Busy and error states are present.

**Friction and risk**

- Transition and assignment are separate lower-page sections instead of one action area.
- The user may have to scroll again after a transition reload to continue assignment or conversion.
- Destructive or consequential transitions have no structured confirmation pattern yet.

**Result:** correct authorization presentation; weak task continuity.

## 4. Convert an enquiry into a project

**Path:** Enquiries → accepted or deposit-paid enquiry → Convert → project detail

**Minimum interaction count:** 4 taps plus scrolling

**What works**

- Conversion is shown only for eligible statuses and roles.
- Incomplete intake blocks conversion.
- Success navigates directly to the new project.

**Friction and risk**

- Conversion appears after contact, project data, reference images, transitions and assignment.
- The generated project title is accepted immediately with no review step.
- There is no compact action summary showing what remains before conversion.

**Result:** technically direct after discovery, but the control is buried.

## 5. Open a client and related records

**Path:** Clients → client → related enquiry or project

**Minimum interaction count:** 3 taps

**What works**

- Client search is simple and mobile-friendly.
- Client detail links directly to enquiries and projects.
- Shared clients can expose records across the accessible artist set according to RLS.

**Friction and risk**

- The global artist selector implies filtering even though `ClientsPage` does not consume artist scope.
- Client rows do not show artist relationships, so an owner cannot see why a shared client appears under the current context.
- There is no explicit shared-record label.

**Result:** navigation is short; scope semantics are unclear.

## 6. Schedule a session

**Path:** More → Projects → project → Sessions section → enter start/end → Propose session

**Minimum interaction count:** 4 taps plus form entry and scrolling

**What works**

- Sessions are managed inside the project context.
- Start and end values are validated before submission.
- Session status actions are capability-filtered.

**Friction and risk**

- Projects are correctly secondary, but the session creation form can be far below project summary and estimate content.
- The form has two independent datetime inputs with no duration shortcut, common-time presets or conflict indication.
- Session rows are not separate routes, so the global Sessions page cannot lead to a focused session detail workflow.

**Result:** usable foundation; likely high friction for frequent booking work.

## 7. Progress a session from the dashboard

**Path:** Dashboard → upcoming session

**Current result:** no navigation path

Upcoming session rows are plain `div` elements. They show time, status and duration but do not open the project or a session detail. The user must instead navigate to Sessions or Projects and locate the same record again.

**Result:** action dead end.

## 8. Resolve an overdue follow-up from the dashboard

**Path:** Dashboard → overdue follow-up

**Current result:** no navigation path

Overdue follow-ups are displayed as non-interactive rows. The user cannot open the related enquiry, client or project from the dashboard item.

**Result:** action dead end.

## 9. Reach owner administration

**Path:** More → Users or Activity

**Minimum interaction count:** 2 taps

**What works**

- Administration does not consume permanent mobile-tab space.
- Role filtering prevents booking managers and read-only users from seeing Users.
- Activity remains visible only where capability rules allow it.

**Friction and risk**

- The overflow is currently flat. Adding payments, integrations and settings without grouping will reproduce the original navigation crowding inside the sheet.
- Artist scope is visible on Users even though it does not scope that page.

**Result:** correct current placement; grouping required before expansion.

## 10. Open and close the mobile More sheet

**Path:** More → overflow destination or dismiss

**What works**

- The sheet has dialog semantics.
- Escape and backdrop interaction close it.
- Navigation closes it after the route changes.

**Friction and risk**

- Focus is not moved into the sheet when it opens.
- Focus is not trapped inside the modal surface.
- Focus is not explicitly restored to the More trigger after dismissal.
- Background scrolling is not locked.

**Result:** visually modal, but the keyboard and screen-reader lifecycle is incomplete.

## Findings by priority

### P0 — blocking

No source-level click-path blocker was found in the audited route tree.

### P1 — resolve before adding finance and more navigation sections

1. **Artist-scope applicability is ambiguous.** Hide or explicitly neutralize it on shared/global pages.
2. **Detail routes can conflict with selected scope.** Show the record artist and a deliberate scope-mismatch action.
3. **Critical enquiry actions are buried.** Create an action-first summary near the top of enquiry detail.
4. **Detail pages lack contextual return.** Add a stable back/breadcrumb pattern that does not depend entirely on browser history.
5. **Dashboard operational rows are dead ends.** Link upcoming sessions and overdue follow-ups to their working context.
6. **The More sheet lacks a complete modal focus lifecycle.** Add focus entry, containment, restoration and scroll locking.
7. **Artist-scope loading failure is silent.** Expose a compact error state without weakening RLS behavior.

### P2 — improve during the next interaction pass

1. Make mobile primary order explicit: Dashboard, Enquiries, Sessions, Clients, More.
2. Group overflow destinations before adding finance, integrations and settings.
3. Consider debouncing enquiry and client search to avoid a request on each keystroke.
4. Add artist relationship context to shared client rows or detail screens.
5. Add session-duration shortcuts and conflict feedback when scheduling becomes a daily workflow.
6. Review confirmation requirements for consequential status changes.

## Recommended implementation order

### Phase 1: navigation and context guardrails

- replace Set-based primary membership with an explicit ordered path array;
- define page scope as `artist`, `shared` or `global`;
- hide or annotate the selector according to page scope;
- expose artist-scope load failure;
- complete More-sheet focus behavior.

### Phase 2: detail-route continuity

- add a contextual page header/back pattern;
- show record artist on enquiry and project details;
- handle selected-scope mismatch explicitly;
- keep parent navigation active for all nested routes.

### Phase 3: action-first operational screens

- move enquiry transition, assignment and conversion summary above long reference content;
- link dashboard sessions and follow-ups to their source records;
- preserve secondary content in sections below the action area.

### Phase 4: expansion readiness

- group More destinations;
- add Finance only after its route scope and primary click paths are recorded;
- add automated path tests for each role and responsive navigation model.

## Acceptance checks for the next implementation pass

### Owner

- can switch between all assigned artists;
- sees a clear shared/global state on Clients and Users;
- reaches Enquiries and Sessions in one bottom-nav tap;
- reaches Projects, Users and Activity in two taps;
- opens a dashboard session or follow-up directly;
- cannot accidentally view a record under a misleading artist context.

### Booking manager

- sees only permitted destinations;
- can review, assign, progress and convert according to capability rules;
- never sees finance controls or owner administration;
- has the same detail-return and scope-mismatch behavior as the owner.

### Read only

- sees only read destinations;
- cannot see transition, assignment, conversion, note creation or finance actions;
- can navigate lists and detail routes without dead ends;
- does not receive empty administrative navigation groups.

### Accessibility

- each navigation landmark has a stable accessible name;
- tests do not rely on the first matching navigation landmark;
- the More trigger reports expanded state;
- focus enters, remains in and returns from the modal sheet;
- all tap targets remain at least `44px`.

## Safety constraints

This audit does not alter production, hosted Supabase, RLS, ACL, Storage policies, WAF, rate limiting or staging data. UI scope remains a convenience layer over the existing authorization boundary.
