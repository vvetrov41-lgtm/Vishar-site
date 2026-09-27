# CRM information architecture redesign

## Goal

Make the daily path of an artist or studio operator short and predictable:
open the CRM, see what needs attention, act on it in its record, and get back
to where you were. Reduce top-level destinations and long-scroll records
without changing the domain model, permissions, workflow authority or data.

Mobile Calendar month view is out of scope and stays exactly as it is.

## Current IA (September 2026)

16 top-level destinations, grouped by frequency in the sidebar and in the
phone's More sheet:

| Group | Destinations |
|---|---|
| Work | Today, Inbox, Enquiries, Clients, Follow-ups, Projects, Calendar, Statistics |
| Money | Invoices, Payments |
| Setup | Time off, Automations, Integrations (Forms, Calendar, Telegram, WhatsApp, Instagram), Notifications, Users, Activity |

Phone tab bar: Today, Inbox, Calendar, Clients, More.

Observed problems (visual review on iPhone 13, real App on test data):

- Enquiries: the view toggle, labelled search and labelled status filter used
  about half the first screen before the first enquiry.
- Project record: about 4,000 px long; the estimate sat above the sessions
  and deposit/invoices far below them, so money for a project was split.
- Records (enquiry, project, invoice): Back and the artist notice took two
  full-width rows before the record itself.
- Follow-ups, Statistics and Activity are separate top-level destinations,
  although each is a view over work already reachable from Today or a record.
- Setup mixes one-time configuration (Integrations, Users) with a daily list
  (Time off), so "where do I change X" has no single answer.

## Target IA

Three levels, each with one job:

1. **Home (Today)**: what needs attention now. Follow-ups, today's
   appointments and unanswered conversations are sections here, and the
   Follow-ups page remains the full list behind "See all".
2. **Work lists**: Inbox, Enquiries, Clients, Projects, Calendar. Each list
   keeps its filters in the URL (done in #928) and opens records.
3. **Records**: client, enquiry, project, invoice. One header row (Back and
   the record's artist), a jump bar to the record's parts, and the parts in
   the order work happens: sessions, then money, then notes and history.

Money (Payments, Invoices, Statistics' money block) and Settings (Time off,
Automations, Integrations, Notifications, Users, Activity) are hubs reached
from the sidebar and More, not the phone tab bar.

## Required behaviour

- No route is removed; existing links and bookmarks keep working.
- Every information item and action that exists today remains reachable.
- Capability checks, artist scope and RLS are unchanged; no new write path.
- Labels remain available to assistive technology when visually compacted.
- Mobile Calendar month view is not changed.

## Phases

- **Phase 1 (this change)**: compact Enquiries toolbar; record header row;
  project jump bar with sessions → money → notes → activity order.
- **Phase 2**: Today gains Follow-ups and unanswered-conversation sections
  with "See all"; Follow-ups leaves the phone More sheet's first screen.
- **Phase 3**: Money and Settings hub pages; Statistics' money block moves to
  the Money hub; sidebar shows Work lists first, then Money, then Settings.
- **Phase 4**: the jump bar and section order for client and enquiry records.

## Acceptance

- Each phase ships separately with tests and exact-head CI.
- No regression in the existing admin suite.
- A visual pass on a 390 px-wide phone for each changed screen.
