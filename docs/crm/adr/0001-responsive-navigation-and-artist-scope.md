# ADR 0001: Responsive navigation and artist scope

- **Status:** Accepted for the PR #177 draft implementation
- **Date:** 2026-08-03
- **Decision owners:** CRM product and engineering
- **Applies to:** `admin/`

## Context

The CRM must remain usable on iPhone and iPad while its information architecture expands beyond enquiries, clients, projects and sessions into payments, integrations, users, activity and settings.

The previous mobile header placed identity, artist selection, language and sign-out controls in one row. The navigation also had no stable growth rule, so each new section risked making the mobile shell wider and harder to understand.

Artist scope is a usability context, not an authorization boundary. The database RLS policies, grants and workflow RPC checks remain authoritative.

## Decision

### 1. Use one responsive application shell

The CRM uses the same route and capability model on every device, with different navigation surfaces:

- widths below `900px`: sticky header, four primary bottom destinations and one `More` action;
- widths from `900px`: persistent sidebar and desktop header;
- detail routes remain children of their parent section and must keep the parent destination active.

The breakpoint is an implementation value, not a security or data boundary.

### 2. Cap mobile primary navigation at five actions

The target mobile order is:

1. Dashboard
2. Enquiries
3. Sessions
4. Clients
5. More

`More` contains every destination that is not intentionally promoted to the primary set. Adding a new CRM section must not automatically add another bottom tab.

Projects remain in `More`: they are normally reached from an enquiry or client and are less time-critical than the sessions queue. Users, activity, finance, integrations and settings also belong in `More` unless click-path evidence justifies promotion.

When the overflow grows, it must be grouped by task rather than presented as one unbounded list:

- Work: Projects
- Money: Payments and finance
- Administration: Users, activity, integrations and settings

### 3. Keep identity controls out of the mobile header row

The compact header contains the product name or current page title and a profile trigger. The profile panel owns:

- signed-in identity;
- CRM role;
- language;
- sign out.

The signed-in user name is not required to remain permanently visible on a phone.

### 4. Treat artist scope as an explicit operational context

The artist selector is populated only from artists accessible to the signed-in CRM profile. Persisted values must be validated against that current list before use.

The selector applies to artist-owned operational collections:

- Dashboard
- Enquiries
- Projects
- Sessions
- Activity

It does not redefine shared or administrative collections:

- Clients are shared records and may relate to more than one artist.
- Users and role administration are not artist-filtered.

Pages where the selector does not affect the result must not imply that it does. The interface should either hide the selector on those pages or show an explicit shared/global state.

### 5. Make detail routes record-authoritative

A direct link to an enquiry or project may be opened while a different artist is selected globally. The selected filter must not silently hide an otherwise authorized record, and the detail screen must not silently pretend that the record belongs to the selected artist.

Detail screens must therefore:

- display the record artist;
- show a scope-mismatch notice when the selected artist differs;
- offer a deliberate switch to the record artist or a return to the filtered list;
- rely on RLS for authorization.

Automatic artist switching on deep-link navigation is rejected because it changes global context without an explicit user action.

### 6. Keep navigation visibility capability-driven

Navigation items are filtered to avoid offering actions the user cannot perform. This is only a presentation rule. Route guards and database enforcement remain mandatory.

A hidden item must never be treated as protection, and adding a visible item must never grant access.

### 7. Preserve accessible navigation semantics

Navigation and click-path tests must prefer:

- semantic roles;
- accessible names;
- page headings;
- stable route state.

They must not depend on DOM order, responsive elements being absent from jsdom, CSS class names or the first navigation landmark in the document.

The mobile overflow behaves as a modal sheet and must eventually provide the complete focus lifecycle:

- move focus into the sheet when opened;
- keep keyboard focus within it;
- close on Escape and backdrop interaction;
- restore focus to the `More` trigger;
- prevent background scrolling while open.

## Consequences

### Positive

- Mobile navigation has a fixed capacity and remains thumb-reachable.
- New sections have a predictable home.
- Desktop and mobile share routes, capabilities and data behavior.
- Artist filtering remains visible without being confused with authorization.
- Tests can survive responsive layout changes.

### Trade-offs

- Some destinations require one extra tap through `More`.
- Detail screens need explicit record-context handling.
- Shared pages require a clear exception to the global artist selector.
- The overflow sheet requires more accessibility work than a simple inline menu.

## Rejected alternatives

### Put every section in the bottom bar

Rejected because the bar would overflow, labels would truncate and each future section would make the primary navigation less stable.

### Use a hamburger menu as the only mobile navigation

Rejected because enquiries and sessions are frequent operational destinations and should remain directly reachable.

### Use separate mobile and desktop route trees

Rejected because it would duplicate authorization presentation logic, increase test cost and create inconsistent deep links.

### Treat the artist selector as an authorization boundary

Rejected because browser state cannot enforce data access. RLS, grants and RPC checks remain the boundary.

## Implementation rules for future sections

Before adding a destination, record:

1. required capability;
2. whether it is artist-scoped, shared or global;
3. expected daily usage frequency;
4. parent section for detail routes;
5. mobile placement: primary or grouped overflow;
6. keyboard and screen-reader behavior;
7. click-path tests for owner, booking manager and read-only roles.

A fifth primary business destination requires a new ADR rather than silently expanding the bottom bar.

## Follow-up work

The accompanying click-path audit tracks the implementation gaps found after the mobile navigation refactor, including mobile item ordering, scope applicability, detail-route context, action placement and overflow-sheet focus management.
