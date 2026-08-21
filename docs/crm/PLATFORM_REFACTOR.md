# Vishar CRM platform refactor — architecture audit and staged plan

Status: **Phases A–D and K/L/M complete.** Migrations `0074`–`0077` and pgTAP
files `222`–`225` are on `claude/vishar-platform-refactor-f6cno8`. The full
history (77 migrations) replays cleanly and all 63 pgTAP files pass.
**Nothing here is deployed**, and the frozen Instagram rollout is untouched.

This document is the design anchor for moving Vishar CRM from a system that
serves two named artists to a platform where adding an artist, a manager or a
studio is a data operation inside the CRM rather than a code change, a Worker
deploy, a Cloudflare secret and a hand-written SQL statement.

It records the audit that the plan rests on, so a later reader can tell which
statements were verified and which are intent.

---

## 0. Evidence and exact refs

Everything below was resolved fresh on **2026-08-21**, not carried over from an
earlier session.

| Fact | Value | How it was established |
| --- | --- | --- |
| Base for this work | `release/private-crm-rc76-instagram-communications` @ `431b91a9c1135e84e1d8726658e5cc7769d0f4ab` | `git ls-remote`, `git rev-parse` |
| Production Supabase project | `vfjexhfdbrjmuxfdvbdx` (`vishar-crm-production`, eu-west-2) | Supabase project list |
| **Production migration head** | **`0073_instagram_operator_authorization`** | `supabase_migrations.schema_migrations` on production |
| First migration this work may claim | **`0074`** | forward-only rule; production is already at 0073 |
| Production Workers | 20, including `vishar-instagram-production` (modified `2026-08-21T07:15:34Z`) | Cloudflare account `787a19ac…` Worker list |
| Artists in production | `vladimir`, `kristina` — both active | `public.artists` |
| Profiles in production | 2 | `public.profiles` |
| Artist memberships | 3 | `public.artist_memberships` |
| Booking sources | 2 (`vladimir-website` **inactive**, `kristina-website` active) | `public.booking_sources` |
| Artist integrations | 13 rows across 7 integration types | `public.artist_integrations` |

### The Instagram workstream is frozen, not in flight

PR **#379** (`claude/instagram-communications-integration-po9a1e`) was **closed
unmerged by the product owner on 2026-08-21T19:07Z** with an explicit freeze:

> preserve this branch and full history for later continuation; do not merge or
> mark Ready; do not enable Instagram or WhatsApp outbound drain; do not change
> the current production Supabase, Cloudflare Workers, Pages, KV, bindings, or
> Meta configuration as part of this closure; production-deployed release
> lineage remains the operational baseline and is not rolled back.

Two consequences that shape this workstream:

1. **Migrations `0068`–`0073` are production.** They were applied to the
   production database and are part of the operational baseline, even though
   the PR that introduced them is closed. Any new migration must therefore be
   `0074`+ and must apply cleanly on top of `0073`. The RC76 lineage is the
   only ref that carries `0068`–`0073`, which is why it — and not `main` — is
   the base for this branch.
2. **Nothing here touches Instagram, WhatsApp, Meta, or any drain enablement.**
   No provider runtime is modified. The platform foundation is designed so that
   Instagram can be re-attached to it unchanged once Meta approval lands.

---

## 1. What actually blocks a new artist today

This section is the audit result, not a restatement of the brief. Each item was
read at the exact ref or on the production database.

### 1.1 Global `profiles.role` is load-bearing for artist-scoped authorization

`crm_private.has_artist_capability(p_artist_id, p_capability)` — the single
predicate behind `public.can_access_artist`, `can_manage_artist`,
`can_manage_artist_finance`, `can_manage_artist_integrations`,
`can_manage_artist_sessions`, `can_view_artist_finance` and every artist-scoped
RLS policy — resolves a capability from **both** the global role and the
membership:

```sql
when 'manage' then
  p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
when 'manage_integrations' then
  p.role = 'owner' or (p.role = 'booking_manager' and a.can_manage_integrations)
```

`public.crm_role` has exactly three values: `owner`, `booking_manager`,
`read_only`. So a new artist who must fully control their own scope has to be
given one of two global roles, and both are wrong:

### 1.2 Global `owner` silently grants every artist

Two production objects make `owner` a platform-wide grant:

- `crm_private.ensure_owner_artist_memberships(p_profile_id)` inserts an
  `owner` membership with all four capability flags true **for every row in
  `crm_private.artist_state`**, and is fired from a trigger on `public.profiles`.
- `crm_private.grant_artist_to_active_owners()` is a trigger on
  `public.artists` that grants the new artist to **every active owner profile**.

So today: promoting a new artist to `owner` hands them Vladimir's and
Kristina's clients, enquiries, finance and integrations; and creating artist X
hands artist X to every existing owner. This is the single most important thing
the refactor has to fix, and it cannot be fixed by adding tables — it needs the
`owner` role to stop meaning "owner of the installation".

### 1.3 `booking_manager` cannot express a self-service artist

`booking_manager` + all four membership flags is close to a workable
self-service artist, but it is missing the two capabilities the golden path
needs: there is no capability for **inviting a manager** (`manage_team`) and no
concept of a workspace at all. Team management today is gated on the global
role — `public.set_profile_role` and the invite path in
`0037_team_access_management.sql` are owner-only.

### 1.4 There is no workspace / organization layer

No `workspaces` table, no workspace membership, no `workspace_id` anywhere.
`public.artists` is the only tenancy boundary, and it is a person, not an
organization. A studio with three artists and one shared reception inbox has
nowhere to live.

### 1.5 Integrations are artist-owned only, with no assignment concept

```
public.artist_integrations(artist_id, integration_type, provider,
                           integration_key, external_account_label,
                           configuration jsonb, is_enabled)
```

There is no `owner_type`, so a studio cannot own an integration, and there is no
assignment table, so a shared account cannot be granted to a chosen subset of
artists. There is also no status surface: no `last_success_at`,
`last_error_at`, or safe error category, which is what an Integrations
dashboard needs to render "Needs attention" without exposing provider detail.

The table's contract is otherwise exactly right and must be preserved: it is
documented as *"Artist-scoped provider metadata only. Tokens, chat ids, OAuth
credentials, payment secrets and private keys are prohibited"*, and
`crm_private.guard_artist_integration_configuration` enforces it.

### 1.6 Telegram requires a Cloudflare secret per artist

`workers/lib/provider-routing.js:bindingNameFor` turns an integration key into
a Worker binding name deterministically:

```js
const escaped = [...key].map(c => c === '_' ? '__' : c === '-' ? '_H' : c.toUpperCase()).join('');
return `ARTIST_${type.toUpperCase()}_${escaped}`;
```

`vladimir-production` → `ARTIST_TELEGRAM_VLADIMIR_HPRODUCTION`, and
`wrangler.telegram-drain.production.toml` names exactly those two secrets. Each
secret is a JSON object holding `{botToken, chatId}`.

So a third artist needs: a new encrypted Worker secret, a hand-collected
numeric chat id, and a redeploy of a live production Worker. That is precisely
the operator work the platform has to remove. Note also that the bot token is
stored **per artist**, which a single shared Vishar bot makes redundant.

### 1.7 Booking sources are static and artist-only

```
public.booking_sources(artist_id, source_key, allowed_origin, form_version, is_active)
```

`workers/lib/provider-routing.js:readTrustedBookingConfig` reads
`env.BOOKING_SOURCE_KEY` and `env.BOOKING_FORM_VERSION` from **Worker vars**.
A new website therefore needs a Worker deploy. There is no public opaque source
identifier, no form type, no hosted-form concept and no workspace ownership.

The security property underneath is correct and must survive untouched: the
browser never supplies `artist_id`; the server resolves artist from
(source key + exact `Origin` + active source). The refactor keeps that
resolution and only moves the *source key* from a Worker variable to a
runtime-resolved registry row.

### 1.8 Follow-ups are stored but never delivered

`public.follow_ups(artist_id, assigned_to, due_at, status, subject, details,
client_id, enquiry_id, project_id, …)` exists and is populated (1 row in
production). There is **no notifications table, no scheduler, no due-date
sweep, and no outbox kind for an internal notification** — `public.outbox_kind`
contains only provider delivery kinds. A follow-up that comes due today
produces nothing at all.

### 1.9 The outbox cannot represent workspace-owned or user-directed work

`public.integration_outbox.artist_id` is `NOT NULL`, and
`public.resolve_outbox_route` joins strictly
`artist_integrations ON artist_id = outbox.artist_id`. A workspace-owned
Telegram destination, or a private reminder addressed to a person rather than
an artist, has no representation.

### 1.10 Integrations are three separate navigation entries

`admin/src/lib/permissions.ts:NAV_ITEMS` carries `/integrations` (labelled
Calendar), `/integrations/whatsapp` and `/integrations/instagram` as three
peers. This does not scale past the channels that already exist.

### 1.11 GPT is bound to an artist by OAuth client

`crm_private.gpt_action_clients` is *"Private allow-list binding one Supabase
OAuth client_id to one artist-scoped GPT action surface"*, and production holds
one row per artist (`vladimir-gpt-actions`, `kristina-gpt-actions`). Every new
artist therefore needs a new GPT and a new OAuth client. The unified GPT
(Phase S) replaces the binding target: client → **profile**, then profile →
memberships → active artist.

### 1.12 One advisory that is a false positive

Supabase's advisor reports RLS disabled on ten `crm_private` tables. Checked
directly: `anon` has no `USAGE` on `crm_private`, and every one of those tables
grants `SELECT`/`INSERT` to neither `anon` nor `authenticated`
(`has_table_privilege` = false across the board). The schema is closed by
privilege rather than by policy, which is the intended design. No action.

---

## 2. Target model

Thirteen concepts, deliberately kept distinct:

```
Profile          who a person is                     (platform identity)
Workspace        an organization                     (solo | studio)
Artist           an operational data scope           (unchanged)
Workspace member what a person may do in the org
Artist member    what a person may do for an artist  (authoritative)
Integration      a provider connection, owned by artist OR workspace
Assignment       which artists may use a workspace integration, for what
Booking source   a runtime-resolved public intake point
Notification     CRM → a person
Follow-up / task work assigned to a person, due at a time
Automation       trigger → conditions → delay → action
Communication    CRM ↔ a client                      (already exists, 0069)
Campaign         many clients, consent-gated         (foundation only)
```

The authorization rule for the whole platform, in one line:

> **Artist membership is the authority for artist-scoped work. Workspace
> membership is the authority for organization-scoped work. Neither implies
> the other, and the browser is authority for nothing.**

Everything — CRM UI, MCP, unified GPT — reaches the database through the same
capability layer. There is no second permission system.

---

## 3. Capability registry (Phase B, migration `0074`)

The registry is introduced as a **table**, `public.capability_registry`, so
that the CRM, MCP and GPT can enumerate it rather than each hard-coding a list,
and so a later migration adds a capability by inserting a row.

Canonical logical capabilities, each resolved per (profile, artist):

| Domain | Capabilities |
| --- | --- |
| Clients | `view_clients`, `manage_clients` |
| Enquiries | `view_enquiries`, `manage_enquiries`, `assign_enquiries` |
| Projects | `view_projects`, `manage_projects` |
| Sessions | `view_sessions`, `manage_sessions` |
| Finance | `view_finance`, `manage_finance` |
| Communications | `view_communications`, `send_communications`, `manage_communications` |
| Integrations | `view_integrations`, `manage_integrations` |
| Booking sources | `view_booking_sources`, `manage_booking_sources` |
| Notifications | `view_notifications`, `manage_notifications` |
| Automations | `view_automations`, `manage_automations` |
| Team | `manage_team` |
| Workspace | `manage_workspace` |

**How this lands without breaking production.** The six legacy capability
strings (`view`, `manage`, `view_finance`, `manage_finance`,
`manage_sessions`, `manage_integrations`) are used by live RLS policies and
RPCs. `crm_private.has_artist_capability` therefore keeps accepting them
verbatim and keeps returning exactly what it returns today; the new names are
added alongside and mapped onto the same membership facts. The function grows a
new branch, it does not change an existing one. `0074` ships a pgTAP file that
pins the legacy answers for every (role × access_level × flag) combination
before and after.

The registry also fixes §1.2 without a destructive change: a new column
`public.artist_memberships.grant_source` distinguishes a membership that a
human deliberately created from one the `owner` triggers synthesised, and
`crm_private.ensure_owner_artist_memberships` is narrowed to
**workspace-scoped** owners once workspaces exist (Phase C). Until then it is
left running so that current production behaviour is bit-identical.

---

## 4. Workspaces (Phase C, migration `0075`)

```
public.workspaces(id, slug, display_name, workspace_type, timezone,
                  default_currency, is_active, …)
public.workspace_memberships(profile_id, workspace_id, workspace_role,
                             can_manage_workspace, can_manage_team,
                             can_manage_integrations, is_active, …)
public.artists.workspace_id  -- backfilled, then NOT NULL
```

`workspace_type` is `solo | studio`. The backfill creates one **solo**
workspace per existing artist, so Vladimir and Kristina each own their own
workspace and nothing about their access changes.

The rule that keeps studios honest:

> A workspace membership never, on its own, produces an artist capability.

A workspace admin may *grant themselves* an artist membership if their
workspace membership carries `can_manage_team`, and that grant is an ordinary
`artist_memberships` row, auditable and revocable. "All artists" in the studio
manager UI expands, at write time, into one explicit row per artist. Finance
and integrations are never included implicitly — they are separate flags on
each row.

---

## 5. Integration ownership and assignment (Phase D, migration `0076`)

`public.artist_integrations` is preserved exactly as it is — every existing
row, RPC signature, RLS policy, guard trigger and Worker caller keeps working.
Ownership generalises in a **new** table rather than by widening the old one:

```
public.workspace_integrations(id, workspace_id, integration_type, provider,
                              integration_key, external_account_label,
                              configuration jsonb, is_enabled, …)

public.integration_assignments(id, workspace_integration_id, artist_id,
                               purpose, is_active, …)

public.artist_integration_routes(artist_id, integration_type, route_kind,
                                 artist_integration_id | workspace_integration_id)
```

`route_kind` is `artist | workspace`, which is the explicit "personal vs studio"
selection from the brief — no implicit precedence rule in either direction.

A cross-workspace assignment is impossible by construction: a check constraint
plus a trigger require `artist.workspace_id = workspace_integration.workspace_id`.

Status metadata (`last_success_at`, `last_error_at`, `last_error_category`,
`connected_at`) is added to both integration tables so the unified dashboard has
something to render. `last_error_category` is a constrained enum-like text, not
a provider message, so no provider detail leaks into a browser-readable column.

The safe read contract for the dashboard is one function,
`public.list_integration_status()`, returning provider-neutral rows with no
secret, no chat id, no token, no raw provider identifier and — deliberately —
no `configuration` column at all. The three new tables grant `SELECT` to
`service_role` only; a browser session reads through the function or not at
all, which is also why `224` seeds workspace integrations with known ids
rather than looking them up.

Two rules the tests pin, because a shared provider account is where artist
isolation usually breaks:

- **An assignment is a row somebody wrote.** Connecting a studio account
  assigns it to nobody. Choosing a studio route requires an active assignment,
  not merely workspace power, and withdrawing the assignment deletes the route
  rather than leaving it dangling.
- **A workspace boundary holds at the table, not only at the RPC.** A direct
  insert naming a Workspace A integration and a Workspace B artist is refused
  by trigger.

`public.assign_workspace_integration` requires *both* rights, and they are
different: `manage_integrations` on the workspace (owning the account is not
permission to point somebody else's work at it) and `manage_integrations` on
the artist (being able to manage an artist is not permission to spend the
studio's account).

---

## 6. Remaining phases

These are designed but **not** implemented in this change. Each is a separate
bounded release.

| Phase | Scope | First migration | Notes |
| --- | --- | --- | --- |
| E | Unified `/integrations` screen; collapse the three nav entries | none | UI only; reads `public.list_integration_status()` |
| — | Notification Center UI | none | UI only; reads `public.list_notifications()` |
| F | `crm_private.telegram_destinations` + single-use linking sessions | `0077` | chat ids server-only, never in `public` |
| G | Telegram delivery migration | none | resolver added behind a fallback; static bindings removed only after proof |
| H | Booking source registry: public opaque id, origin check at runtime | `0078` | replaces `env.BOOKING_SOURCE_KEY` |
| I–J | Hosted forms and external websites | `0079` | template/schema based, no form builder |
| K–M | **Done** — `public.notifications`, the follow-up sweep, personal destinations and preferences | `0077` | see §6.1 |
| N | Domain events + automation engine | `0078` | one engine, not a cron per scenario |
| O–P | Templates, client reminders, workspace defaults | `0079`–`0080` | service vs marketing split enforced here |
| Q–R | MCP domain contracts and surface | none | transport over the same capability layer |
| S–T | Unified GPT: OAuth client → profile, not artist | `0081` | `gpt_action_clients` gains a profile-bound mode |
| U | Full golden-path validation | none | §77–§82 of the brief |

### 6.1 What `0077` actually fixed

`public.follow_ups` has existed since migration `0005`, carries `due_at` and
`assigned_to`, and is written by both the CRM and the production GPT. Nothing
had ever read `due_at`. A follow-up that came due produced no notification, no
message and no record — somebody had to open the right screen and notice.

`0077` adds `public.notifications` (addressed to one profile, unique
`dedupe_key`), `public.notification_preferences`, the server-only
`crm_private.profile_notification_targets`, and
`public.service_sweep_due_follow_ups()`.

Four properties are pinned by pgTAP `225`:

- **Idempotent.** A second sweep over the same due follow-ups produces nothing.
  The unique `dedupe_key` is the arbiter, so two schedulers running
  concurrently cannot both win.
- **Snooze reschedules, it does not fork.** `snooze_follow_up` moves `due_at`;
  a trigger bumps `schedule_version`; the dedupe key changes, so the next
  notification is legitimate rather than a duplicate. No second task is
  created, and the first notification stays as the record of the first attempt.
- **Recipients are re-derived at due time, not trusted from write time.** The
  assignee gets it if they can still reach the work. If they cannot — a
  membership revoked in between — it falls back to the people who actually run
  that artist, not to "all managers".
- **A notification is addressed to a person, not to a scope.** The RLS policy
  is `recipient_profile_id = auth.uid()`. An artist cannot read their manager's
  private reminder merely because it arose inside their artist scope, which is
  the same property that will stop it being delivered into a shared group chat.

Delivery to a person's own Telegram or email is deliberately still absent:
that needs the private destination store and the linking flow from Phase F.
`set_notification_preference` refuses to enable a channel with no destination,
so a preference can never be on while silently delivering nothing.

### Telegram migration order (Phase F/G), stated once

1. Add `crm_private.telegram_destinations`; write nothing.
2. Backfill the two production destinations from the existing Worker secrets.
   This is the one step that needs a human, because the chat ids exist only
   inside encrypted Cloudflare secrets.
3. Verify the backfilled rows resolve to the same destination the binding does.
4. Add a backend-only resolver RPC; the Worker prefers it and **falls back** to
   the existing binding when it returns nothing.
5. Controlled end-to-end test per artist.
6. Resolver becomes canonical.
7. Remove the static per-artist secrets only after 6 is proven.

At no point may a resolution failure fall through to a different artist. The
resolver raises rather than returning a default, and the Worker treats a raise
as a delivery failure, not as a reason to try another destination.

---

## 7. Rollback

| Area | Rollback |
| --- | --- |
| `0074` | Registry table and new capability names are additive; legacy strings unchanged. Dropping the new rows restores today's behaviour exactly. |
| `0075` | `artists.workspace_id` is nullable until backfill is verified. Workspace memberships grant nothing on their own, so disabling the tables removes no existing access. |
| `0076` | New tables only, plus four additive status columns on `artist_integrations`. Nothing reads the route table yet, so `resolve_outbox_route` behaves exactly as it does today. |
| Telegram | Static bindings stay in place through Phase G; the resolver is a preference, not a replacement, until step 7. |
| Forms | Per-source `is_active = false` disables one source without touching others. |
| Notifications | Delivery can be disabled without deleting follow-ups or notifications. |
| Automations | Kill switch at global, workspace and artist level; disabling never deletes history. |

---

## 8. What this change does not do

Deliberately out of scope, per §87 of the brief: drag-and-drop form builder,
visual automation editor, campaign builder, marketing analytics, billing,
studio analytics, and any autonomous AI receptionist. The goal is correct
foundations plus the minimum usable surface.
