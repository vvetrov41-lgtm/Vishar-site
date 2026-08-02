# Multi-artist and payments foundation

Status: implementation plan for the draft branch `agent/multi-artist-payments-foundation`.

Base branch: `claude/vishar-crm-booking-infra-c188bx`

Verified base SHA: `773b96c56cf70d9e029c7e701598c4bc9811a261`

This stage extends the existing CRM. It does not replace the durable intake, private Storage, append-only Activity Log, narrow RPC write model, or integration outbox.

## Safety boundary

This stage must not:

- change production;
- merge PR #174 or PR #176;
- remove staging;
- expose a Supabase secret/service key, Telegram token, chat ID, OAuth token, payment secret or GPT credential;
- put Cloudflare Access in front of the public intake Worker;
- weaken RLS, ACLs, Storage policies, CORS, WAF or the append-only Activity Log;
- connect a real payment provider, Google Calendar OAuth, Gmail, production Telegram for Kristina or a production GPT;
- use non-synthetic data in staging.

All migrations are forward-only. Existing migrations `0001` through `0014` remain unchanged.

## Verified starting state

The repository and hosted staging were checked before this plan was written.

- PR #174 is open, draft and unmerged.
- PR #176 is open, draft and unmerged.
- The actual head of PR #176 is `773b96c56cf70d9e029c7e701598c4bc9811a261`.
- The head SHA written inside the PR #176 body is stale and must not be used as a branch point.
- Hosted staging has migrations `0001` through `0014`.
- Retained staging data contains one synthetic client, converted enquiry `ENQ-2026-0002`, one draft GBP project, no sessions, one private file and one succeeded Telegram outbox row.
- Existing writes use named `SECURITY DEFINER` RPCs; browser roles do not have direct table write privileges.
- RLS is enabled and forced on CRM tables.
- Existing finance columns are withheld through column ACLs and owner-only `SECURITY INVOKER` projections.
- Activity Log mutation is blocked by trigger even for `BYPASSRLS` callers.
- Current Storage access validates canonical manifest-backed object paths, but is not artist-scoped yet.
- Current intake validates an allowed Origin, but the submitted `source` is still browser data and does not resolve an artist server-side.
- Current staging deployment workflows are intentionally pinned to previously approved commits on the PR #176 branch. The new branch will not deploy automatically.

## Access model

The existing global `profiles.role` remains the coarse CRM role:

- `owner`
- `booking_manager`
- `read_only`

Artist access is a second, narrower layer. It never widens the global role.

A user may act on an artist only when both conditions are true:

1. the global profile role permits the operation;
2. an active `artist_memberships` row permits access to that artist.

The owner role is exceptional: an active owner receives all-artist visibility and management, but the database still records explicit memberships so access is inspectable and testable.

### Initial access rules

| Identity | Artist scope | Finance | Sessions | Integrations |
| --- | --- | --- | --- | --- |
| Vladimir owner | Vladimir and Kristina | all permitted artist finance | all | all metadata/configuration |
| Kristina artist account | Kristina only | Kristina only | Kristina only | Kristina metadata only |
| Booking manager | assigned artists only | only when explicitly granted | assigned artists only | no secrets; metadata only when granted |
| Read-only | assigned artists only | no finance unless a future explicit policy says otherwise | read only | none |
| Worker backend | artist resolved from trusted booking source | no arbitrary cross-artist choice | outbox only | server bindings only |
| Future Vladimir GPT | Vladimir only | named tools only | named tools only | no secrets |
| Future Kristina GPT | Kristina only | named tools only | named tools only | no secrets |

## Tables and private mirrors

### `artists`

Planned columns:

- `id uuid primary key`
- `slug text unique not null`
- `display_name text not null`
- `legal_name text null`
- `timezone text not null`
- `default_currency text not null`
- `booking_reference_prefix text unique null`
- `is_active boolean not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Initial rows:

- `vladimir` / `Vladimir`
- `kristina` / `Kristina`

Both initially use `Europe/London` and `GBP`. Existing business rows are assigned to Vladimir in migration `0016`.

### `artist_memberships`

Planned columns:

- `id uuid primary key`
- `profile_id uuid not null references profiles(id)`
- `artist_id uuid not null references artists(id)`
- `access_level artist_access_level not null`
- `can_view_finance boolean not null`
- `can_manage_finance boolean not null`
- `can_manage_sessions boolean not null`
- `can_manage_integrations boolean not null`
- `is_active boolean not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- unique `(profile_id, artist_id)`

`can_manage_finance` implies `can_view_finance`. Membership constraints enforce this in the database.

### `crm_private.artist_access`

RLS helpers must not recursively query an RLS-protected membership table. A trigger-maintained private mirror will contain only access-control fields needed by policies and RPCs.

The mirror is inaccessible to `anon`, `authenticated` and normal browser code. Named helper functions read it using fixed search paths.

Planned helpers include:

- `can_access_artist(artist_id)`
- `can_manage_artist(artist_id)`
- `can_view_artist_finance(artist_id)`
- `can_manage_artist_finance(artist_id)`
- `can_manage_artist_sessions(artist_id)`
- `can_manage_artist_integrations(artist_id)`
- `require_artist_access(artist_id, capability)`

No helper accepts SQL, table names or arbitrary predicates.

## Artist ownership of existing records

Migration `0016_artist_scope_existing_records.sql` adds `artist_id` to:

- `enquiries`
- `projects`
- `sessions`
- `follow_ups`
- `email_messages`
- `integration_outbox`

The migration sequence is strict:

1. add nullable columns;
2. resolve the seeded Vladimir artist row;
3. backfill every existing row to Vladimir;
4. verify zero null rows;
5. add foreign keys and indexes;
6. set `NOT NULL` where the entity must always have an artist;
7. add consistency triggers.

`activity_log` will also receive a nullable `artist_id`. This is required for direct artist-level events such as membership, integration and payment actions that may not have an enquiry/project/session reference. Existing activity rows are backfilled when their linked entity resolves unambiguously; otherwise they remain owner-visible system history.

`enquiry_files`, `project_files`, `internal_notes` and clients do not need duplicate artist columns. Their scope is derived through their linked entities and protected by scoped policies.

### Consistency rules

- a project converted from an enquiry inherits the enquiry artist;
- a session inherits its project artist;
- a follow-up must match the artist of every referenced enquiry/project;
- an email message must match the artist of every referenced enquiry/project;
- an outbox job must match its referenced entity artist;
- a file manifest remains tied to an accessible enquiry or project;
- a cross-artist reassignment cannot happen through a direct update or generic RPC.

## Client visibility

Clients remain shared records to avoid unsafe duplicate merging.

A user may see a client only when at least one linked enquiry or project is inside an accessible artist scope. An active owner sees all clients.

A client with records for both artists remains one client card, but a non-owner sees only related enquiries/projects in their permitted scope.

Client matching during public intake remains global and conservative. Matching a client does not grant access to the other artist's enquiries or projects.

## Booking sources

### `booking_sources`

Planned columns:

- `id uuid primary key`
- `artist_id uuid not null`
- `source_key text unique not null`
- `allowed_origin text not null`
- `form_version text not null`
- `is_active boolean not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Initial logical sources:

- Vladimir website
- Kristina website

The browser never submits an authoritative `artist_id`.

The Worker resolves a trusted `source_key` from server-side configuration and verifies that the request Origin matches the active database source. The intake RPC resolves `artist_id` from that trusted source key. A submitted marketing `source` string remains attribution text only and cannot affect ownership.

CORS remains a browser control, not authentication. Non-browser callers are still constrained by the exact Worker route, WAF/rate limit, trusted Worker credentials and database source resolution.

## Artist integrations

### `artist_integrations`

This table stores metadata only:

- `id uuid primary key`
- `artist_id uuid not null`
- `integration_type integration_type not null`
- `provider text not null`
- `integration_key text not null`
- `external_account_label text null`
- `configuration jsonb not null default '{}'`
- `is_enabled boolean not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- unique `(artist_id, integration_type, integration_key)`

Supported types:

- `telegram`
- `calendar`
- `email`
- `payments`
- `gpt`

Forbidden database content includes tokens, secrets, passwords, OAuth refresh tokens, chat IDs and private keys. A recursive JSON guard rejects credential-shaped keys. Secret values remain in encrypted Cloudflare server-side configuration.

## Payment foundation

Money uses `numeric(12,2)`. Every monetary row stores an explicit ISO currency.

### `artist_payment_policies`

Stores versioned policy parameters per artist:

- deposit mode;
- fixed amount or percentage;
- payment deadline;
- transfer allowance;
- refund policy version;
- effective timestamps;
- active state.

Old policy versions are retained. A payment request snapshots the applicable policy version and relevant terms when created.

### `payment_requests`

Represents an amount requested, not proof that money moved.

Planned fields include:

- `id`
- `artist_id`
- `client_id`
- `project_id`
- `session_id`
- `purpose`
- `amount`
- `currency`
- `status`
- `provider`
- `provider_account_key`
- `policy_id`
- `policy_version`
- `expires_at`
- `created_by`
- `created_at`
- `updated_at`

Purposes:

- `deposit`
- `session_balance`
- `additional_payment`
- `design_fee`
- `other`

### `payment_transactions`

Represents immutable money movement or a separately recorded adjustment.

Planned transaction types:

- `payment`
- `refund`
- `partial_refund`
- `manual_payment`
- `adjustment`

A correction is a new transaction. Existing transactions are never rewritten or deleted.

The database enforces:

- request/transaction artist match;
- request/transaction currency match;
- provider transaction identifiers are unique when present;
- refund totals cannot exceed settled payment totals;
- positive amounts;
- append-only update/delete/truncate rejection;
- direct browser writes are unavailable;
- manual payments require an authenticated human with artist finance permission;
- provider payments require a trusted backend/webhook context.

### `payment_webhook_events`

Stores safe processing metadata and idempotency:

- `provider`
- `provider_event_id`
- `artist_id`
- `processing_status`
- received/processed timestamps
- safe error code
- body checksum when useful

Unique `(provider, provider_event_id)` prevents duplicate processing. Raw provider payloads and secrets are not stored in exposed tables.

## Compatibility with project deposits

Existing `projects.deposit_amount`, `projects.deposit_status` and `sessions.payment_status` remain temporarily for the current UI contract.

After the payment migrations:

- ledger tables become the source of truth;
- compatibility views calculate legacy fields from payment requests and transactions;
- the old `update_project_deposit` RPC is replaced with a compatibility wrapper that creates a request and, when explicitly recording a manual payment, creates an immutable transaction;
- a browser cannot directly set `paid`;
- an automatic provider payment can only be recorded by a trusted webhook workflow;
- refunds add transactions rather than modifying prior payments.

The enquiry status `deposit_paid` remains for workflow compatibility but can only be reached after the database confirms the related payment state.

## Telegram routing

Outbox jobs gain `artist_id` and resolve the integration route by artist.

For staging:

- Vladimir and Kristina use separate staging destinations;
- only synthetic data is sent;
- the notification contains artist label, enquiry reference and image count;
- no name, email, phone, Instagram, idea, filename, signed URL or message body is sent;
- route identifiers and secrets come from Worker bindings, not browser data or exposed database fields.

A separate bot/chat pair per artist is preferred, but the schema does not require a specific Telegram topology.

## Calendar and reminders

This stage prepares artist-scoped metadata and outbox jobs only.

`sessions` remains the source of truth. Only `confirmed` sessions may create a calendar event. Existing protections remain in force.

Planned reminder definitions cover safe templates such as:

- `booking_confirmed`
- `deposit_due`
- `session_7_days`
- `session_48_hours`
- `session_24_hours`
- `session_cancelled`
- `aftercare`
- `healed_photo_request`

No real Google OAuth, Gmail OAuth or client delivery is connected in this stage.

## GPT identities

The foundation stores identity and scope metadata only.

Every future AI operation must include:

- a named AI caller identity;
- one artist scope;
- the authenticated human context when a human initiated the request;
- one named tool/action;
- an Activity Log event for every write.

AI callers receive no arbitrary SQL, Supabase service key, Telegram token or provider secret.

The initial Kristina read/write surface remains limited to named own-scope actions. Payment creation, client communication and status changes require separate approval and tests.

## CRM changes

The owner receives an artist selector:

- All
- Vladimir
- Kristina

Non-owner users do not receive an owner-wide selector. Their available scope is derived from memberships.

Artist name appears on:

- enquiry list and detail;
- project list and detail;
- session list and detail;
- dashboard metrics;
- finance rows;
- follow-ups;
- integration failures.

The UI may request an artist filter, but RLS remains authoritative. Omitting or manipulating the filter cannot widen results.

Free text entered by clients or staff is never automatically translated. Only controlled labels and system events receive EN/RU translations.

## Migration sequence

### `0015_artists_memberships.sql`

- artist and membership types/tables;
- private access mirror and sync trigger;
- initial Vladimir/Kristina rows;
- explicit owner membership backfill;
- forced RLS and closed ACLs;
- narrow access helpers.

### `0016_artist_scope_existing_records.sql`

- add and backfill `artist_id`;
- add indexes/FKs/NOT NULL;
- entity consistency triggers;
- activity artist context.

### `0017_booking_sources_integrations.sql`

- booking sources;
- integration metadata;
- recursive no-secrets guard;
- closed RLS/ACL;
- trusted source resolution helpers.

### `0018_payment_requests_transactions.sql`

- payment policies;
- requests;
- transactions;
- webhook event idempotency;
- append-only financial history protections.

### `0019_artist_scoped_rls.sql`

- replace broad all-staff policies with artist predicates;
- client visibility through accessible linked records;
- scoped files, notes, activity, outbox and finance;
- preserve column-level finance isolation.

### `0020_artist_workflow_rpcs.sql`

- artist-aware intake, assignment, conversion, session and follow-up workflows;
- protected membership management;
- protected cross-artist transfer workflow reserved for owner;
- payment request/manual transaction/refund RPCs;
- human and AI caller audit context.

### `0021_artist_outbox_routing.sql`

- artist-specific outbox routing metadata;
- calendar/reminder preparation;
- Telegram route resolution contract;
- dedupe keys include artist identity where needed.

### `0022_payment_compatibility_views.sql`

- ledger-backed finance projections;
- compatibility deposit/session payment fields;
- replace old deposit RPC behavior without breaking current CRM reads;
- `SECURITY INVOKER` public views over private scoped sources.

## pgTAP strategy

Tests are added with each migration, not at the end.

### `0015` tests

- exactly two initial artists with expected slugs;
- unique slug/currency/timezone constraints;
- membership uniqueness and capability constraints;
- active owner receives both memberships;
- access mirror follows insert/update/delete;
- RLS enabled and forced;
- no `anon` access;
- authenticated has no direct write privileges;
- inactive/unprofiled users cannot access an artist.

### `0016` tests

- every existing business row backfills to Vladimir;
- no required `artist_id` remains null;
- project/enquiry and session/project mismatches fail;
- linked notes/files remain correctly scoped;
- activity artist derivation does not weaken append-only protection.

### `0017` tests

- browser-provided artist ID is ignored/refused;
- valid source resolves one artist;
- wrong origin/source pair fails;
- inactive source fails;
- integration metadata rejects secret-like keys;
- cross-artist integration reads fail.

### `0018` tests

- immutable transaction history;
- duplicate provider event rejected/idempotently replayed;
- currency and artist mismatch rejected;
- refund cannot exceed settled payments;
- direct browser `paid` transition rejected;
- manual payment requires authenticated human finance permission.

### `0019–0022` tests

- owner sees both artists;
- Kristina fixture sees only Kristina scope;
- manager sees assigned artists only;
- read-only cannot write;
- Kristina cannot see Vladimir finance, files, activity or clients through indirect joins;
- Storage signed access cannot cross artist scope;
- conversion/session/follow-up inherit artist correctly;
- cross-artist reassignment requires the protected owner workflow;
- only confirmed sessions enqueue calendar work;
- old deposit projections agree with the ledger.

The canonical suite must continue to pass from a clean database reset. Database lint, frontend tests/build, Worker tests, dependency audits and secret scan remain required.

## Staging rollout

No migration from this branch is applied to hosted staging until its local clean-reset pgTAP suite is green.

The existing staging workflows are pinned to old approved commits and do not automatically deploy this branch. Before hosted E2E, create or update an explicitly isolated workflow that:

- targets only `vishar-crm-staging`, `vishar-booking-staging`, `vishar-crm-staging` Pages and `tattooai-preview`;
- never targets production;
- uses staging-only secrets;
- preserves owner-only Access on both Pages projects;
- leaves the public Worker outside Access;
- preserves the exact staging path, WAF rule and rate limit;
- deploys only an explicitly reviewed commit;
- never prints secret values.

## Completion criteria

The stage is complete only when:

1. Vladimir synthetic intake resolves only to Vladimir.
2. Kristina synthetic intake resolves only to Kristina.
3. Telegram routing reaches separate staging destinations without client contact data.
4. Owner sees both artists.
5. Kristina fixture sees only Kristina.
6. Project and session inherit the correct artist.
7. Manual deposit creates a request and transaction.
8. Exact retries do not duplicate requests, transactions or outbox jobs.
9. Refunds are separate immutable transactions and remain within paid totals.
10. Foreign payment/calendar/integration configuration is inaccessible.
11. Clean reset, pgTAP, lint, frontend, Worker and secret scans pass.
12. Production is unchanged.
13. PR #174, PR #176 and this PR remain draft and unmerged.
14. Hosted staging remains intact after testing.

## Deferred provider work

The following starts only after artist isolation and payment ledger E2E pass:

- payment provider account and webhook connection;
- real bank/payment operations;
- Google Calendar OAuth;
- Gmail or another email provider;
- automatic client reminders;
- production Telegram for Kristina;
- production GPT identities/tools;
- production Kristina website intake.
