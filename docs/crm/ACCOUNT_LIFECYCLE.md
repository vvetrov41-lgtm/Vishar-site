# The account: what it is called, and how to leave

This describes the state after migration `0135`.

Two problems found by testing a real self-registered artist account in
production, and one of them turned out to be a schema fact rather than a
missing button.

---

## 1. "Booking manager" was the wrong word

A self-service founder owns their solo organization, holds the `artist` seat on
their own artist, and was shown **Booking manager** next to their name.

Nothing was broken. `public.profiles.role` is the *authorization* role, and
migration `0130` gives every self-service founder `booking_manager` on purpose:
`owner` is the legacy installation-wide role, it narrows every membership
through `crm_private.capability_from_grant`, and a public signup form may not
hand it out. The mistake was printing that column.

So the label is now a separate question with a separate answer.
`crm_private.user_facing_role(profile_id)` reads the rows authorization itself
reads - `crm_private.profile_access` and `public.artist_memberships` - and
returns one of:

| Answer | Who | EN | RU |
| --- | --- | --- | --- |
| `operator` | `profiles.role = 'owner'` | Operator | Оператор |
| `artist` | holds an `artist` (or artist-level `owner`) seat | Artist | Мастер |
| `booking_manager` | holds a `manager` seat | Booking manager | Менеджер записей |
| `read_only` | holds only a `read_only` seat | Read only | Только просмотр |
| `none` | inactive or unknown | No access | Нет доступа |

Order matters and every step is a decision:

* **operator first.** Migration `0015`'s owner-sync gives the installation
  owner an `owner` membership on every artist. Reading the seat first would
  describe the person who administers the installation as somebody's tattoo
  artist.
* **then the artist seat**, which is what both `bootstrap_artist_account` and
  `seat_artist_owner` write for a working artist.
* **then the manager seat**, which is what an invitation grants somebody who
  handles bookings for an artist they are not.
* **then the global role**, for an account holding no seat at all.

Nothing consults this function to decide access. It changes no policy, no
grant and no predicate. `public.account_overview()` returns it to the browser,
and if that read fails the interface falls back to the authorization role
rather than guessing something friendlier.

---

## 2. Deleting an account, and why nothing is DROPped

`public.activity_log` is append-only, enforced by a trigger that survives
BYPASSRLS (migration `0005`). Three referential facts follow, and together they
are the wall a previous production acceptance account ran into:

| Constraint | Effect |
| --- | --- |
| `activity_log.actor_profile_id` → `profiles` **ON DELETE SET NULL** | the SET NULL is an UPDATE, which the trigger refuses. A profile that has appeared in the log cannot be deleted. |
| `activity_log.profile_id` → `profiles` **ON DELETE SET NULL** | same. |
| `activity_log.artist_id` → `artists` **ON DELETE RESTRICT** | an artist that has appeared in the log cannot be deleted. |
| `profiles.id` → `auth.users` **ON DELETE CASCADE** | so deleting the Auth row would delete the profile, and hit the first case. |

There are exactly two ways past that: mutate the audit log, or stop trying to
drop the rows it points at. `public.delete_my_account(p_confirmation text)`
takes the second. It **erases and retires**:

| Thing | What happens |
| --- | --- |
| Supabase Auth identity | `deleted_at` set - GoTrue's own marker, and the one `bootstrap_artist_account` already refuses on - plus `banned_until = infinity`, password nulled, every identity, session, refresh token, factor and one-time token deleted, address and metadata scrubbed |
| Email address | rewritten to `deleted-<uid>@deleted.invalid`, so the person can sign up again with the original tomorrow |
| CRM profile | anonymous tombstone: no name, no address, `is_active = false`, `read_only` |
| Artist seats | deleted outright - this is the row every artist-scoped predicate reads |
| Founder's artist and solo organization | deactivated, renamed `Deleted account`, slug rotated, booking reference prefix released |
| Provider connections | `artist_integrations`, `integration_assignments`, `workspace_integrations`, Telegram destinations and link sessions deleted |
| Booking forms | deactivated (`enquiries` holds ON DELETE RESTRICT to the source it arrived through, so a form that ever took an enquiry cannot be dropped; inactive is what stops it taking another) |
| Pending invitations | deleted |
| Automations | `automation_rules` deleted, taking their jobs with them |
| `public.activity_log` | untouched, plus one new `account.self_deleted` row |

### What deliberately stays

* **The artist and workspace rows.** The log references them. They are switched
  off and hold no personal data afterwards.
* **The founder's own `workspace_memberships` row.** Migration `0089`'s
  `protect_last_workspace_owner` refuses to let an organization lose its last
  active owner, on UPDATE and DELETE alike. Removing that guard to satisfy a
  delete button would be the wrong trade: the row denies everything anyway,
  because every capability predicate reads
  `crm_private.profile_access.is_active`, which is false from here on.
* **`crm_private.self_service_accounts`**, the ledger that makes a second
  tenant per account impossible and bounds the founder cap.

### The guards, in the order they run

1. an ordinary signed-in browser session, and only that - a backend key has no
   `auth.uid()` to act for;
2. an active CRM profile;
3. the installation owner is refused by name, for the same reason `0006`
   refuses them deactivating themselves;
4. the confirmation, which is the account's own email address typed out - a
   fixed word would be guessable from the source, an address proves the caller
   is looking at the account they are deleting. It is compared and discarded,
   never logged;
5. a per-account advisory lock, so two taps are one deletion;
6. a founder whose tenant still has anybody else in it is refused, with the
   reason.

Pinned by `supabase/tests/272_account_lifecycle.sql`, including that the
released address can found a fresh tenant afterwards and that the log is still
append-only when it is over.

---

## 3. The interface

* `admin/src/pages/AccountPage.tsx` at `#/account`. User-level settings only -
  name, address, role, language, Danger zone. The studio's name, time zone and
  currency stay with the organization, because two people in one studio share
  those and share none of these.
* `public.set_my_display_name(text)` is the only write on the identity card. It
  touches one column on one row, chosen by `auth.uid()` rather than by an
  argument. `profiles` had no self-update path at all before it -
  `profiles_update_owner` is the installation owner's policy - so an artist who
  typed their name once at signup could never correct it.
* The account popover is a controlled popover rather than a native `<details>`,
  which has no notion of "outside": the panel used to stay open over whatever
  you tapped next. It now dismisses on a pointer outside it, on Escape, and on
  arriving somewhere new, and the person's name is a real `Link` to `#/account`.
* Changing an email address is deliberately not offered. Supabase Auth owns
  that flow, it needs confirmation on both addresses, and inventing a
  half-version of it here would be worse than not having one.
