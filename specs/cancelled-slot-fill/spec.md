# Fill a cancelled slot

Status: stage 1 of 3 (database read). Migration `20261116100000_cancelled_slot_candidates.sql`.

## Problem
When a client cancels, the freed time is usually lost: in the moment nobody
remembers which clients paid a deposit and still have no date, are due a
touch-up, or are waiting for a consultation. Production, 2026-11-16: 10
cancellations in 90 days (7 consultations of 30 minutes, 3 tattoo sessions of
6-7 hours); 2 projects with a paid deposit and no future session.

## Behaviour
For a cancelled appointment, the artist sees up to five clients who could take
the time, each with a reason, how the slot length fits, a contact and an
English draft message. The artist sends it themselves. Nothing is sent,
queued, booked or written by the CRM.

Slot state: `open` (cancelled, start still ahead, no other draft/proposed/
confirmed appointment of the artist overlapping), `past`, `taken`,
`not_cancelled`. Only `open` has candidates.

Candidates, in priority order (one row per client, best reason wins):

| # | Reason | Slot | Rule |
|---|---|---|---|
| 1 | `deposit_paid_no_date` | tattoo/touch-up | project draft/active/on_hold with deposit `paid`, or enquiry `deposit_paid` without a project |
| 2 | `open_follow_up` | any | open follow-up due before slot start + 14 days |
| 3 | `touch_up_due` | tattoo/touch-up | last completed tattoo session 4-16 weeks before the slot, no touch-up after it |
| 4 | `project_no_date` | tattoo/touch-up | active project, deposit `not_required`/`requested`, touched in the last 180 days |
| 5 | `enquiry_awaiting_consultation` | consultation | enquiry `new`/`reviewing`/`accepted`/`quote_sent`, created in the last 60 days, no consultation ever booked |

Within a priority: slot length `fits` first, then `unknown`, then `longer`;
then the longest wait. Needed hours: project estimate / estimated sessions,
else the last tattoo session length; touch-up 1 h; consultation 0.5 h.

Left out: the slot's own client, archived clients, clients with any future
draft/proposed/confirmed appointment of the artist, clients with an active
suppression for `unsubscribed`, `complained`, `blocked` or `manual`.

## Access
`public.list_cancelled_slot_candidates(session_id)`: security definer,
`authenticated` only, requires `view_sessions` and `view_clients` on the
appointment's artist. The builder `crm_private.slot_fill_candidates` and the
draft renderer are not callable by any API role.

## Stages
1. Database read + pgTAP (`supabase/tests/394_cancelled_slot_candidates.sql`).
2. CRM: panel on a cancelled appointment with candidates, copy draft and a
   WhatsApp link (`wa.me`) that opens the artist's own WhatsApp.
3. ChatGPT plugin: read-only tool returning the same list.

## Not in scope
Automatic sending, holding the slot, waitlists, Google Calendar busy time
outside the CRM, Today/pulse cards, weekly digests (owned by another task).
