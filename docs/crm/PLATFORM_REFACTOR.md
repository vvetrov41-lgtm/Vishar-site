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

**Roadmap extension, 2026-08-30.** Phases V–W below add Web Research as a
first-class Vishar capability: a Firecrawl-backed research gateway for the
unified GPT, followed by persistent Research inside the CRM. This extension was
planned from `agent/platform-telegram-self-service` at exact SHA
`7f652cc9fbb6cf0ec6a477332117047948a49bad`. It records intent only and does
not assert that Firecrawl, a unified production GPT, new database objects or new
Cloudflare bindings are deployed. Before implementation, re-resolve the current
repository lineage, exact-head CI, production migration head, Worker routes and
bindings, and the actual GPT/OAuth configuration.

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

Fourteen concepts, deliberately kept distinct:

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
Research         workspace-owned web evidence, sources and snapshots
```

The authorization rule for the whole platform, in one line:

> **Artist membership is the authority for artist-scoped work. Workspace
> membership is the authority for organization-scoped work. Neither implies
> the other, and the browser is authority for nothing.**

Everything — CRM UI, MCP, unified GPT — reaches the database through the same
capability layer. There is no second permission system. Web Research does not
create one either: Firecrawl is a provider behind a Vishar-controlled gateway,
not an authority and not a place where CRM permissions are delegated.

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

Phase W will extend this registry for artist-scoped Research rather than
hard-coding research permissions in the CRM or GPT. The intended logical names
are `view_research`, `run_research` and `manage_research`. Workspace-owned
research must use the workspace authorization layer, and the implementation
spec must define the exact mapping before any migration is written. A
workspace grant must never imply access to an artist's private CRM data.

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
| N | **Done** — domain events, rules, jobs, kill switches, one tick | `0081` | see §6.2 |
| O | **Done** — templates plus the consent/suppression gate | `0082` | see §6.3 |
| P | Workspace automation defaults and artist overrides | `0083` | builds on `0081` and `0082` |
| Q–R | MCP domain contracts and surface | none | transport over the same capability layer |
| S–T | Unified GPT: OAuth client → profile, not artist | `0081` | `gpt_action_clients` gains a profile-bound mode |
| U | Full golden-path validation | none | §77–§82 of the brief |
| V | Unified GPT Web Research gateway: Firecrawl Search/Scrape/Crawl | none | backend-only, bounded, cache/transient results, no Interact; see §6.6 |
| W | CRM Research: saved runs, sources, snapshots and comparisons | TBD at implementation fresh-check | workspace/artist scoped; recurring monitoring only after persistence is proven; see §6.6 |

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

### 6.2 What `0081` actually built

Trigger, conditions, delay, action — with exactly one action: an internal
notification. It reuses `activity_log` as the event source, `notifications` as
the delivery target, and one backend-only tick rather than a cron per scenario.

Four decisions are worth recording because they are what keep it safe:

- **There is no rule DSL.** A rule's trigger, its two optional status
  conditions, its delay and its action are typed columns. No jsonb, no
  expression string, no table or function name, no template. An injection
  surface that is never created cannot be validated wrongly later, and adding an
  action means adding an enum value plus an explicit execution branch.
- **Triggers come from a catalogue.** `activity_log.event_type` is free text
  with only a shape check, so a rule names a row in
  `automation_trigger_catalog` instead. Events outside it — including the
  automation engine's own audit rows — are never projected, so an automation
  cannot react to its own administration.
- **The event projection carries no free text.** `automation_events` holds the
  artist, the entity and the two status labels, and nothing else. There is
  nowhere for a client name, an email address or a message body to land.
- **Recipients are derived, never supplied.** A rule has no recipient column at
  all: execution notifies the people who run the artist, checked at execution
  time, so a revoked membership stops the notification.

Editing a rule bumps its version; the tick cancels pending jobs materialised
under a superseded version and never touches completed ones, which keep the
action snapshot that actually ran. Kill switches at global, workspace and
artist level pause execution and leave the work pending rather than discarding
it.

No cron and no Worker configuration change ships with this: with no rules
present the tick is a no-op.

### 6.3 What `0082` actually built

Reusable message templates, and the consent and suppression guards that decide
whether a client may be contacted at all.

The order is deliberate: nothing in this lineage can send a client a message
yet. Building the guard first means the release that adds the first
client-facing action has something to fail closed against, rather than being
the release that also has to invent the rule.

- **Classification is catalogued, not chosen.** `message_template_purposes`
  decides whether a purpose is service or marketing, and `message_templates`
  has no classification column of its own. A template cannot label a promotion
  as service traffic, and `may_contact_client` takes a *purpose* rather than a
  classification so no caller can downgrade one by argument.
- **Silence is not consent.** A client with no `client_marketing_consent` row
  receives service traffic and no marketing. `enquiries.privacy_acknowledged_at`
  is documented in migration `0003` as an acknowledgement rather than a lawful
  basis, and the gate is tested not to read it.
- **Suppression outranks consent.** An unsubscribe stops marketing but not the
  reminder for an appointment the client booked; every other reason means the
  address itself is unusable and stops service traffic too. Releasing a
  suppression records the release rather than deleting the row.
- **A template body is not a template language.** Every `{{token}}` must name a
  row in `message_template_variables`, so a body cannot reference a column, an
  expression or anything else a renderer would have to interpret.

pgTAP `230` also carries a tripwire: it asserts `automation_action_type` still
contains only `notify_artist_team`. The moment somebody adds a client-facing
automation action, that assertion fails and a reviewer has to confirm the gate
is wired into it.

### 6.4 What `0084` actually built

The unified GPT, as an authorization change rather than as a new action
surface. §1.11 recorded the finding: `crm_private.gpt_action_clients` binds one
OAuth client to one artist, so a fifth artist means a fifth GPT. `0084` changes
what the OAuth client identifies, and changes nothing else.

- **The client is an application, the human is the authority.** A client row now
  carries `binding_mode`. `artist` keeps the production Vladimir and Kristina
  rows working exactly as before. `profile` has `artist_id` **null**, enforced by
  a check constraint, so a profile-bound GPT has no artist to fall back on when
  a membership disappears. There is nothing to fall back *to*.
- **One resolver, not forty rewrites.** Every `gpt_*` RPC already funnels through
  `require_gpt_action_context`, `require_gpt_enquiry_context` and
  `require_gpt_operational_context`. Those three now call one new
  `crm_private.require_gpt_client_context()`, and their signatures and result
  columns are unchanged. No `gpt_*` operation was touched, so no operation could
  be missed.
- **The selection is a selector, never a grant.**
  `crm_private.gpt_profile_artist_contexts` stores one artist per (client,
  profile) pair and is unreachable from every API role. It is re-validated on
  every single request against `list_accessible_artists()`; a revoked membership,
  a deactivated artist or a deactivated profile makes the stored row inert
  immediately, and the resolver raises rather than silently moving to the other
  artist the human still holds.
- **Fail closed on ambiguity.** A profile holding two artists with nothing
  selected is refused with `22023` and told to select. It is not defaulted to the
  first artist. A profile holding exactly one artist resolves without a stored
  row at all, so there is no stale selector to invalidate later.
- **Membership authorizes selection; capability still authorizes the action.**
  Selecting an artist gets you as far as `view`. Reading appointments still needs
  `view_sessions`, writing still needs `manage_sessions`, finance still needs
  `manage_finance`. The GPT client's own flags remain a ceiling above that, never
  a floor: a client flag can only narrow what a membership already allows.
- **Consent tells the truth.** `get_gpt_action_consent_summary` keeps its exact
  six columns for legacy callers. A new `get_gpt_consent_details` reports
  `binding_mode`, and the consent screen renders from that rather than inferring
  a mode from a display string. A profile-bound GPT reports **no** artist name,
  because it is fixed to none; a screen that cannot tell which binding it is
  describing falls back to the narrower fixed-artist wording.

At the edge, `/v1/context` is the one route that accepts an `artist_id`, and it
accepts it as a selector that the database re-checks. The ban on `artist_id` in
every other route and in both OpenAPI schemas is unchanged — the contract tests
strip `/v1/context` and then assert the ban still holds everywhere else, so the
exception cannot quietly widen.

Nothing here creates an OAuth client, enables a GPT, or changes a Cloudflare
route. The canonical unified client ships with `oauth_client_id` null,
`is_active` false and **every capability off**, exactly as the two production
clients do; an owner turns capabilities on one at a time through the existing
`configure_gpt_*` RPCs. pgTAP `232` asserts all three, and pgTAP `204` and `205`
assert across every row that no GPT client ever arrives with a permission
already enabled.

### 6.5 Phase U: what the golden path proved, and what it broke

Every phase before this one tested its own migration against its own fixtures.
That proves each piece works. It does not prove they compose, and composition is
the entire claim of this refactor.

`supabase/tests/233_golden_paths.sql` onboards one brand-new artist the way a
studio would and follows a single real enquiry the whole way: the artist row
provisions a workspace, the owner grants two memberships, the capability
registry answers for an artist nobody wrote code for, the artist opens their own
hosted booking source, a stranger submits that form naming no artist, the
durable intake resolves the artist from the form id, the activity projection
feeds the automation engine, a rule the artist wrote themselves materialises a
job, the tick delivers a notification into that artist's inbox and nobody
else's, the consent gate allows service traffic to the new client and refuses
marketing, a studio-wide automation default expands into an artist-owned rule,
and the unified GPT resolves the same artist through the same memberships.

Three things it established that no single-phase test could:

- **Defaults are off, consistently.** A booking source and an automation rule
  both arrive switched off. The golden path has to turn the rule on before
  anything fires, which is the correct posture and worth pinning.
- **Refusal, not silence.** `list_booking_sources` raises rather than returning
  an empty routing map to someone without access. That distinction is the
  hardening Phase I-J added, and it is asserted here as behaviour rather than
  as an implementation detail.
- **Phase P has no caller yet.** Its control-plane RPCs are granted to no API
  role at all. The golden path asserts that closed state rather than pretending
  a manager could use it today, and reaches the mechanism through a definer
  boundary the way a future surface will.

And one defect, which is why the phase earned a migration:

**`list_notifications` never re-derived artist scope.** It matched on
`recipient_profile_id` and stopped. That was right when notifications were built
in Phases K-M, because delivery and access were decided at the same moment. It
stopped being right once membership became something a studio grants and
revokes: a revoked manager kept the artist's display name, the titles and bodies
that artist's automations had written, and the entity ids of their enquiries and
projects — in their own inbox, after the rest of the CRM had closed to them.
`snooze_follow_up` had always called `require_artist_access`; notifications were
the one read that did not.

Migration `0085` applies the rule the rest of the platform already follows, to
both `list_notifications` and `mark_notification_read`. Nothing is deleted:
revocation hides the row and restoring the membership brings it back, the same
posture the unified GPT takes with a stale Artist selector. The golden path
asserts both halves.

### 6.6 Phases V–W: Web Research and Firecrawl as one CRM capability

Firecrawl is deliberately **not** added as a second generic search engine and
is not connected directly to ChatGPT. It is an external web-data provider
behind the existing Vishar backend boundary:

```
Unified Vishar GPT            Vishar CRM Research UI
          \                         /
           \                       /
            → Vishar Tool / Research Gateway
                       |
             Firecrawl adapter
              /       |       \
           Search   Scrape    Crawl
                       |
                 public internet
```

The same gateway serves both the unified GPT and the CRM so research is one
platform capability, not a GPT-only integration. The Firecrawl credential is a
server-side Worker secret. It is never stored in Postgres, returned by an RPC,
placed in an OpenAPI schema, exposed to a browser or sent to ChatGPT.

#### Phase V: bounded, transient Web Research for the unified GPT

V1 exposes only three semantic tools through the Vishar action surface:

```
deep_web_search(query, domains?, limit?)
read_web_page(url, extraction_schema?)
crawl_website(url, include_paths?, exclude_paths?, max_pages?)
```

The provider implementation may use Firecrawl Search, Scrape and Crawl, but the
GPT sees Vishar operations rather than Firecrawl's raw API. This lets the
backend change provider, add caching, narrow limits or disable one operation
without editing every GPT instruction.

**Routing rule.** Built-in GPT web search remains the normal path for a fresh
fact, news, one-off lookup, location or a small number of sources. The Research
gateway is selected when the task needs deep reading of a concrete URL,
bounded traversal of a site/section, the same structured fields across several
sites, or a repeatable research run. A request that could be answered by normal
web search must not consume Firecrawl merely because it is available.

Default V1 limits are intentionally small:

- `deep_web_search`: at most 10 results;
- `read_web_page`: one URL per call;
- `crawl_website`: 10 pages by default, hard maximum 20;
- explicit backend time, response-size and concurrency limits;
- no Firecrawl Interact, browser clicks, form filling or login automation.

The backend owns URL safety. It accepts only `http`/`https`, rejects localhost,
private/link-local/reserved address space and cloud metadata targets, resolves
and re-validates DNS, and re-checks every redirect before following it. The
caller cannot provide cookies, `Authorization` headers, provider credentials or
other arbitrary outbound headers. A URL that changes from public to private
through DNS or redirect fails closed.

**Scraped content is untrusted data.** Instructions found in a page, including
prompt injection such as "ignore previous instructions", have no authority.
They may be quoted or summarized as page content but cannot change tool policy,
request CRM mutations, select another artist, broaden permissions or cause a
second privileged tool call. Tool output is data, not an instruction channel.

**CRM data does not travel to Firecrawl.** Client names, email addresses,
telephone numbers, enquiry notes, project notes, private images, finance data,
OAuth material, provider tokens and other private CRM content are never sent to
Firecrawl. When a question combines public research with CRM facts, Vishar
retrieves the public evidence first and combines it with authorized CRM data on
our side of the boundary.

Phase V is transient by design:

```
Firecrawl → bounded normalized result → short-lived cache → GPT/CRM caller
```

It does not create a database row for every scrape. Cache keys must be derived
from normalized public request inputs, scoped so one workspace cannot recover
another workspace's private request metadata, and carry a finite TTL. At
minimum observability records operation type, timing, provider status, cache
hit/miss and bounded usage/credit metadata; it must not log page bodies,
credentials or private CRM data.

Three server-side kill switches are part of the first release:

```
FIRECRAWL_ENABLED
FIRECRAWL_SEARCH_ENABLED
FIRECRAWL_CRAWL_ENABLED
```

Disabling the provider changes no CRM authorization and corrupts no CRM data.
The GPT receives an explicit tool-unavailable/provider-error result and must not
invent the missing research.

#### Phase W: Research becomes a persistent CRM domain

Only after Phase V is stable does CRM gain a durable Research area. The first
product surface is intentionally narrow:

```
Research
├── Competitors
├── Studios
├── Pricing
├── SEO
└── Market research
```

The durable model is based on three concepts, with exact columns assigned only
after the implementation fresh-check and Spec Kit plan:

```
research_runs       one requested/repeated research operation
research_sources    the public sources used by that run
research_snapshots  normalized evidence that can be compared over time
```

A run is workspace-owned and may optionally carry an artist context. Workspace
ownership never grants access to that artist's CRM records: any operation that
joins research with clients, finance, sessions, communications or another
artist-scoped domain must independently pass the existing artist capability
check. Research permissions are added to the existing registry/workspace model,
not implemented as Firecrawl roles or a parallel ACL.

The CRM must be able to save a useful normalized result, reopen its sources,
repeat the same bounded research later and compare snapshots. This is what
turns Firecrawl into a CRM feature rather than a better search box. Examples of
the intended product behavior are:

- repeat a saved competitor-pricing study and show changed prices/deposits;
- monitor selected studio booking/cancellation policy pages;
- compare public SEO/content structure across selected sites;
- show when a watched public page materially changed and retain the evidence
  that justified the comparison.

Recurring monitoring is a later enablement inside Phase W, not part of the
first persistent write. It uses the existing scheduler/automation principles:
explicit ownership, bounded frequency, idempotent execution, kill switches,
usage limits and a durable audit trail. A failed provider fetch never deletes a
last-known-good snapshot and never becomes an invented "no change" result.

#### Implementation order and release boundary

Because this adds a new external provider and trust boundary, implementation is
**Substantial** under the repository feature-development rules. Before code,
create/update durable Spec Kit artifacts under `specs/` and prove the exact
release lineage again. The intended order is:

1. fresh-check unified GPT/OAuth state, Worker/action surface, current migration
   head, CI and production target;
2. specify the Research domain, permission mapping, retention and cache contract;
3. add the server-side Firecrawl adapter and secret binding with all switches
   off by default;
4. add URL/redirect/SSRF guards and provider response normalization;
5. add `deep_web_search`, `read_web_page` and bounded `crawl_website` behind
   the existing Vishar gateway;
6. extend the unified GPT OpenAPI/action surface and routing instructions without
   creating a separate Firecrawl OAuth/client surface;
7. validate staging with positive and denial cases, usage limits and cache;
8. release Phase V through exact-head CI → deploy → readback → unified-GPT E2E;
9. design and migrate Phase W persistence only from the then-current production
   migration head;
10. add the CRM Research UI, saved runs and snapshot comparison, then enable
    recurrence only after persistent acceptance is proven.

Phase V acceptance requires all of the following:

1. a URL can be read and a public deposit/policy fact returned with its source;
2. five public studio/artist sites can be compared using the same requested
   fields without silently changing the schema between sources;
3. a crawl can be constrained to paths such as `/booking` and `/faq` and cannot
   exceed the hard page limit;
4. localhost, private IP, metadata endpoints, unsafe redirects and non-HTTP(S)
   schemes are rejected before credentials are sent;
5. prompt-injection text in a scraped page does not alter GPT/tool behavior;
6. an equivalent repeated request can use the cache without crossing workspace
   metadata boundaries;
7. provider `429`, timeout and malformed output produce an explicit failure and
   no fabricated answer;
8. each kill switch demonstrably stops the intended operation;
9. the production-deployed SHA and Worker configuration are read back after
   rollout;
10. E2E through the unified Vishar GPT proves the active human/profile and
    selected artist remain governed by the existing membership/capability layer.

Phase W acceptance adds: saved runs are correctly workspace/artist scoped,
revoked users lose access immediately, snapshot comparison is reproducible from
stored evidence, repeated monitoring is idempotent, and no private CRM/client
content is present in provider requests or research-source payloads.

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
| Firecrawl / Phase V | `FIRECRAWL_ENABLED=false` removes the provider from the usable surface; transient/cache results expire and no CRM business record depends on provider availability. |
| Research / Phase W | Stop recurrence and writes first; saved runs/sources/snapshots remain readable historical evidence. Provider disablement must not delete or rewrite last-known-good snapshots. |

---

## 8. What this change does not do

Deliberately out of scope, per §87 of the brief: drag-and-drop form builder,
visual automation editor, campaign builder, marketing analytics, billing,
studio analytics, and any autonomous AI receptionist. The goal is correct
foundations plus the minimum usable surface. Firecrawl does not change that:
Phase V is read-only public web research, and Phase W persists research evidence
inside CRM without granting autonomous browser interaction or client-facing
actions.
