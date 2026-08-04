# ADR 0002: Appointment types with a compatible sessions table

- **Status:** Accepted for the appointment-types draft implementation
- **Date:** 2026-08-04
- **Decision owners:** CRM product and engineering
- **Applies to:** Supabase CRM schema, workflow RPCs and `admin/`

## Context

The CRM currently models every scheduled item as a project-owned tattoo session. The product now needs four operational types:

- tattoo session;
- in-person consultation;
- video consultation;
- touch-up.

A consultation can happen before an enquiry is converted to a project. Therefore `project_id` cannot remain mandatory for every scheduled record. At the same time, PR #177 already has tested RLS, activity, payment and future-calendar links to `public.sessions`, so replacing or renaming the table would create avoidable migration and stacked-PR risk.

Artist scope remains authoritative in the database. The browser may select a type and related record, but it may not choose a different artist than the linked enquiry/project/client permits.

## Decision

### 1. Keep `public.sessions` as the storage table

The physical table name remains `sessions` for backwards compatibility. It becomes the appointment storage table by adding an `appointment_type` enum and optional relationship columns.

Existing rows are backfilled as `tattoo_session`. Existing public RPC signatures remain available as compatibility wrappers.

The CRM labels the user-facing section **Appointments / Записи**. The old `/sessions` route remains a compatibility alias while `/appointments` becomes the canonical route.

### 2. Use four closed appointment types

`public.appointment_type` contains:

- `tattoo_session`;
- `in_person_consultation`;
- `video_consultation`;
- `touch_up`.

Adding another type requires a forward migration and explicit UI/RPC support. Free-text types are rejected.

### 3. Store authoritative relationship links on every row

Each appointment has:

- `artist_id` — mandatory and authoritative;
- `client_id` — mandatory;
- `enquiry_id` — optional;
- `project_id` — optional.

Link rules:

- tattoo sessions and touch-ups require a project;
- consultations may exist without a project;
- a consultation may be linked to an enquiry, a project, or both;
- when a project is supplied, its client and artist must match the appointment;
- when an enquiry is supplied, its client and artist must match the appointment;
- when both enquiry and project are supplied, they must describe a consistent workflow chain.

A trigger validates these rules for inserts and relationship updates. RLS remains artist-scoped.

### 4. Add one authoritative appointment RPC

`public.schedule_appointment(...)` accepts the type and relationship identifiers, validates access and inserts through the database boundary.

The caller cannot override artist ownership through a mismatched link. The RPC requires `manage_sessions` capability for the resolved artist.

`public.schedule_session(...)` remains available and delegates to `schedule_appointment` with `tattoo_session` for existing clients and tests.

### 5. Keep one lifecycle and one conflict domain

All four types use the existing `session_status` lifecycle. Active overlap warnings inspect every `proposed` or `confirmed` appointment for the same artist, regardless of type.

Conflict detection remains advisory: overlapping work is highlighted but can be intentionally scheduled. Authorization and relationship consistency are mandatory; avoiding overlap is a product decision.

Cancelled appointments do not participate in active conflicts.

### 6. Do not activate external providers

This foundation does not connect Google Calendar, video calls, email or payment providers.

- in-person consultations do not require a stored studio address yet;
- video consultations do not create a meeting URL yet;
- touch-ups continue to use the existing optional finance fields;
- calendar provider remains `none` until a separate integration stage.

### 7. Use type-aware but conservative UI defaults

The planner shows type-specific duration shortcuts while keeping explicit start/end controls authoritative:

- tattoo session: 3, 5 and 7 hours;
- in-person consultation: 30, 45 and 60 minutes;
- video consultation: 20, 30 and 45 minutes;
- touch-up: 1, 2 and 3 hours.

These are convenience defaults, not database policy. A later settings stage may make them artist-configurable.

## Consequences

### Positive

- Consultations can be scheduled before project conversion.
- Existing session IDs, activity links, payment links and future calendar references remain valid.
- The stacked PR adds one forward migration instead of rewriting migrations 0001–0025.
- Conflict checks naturally cover all appointment types.
- Existing API clients continue to work through the compatibility RPC.

### Trade-offs

- The database table keeps the historical name `sessions` while the product calls the section Appointments.
- Some old code and tests retain session terminology until a later cleanup.
- Type-specific location, meeting-link and touch-up policy fields are deferred.

## Rejected alternatives

### Create a separate `appointments` table and migrate sessions

Rejected because it would require moving foreign keys from activity, payments, project files and outbox-related workflows, increasing the risk to the tested PR #177 foundation.

### Keep consultations outside the schedule

Rejected because consultations occupy artist time and must participate in the same conflict warning and operational queue.

### Require a project for every appointment

Rejected because consultations commonly happen before project conversion.

### Let the browser submit an unrestricted artist ID

Rejected because UI state is not an authorization boundary. Artist ownership must agree with trusted linked records and database access checks.

## Follow-up work

Separate later stages may add:

- artist-configurable duration defaults;
- studio/location records;
- video meeting provider and meeting URLs;
- Google Calendar projection;
- consultation reminders;
- touch-up charging policy;
- public self-booking rules.
