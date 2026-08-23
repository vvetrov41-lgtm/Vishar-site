# How a new artist joins Vishar CRM

This is the canonical answer to "a third tattoo artist starts on Monday, what
has to happen". It describes the state after migrations `0087`, `0088` and
`0089`.

The short version: an owner or studio admin opens the CRM on their phone and
does it. No commit, no branch, no pull request, no migration written for that
artist, no hand-written SQL, no Worker deploy, no Cloudflare secret, no Telegram
bot, no Custom GPT, no OAuth client, no environment variable.

Section 11 lists what genuinely still requires somebody to click something
outside this CRM, because two of the integrations really do.

---

## 1. Identity

A person signs in with a Supabase Auth account and has a row in
`public.profiles`. That is their platform identity, and it is the only thing
Supabase Auth decides. Everything about what they may *do* is decided by
membership rows in the database.

New people are invited from **Users**, which creates the auth user and the
profile together. Nothing about that step is artist-specific.

**This is the boundary of the operatorless claim.** Everything below — the
organization, the artist, the memberships, the capabilities, the booking form —
is a CRM operation needing no engineer. Minting a *human identity* is a
separate trusted operation, and the invite flow is where it happens. The golden
path in `supabase/tests/236_new_artist_golden_path.sql` says the same thing in
its header and provisions its cast with privileged inserts rather than
pretending otherwise.

The legacy `profiles.role` (`owner` / `booking_manager` / `read_only`) still
exists and still narrows what any membership can mean. It is a transition
artifact, not the control plane — see section 12.

---

## 2. Workspace

An artist belongs to exactly one workspace, which is either:

- **solo** — one artist working alone; or
- **studio** — an organization with several artists.

**CRM → Organizations → New organization** calls `public.create_workspace`. The
founder becomes its owner. A slug is derived from the name; nobody is asked to
invent a URL-safe identifier.

You may found an organization if you already administer one, or if you are the
installation owner. There is no self-signup, so this never has to admit a
stranger.

A solo workspace refuses a second artist. That is not tidiness: migration
0075's `sync_solo_workspace_owner` turns an artist membership on a solo
workspace's artist into ownership of that workspace, which is safe *only*
because a solo workspace has one artist. A second one would make that trigger
into a way to reach somebody else's records.

---

## 3. Adding the artist

**CRM → Organizations → (the studio) → Add artist** calls
`public.create_artist`. It needs `manage_workspace` on that workspace and a
display name. The slug and the booking reference prefix are derived and
de-duplicated; the timezone and currency default to the organization's.

**Creating an artist grants the creator nothing on that artist.** This is the
invariant the whole platform rests on. A studio owner who has just created
Artist Z cannot read Artist Z's clients, enquiries or money, and the roster
says so on the row: *"You cannot open their work."*

What the new artist has at this moment: a name, a timezone, a currency, a
booking prefix, and no way in or out. No integration, no booking source, no
automation rule, nobody who can open them.

---

## 4. Memberships

Two separate things, and conflating them is the mistake this architecture
exists to prevent.

**Workspace membership** (`public.workspace_memberships`) says what somebody may
do at organization level: administer it, manage its people, manage its
integrations. It never, on its own, produces an artist capability.

**Artist membership** (`public.artist_memberships`) is an explicit, auditable,
revocable grant of access to one artist's work.

### Does artist access require workspace membership?

**No, deliberately.** The reverse rule — workspace membership never granting
artist access — is enforced everywhere, so it is reasonable to assume the
symmetry holds. It does not.

Production settles it: an artist runs her own book today through an explicit
artist `manager` membership and belongs to no workspace record at all.
Requiring workspace membership would invalidate a live relationship, and it
would also be wrong in principle — an artist-scoped collaborator who has no say
in running the organization is a legitimate shape.

So `grant_workspace_artist_membership` does not require it, and
`supabase/tests/237_control_plane_governance.sql` pins both halves: the grant
succeeds for somebody outside the organization, and it gives them no workspace
access whatsoever.

### Who owns a workspace

An owner row cannot be edited through team management at all — not demoted, not
deactivated, not adjusted. `upsert_workspace_membership` refuses, and a trigger
on `workspace_memberships` refuses under any other path, so a workspace that
has ever had an active owner keeps one.

Ownership moves through `public.transfer_workspace_ownership`, which only a
sitting owner may call, only onto somebody already in the organization. It
promotes before it demotes so the invariant is never momentarily violated, and
leaves the outgoing owner as an admin rather than removing their access.

### Seating the artist on their own book

The first grant is special, and it needs explaining because the reason is not
obvious.

`public.grant_workspace_artist_membership` refuses to hand out finance or
integration management that the caller does not already hold *on that exact
artist*. That rule is what stops a studio admin from staffing their way into an
artist's money. But on an artist created a minute ago, nobody holds those
rights — so nobody could ever grant them.

`public.seat_artist_owner` is the one bootstrap that breaks the deadlock. It
gives one person full access to one artist, and it **refuses the moment that
artist has any membership row at all, in any state**. So it can only ever run on
an artist that has never been reachable by any CRM user, and therefore holds no
records to disclose. The CRM offers it only while that is genuinely true.

It deliberately does *not* check `is_active`. Checking active-ness would reopen
the door for an artist whose membership was deactivated — somebody who left a
studio — and let an admin seat themselves on a real book.

The seat also refuses a target whose CRM role could not use it. A `read_only`
profile holds no write capability whatever their artist membership says, so
seating one would spend the one-shot and leave an artist whose owner cannot
edit an enquiry, move an appointment, take a payment or publish a form. The
check runs *before* the row is written, so an ineligible choice leaves the
bootstrap unspent and the mistake recoverable.

### Staffing

Everything after that is `grant_workspace_artist_membership`, from
**Access to this artist** on the artist's page. Either the artist's own
`manage_team`, or the workspace's `manage_team`, is enough to call it. Neither
can hand out finance or integrations they do not hold themselves.

### Finding people to staff

`public.list_directory_profiles` returns the active CRM people a caller may
add, readable by a workspace team manager, an artist-level member, or the
installation owner. It exists because `public.list_profiles` requires the
legacy global owner role — so the first version of these screens rendered an
empty dropdown for exactly the studio administrator they were written for.

It returns identity only. It never discloses which other organizations a person
belongs to.

---

## 5. Capabilities

The database accepts exactly five things per membership: an access level
(`artist` / `manager` / `read_only`) and four booleans (view finance, manage
finance, manage sessions, manage integrations).

Everything else — `manage_enquiries`, `view_communications`,
`manage_booking_sources` and the rest of `public.capability_registry` — is
**derived** from those five by `crm_private.capability_from_grant`, together
with the profile's legacy global role.

That function is the single derivation. `crm_private.has_artist_capability`
delegates to it, and so does `public.preview_membership_capabilities`, which is
what the capability editor reads. The interface therefore cannot offer a
capability the database would refuse: it edits the grant and reports the
consequences the server calculates.

The case that proves it: give a `read_only` profile every box ticked, and every
write capability still comes back withheld, because the global role narrows what
any membership can mean.

---

## 6. Booking

A new artist takes enquiries through a hosted booking form created from
**Integrations → Forms and websites**. It produces a public URL immediately.
No Worker is deployed, no route is added, no secret is created.

The public path resolves the artist **server-side from the form id alone**. A
browser never sends an authoritative `artist_id`, and could not: the resolvers
in migration 0079 take a `public_source_id` and derive everything else.

An external website source is also available, keyed to that site's exact HTTPS
`Origin`.

New sources are created switched off, deliberately.

---

## 7. Integrations

Each provider connects from **Integrations**, per artist, and the artist's own
integration-management right is what allows it. The onboarding checklist reports
one of: not configured, ready to connect, connected, needs attention, external
approval required, disabled.

No provider credential ever reaches the browser. `list_integration_status`
returns safe status only — no token, no chat id, no account key.

Adding an artist creates **no** integration. Nothing sensitive is on by default.

---

## 8. Notifications

Internal notifications are addressed to a profile and scoped to an artist.
`public.list_notifications` re-derives artist scope on every read (migration
0085), so revoking a membership removes the notifications already sitting in
that person's inbox.

Telegram delivery uses the existing shared-bot self-service design
(`docs/crm/TELEGRAM_SELF_SERVICE.md`): a person links their own destination
through a deep link. Adding an artist creates no bot, no Worker secret and no
deployment.

Marketing and service traffic remain different classes. The consent gate from
migration 0082 is in front of a brand-new client from the first enquiry:
service messages are allowed, marketing is refused until consent is recorded.

---

## 9. Automations

If the organization has automation defaults, the artist's page offers **Apply
studio defaults**. They materialize as ordinary rules the artist owns, and any
later override stays artist-scoped.

Applying requires workspace `manage_integrations` **and** artist
`manage_automations`, so a studio admin cannot push rules onto an artist they
hold no membership on.

Authoring a workspace default is still a closed surface —
`upsert_workspace_automation_default` is granted to no API role. That is the
Automation Product, a separate workstream. Migration 0088 opened only the two
calls onboarding needs: list and apply.

---

## 10. GPT and MCP

Nothing to do. There is one shared GPT and one OAuth client for the whole
installation.

`public.gpt_artist_context` resolves which artists a human holds through the
same `artist_memberships` rows the CRM uses. A new artist appears to the person
who holds them the moment the membership exists, and to nobody else. Revoking
the membership closes the GPT in the same instant, because it asked the same
question.

MCP is transport over that same authorization. Neither surface gets a service
role, arbitrary SQL, or a generic RPC.

---

## 11. What still requires something outside the CRM

Honest list. These are provider decisions, not gaps in this design.

| Thing | Why it cannot be a CRM click |
| --- | --- |
| Google Calendar, Gmail | An OAuth consent screen the person must complete on Google |
| Monzo | Strong Customer Authentication approval in the Monzo app |
| WhatsApp | Meta Business verification and a template approval |
| Instagram | Meta app review; this workstream is frozen |
| A custom domain for booking forms | A Cloudflare route, an owner decision |

The checklist marks these `external` rather than `required`, so nobody goes
looking for a button that does not exist.

Everything else — the artist, the organization, the memberships, the
capabilities, the booking form, the notifications, the automation defaults, the
GPT — is a CRM operation.

---

## 12. Offboarding

**Deactivate a membership** (Access to this artist → uncheck Active) removes
that person's access immediately. The private mirror follows the membership row
in the same transaction: the CRM, the booking-source list, the notification
inbox and the GPT all close at once. Nothing is destroyed; restoring the
membership restores it.

**Deactivate the artist** (Artist settings → Deactivate) closes everything for
everybody. Public intake refuses, because both resolvers in migration 0079 join
the artist-state mirror, and every capability check refuses, because
`has_artist_capability` requires the artist to be active.

Deactivation deliberately does **not** cascade over booking sources. The row is
left as its owner set it, so reactivation restores exactly the state they chose
rather than silently republishing a form somebody had switched off. Cascading
would also mean widening an artist-scoped write policy to a workspace role,
which is the inheritance this platform refuses.

There is no delete, for an artist or an organization. An artist that has held
work is deactivated so the audit trail and operational history stay attached to
something that still exists.

---

## 13. What is still a transition artifact

`profiles.role` — the installation-wide `owner` / `booking_manager` /
`read_only` — is still consulted by `capability_from_grant` and still narrows
every membership. It has not been removed because production runs on it.

It is no longer the product control plane. Organizations, artists, memberships
and capabilities are administered through the screens above, none of which
depends on somebody being the global owner — and since `0089`, none of which
*reads* the legacy role either: control-plane visibility comes from
`public.control_plane_access()`, and the people picker from
`public.list_directory_profiles()`.

Where the legacy role still bites is inside `capability_from_grant`, which is
why the artist seat checks eligibility rather than pretending the role does not
matter. Removing it from the derivation is the workstream that retires the
global role, not this one. Every test in
`supabase/tests/235_control_plane.sql` and
`supabase/tests/236_new_artist_golden_path.sql` runs with **no installation
owner in the cast**, which is what makes that claim checkable rather than
aspirational.

Retiring the global role is a separate, later workstream.

---

## 14. Evidence

- `supabase/migrations/0087_artist_workspace_lifecycle.sql` — lifecycle RPCs,
  the shared capability derivation, the bootstrap seat, RLS.
- `supabase/migrations/0088_control_plane_reads.sql` — roster, team, membership
  list, capability preview, onboarding state, automation-defaults grants.
- `supabase/tests/235_control_plane.sql` — isolation, self-elevation refusal,
  solo/studio, revocation, the bootstrap shutting behind itself, direct-table
  ACL denial.
- `supabase/tests/236_new_artist_golden_path.sql` — the whole journey above for
  a synthetic third artist, with nothing writing `artists`, `workspaces` or
  `artist_memberships` directly, and a final act that greps the routing path for
  artist-specific branches.
- `admin/src/test/control-plane.test.tsx` — the screens.
