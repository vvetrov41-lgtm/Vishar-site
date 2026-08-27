# Platform refactor migration allocation

Status: authoritative migration-number ledger for the unfinished platform refactor.

This file supersedes the migration-number column in `docs/crm/PLATFORM_REFACTOR.md` section 6 wherever that older roadmap assigns a number to a phase that has not started yet. The phase descriptions and ordering rationale in the architecture document remain valid; only stale future migration reservations are overridden here.

## Claimed numbers

| Migration | Owner | State |
| --- | --- | --- |
| `0074` | Phase B, capability registry | claimed in PR #382 |
| `0075` | Phase C, workspaces | claimed in PR #382 |
| `0076` | Phase D, integration ownership and assignment | claimed in PR #382 |
| `0077` | Phases K-M, internal notifications and follow-up sweep | claimed in PR #382 |
| `0078` | Phase H, dynamic booking source registry | claimed in PR #383 |
| `0079` | Phases I-J, hosted forms and external websites | claimed on `agent/platform-hosted-booking-forms` |
| `0080` | Phases I-J, booking-source list scope hardening | claimed on `agent/platform-hosted-booking-forms` |
| `0081` | Phase N, automation engine foundation | claimed on `agent/platform-automation-engine` |
| `0082` | Phase O, message templates and the consent/suppression gate | claimed on `agent/platform-message-templates` |
| `0083` | Phase P, workspace automation defaults and artist overrides | claimed on `agent/platform-workspace-automation-defaults` |
| `0084` | Phases S-T, unified GPT profile-bound authorization | claimed on `agent/platform-unified-gpt` |
| `0085` | Phase U, notification scope re-checked on revocation | claimed on `agent/platform-golden-paths` |
| `0086` | Phases F-G, Telegram self-service destinations and delivery foundation | claimed in PR #391 |
| `0087` | Control plane, artist/workspace lifecycle | claimed in PR #394 |
| `0088` | Control plane, read surfaces | claimed in PR #394 |
| `0089` | Control plane, governance hardening | claimed in PR #394 |
| `0090` | Control plane, ownership-transfer boundary hardening | claimed in PR #394 |
| `0091` | Telegram artist delivery observability | claimed on private CRM lineage |
| `0092` | Automation client-message action | claimed on private CRM lineage |
| `0093` | Client lifecycle automation | claimed on private CRM lineage |
| `0094` | Client lifecycle control plane | claimed on private CRM lineage |
| `0095` | Client lifecycle client-archive fix | claimed on private CRM lineage |
| `0096` | Client lifecycle scheduling integrity | claimed on private CRM lineage |
| `0097` | Lifecycle Automation v1 production activation | claimed in PR #414 |
| `0098` | Appointment client-action capability foundation | claimed on `agent/appointment-client-actions-foundation` |
| `0099` | Deposit-policy Gmail delivery chain | claimed in PR #428 |
| `0100` | Appointment client-action lifecycle activation | claimed on `agent/appointment-client-actions-activation-v2` |
| `0101` | Telegram notification entity targets | claimed in PR #440 |
| `0102` | Lifecycle control-plane safe template reads | claimed on `agent/lifecycle-control-plane-ui` |
| `0103` | Post-session check-in production activation | claimed on `agent/post-session-checkin-activation` |
| `0104` | Lifecycle Automation Studio v2 read-only preview foundation | claimed on `agent/lifecycle-studio-preview-foundation` |
| `0105` | Lifecycle Automation Studio v2 execution-history read foundation | claimed on `agent/lifecycle-execution-history-foundation` |
| `0106` | Lifecycle Automation Studio v2 timing mutation foundation | claimed on `agent/lifecycle-timing-control` |
| `0107` | Lifecycle Automation Studio v2 immutable template versioning | merged in PR #463 |
| `0108` | Lifecycle Automation Studio v2 configuration mutation audit | claimed on `agent/lifecycle-configuration-audit` |
| `0109` | Lifecycle Automation Studio v2 configuration history read API | claimed on `agent/lifecycle-audit-history-read` |
| `0110` | Lifecycle Automation health projection | claimed on private CRM lineage |
| `0111` | Lifecycle Automation runtime health diagnostics | claimed on private CRM lineage |
| `0112` | Lifecycle scheduler heartbeat diagnostics | claimed on `agent/lifecycle-scheduler-heartbeat` |

The next unclaimed migration number after the current stacked lineage is therefore:

`0113`

## Allocation rule for unfinished phases

Do not pre-assign fixed migration numbers to Telegram self-service, automations, templates, MCP/GPT support, or any other unfinished phase.

Before an unfinished phase creates its first migration:

1. fresh-check the exact relevant branch HEAD and all open stacked workstreams;
2. fresh-check the production Supabase migration head;
3. enumerate migration filenames already present in every active ancestor/stacked branch that the new work depends on;
4. claim the lowest next unused forward-only migration number on that actual lineage;
5. record the claim in this ledger in the same workstream that introduces the migration.

This avoids two failure modes present in the original roadmap table: two future phases claiming the same number, and a blocked/deferred phase reserving a lower number that later has to be inserted behind already-applied production migrations.

## Current unfinished phases

The platform-refactor roadmap has no other phase waiting for an initial migration number. Phase F-G now claims `0086`; later fixes use the next free number after a fresh check.

The control-plane workstream claims `0087` through `0090` on the lineage whose tip
is `agent/platform-telegram-self-service`. Production Supabase
(`vfjexhfdbrjmuxfdvbdx`) was fresh-checked at `0086_telegram_self_service`
before the claims. `0087` adds the artist and workspace lifecycle RPCs, the
shared capability derivation and the one-shot artist seat; `0088` adds the
control-plane reads and opens the two workspace-automation calls artist
onboarding needs. See `docs/crm/NEW_ARTIST_ONBOARDING.md`. `0089` closes the
governance gaps an independent review found in that first pass: a scoped people
directory, workspace owner invariants and a deliberate ownership transfer, an
eligibility check before the one-shot artist seat is spent, and two server-
authoritative reads that let the artist open their own onboarding page and the
interface stop deriving control-plane visibility from `CrmRole`. `0090` closes
the final ownership-transfer boundary found in the second review: only a sitting
active workspace owner may transfer that workspace, so installation-wide owner
authority can no longer create an extra owner while emitting a false
`from_profile_id`.

Phases Q-R use no migration. Phases S-T claim `0084` on their actual stacked lineage.
Phase U claimed `0085`: its cross-phase golden path found that `list_notifications`
matched only on recipient and never re-derived artist scope, so a revoked
membership kept an artist's notifications in the old recipient's inbox. Phase
F-G claims `0086` for the private Telegram destination registry, single-use
linking sessions and external-notification delivery state. Its runtime and
production activation contract is documented in `docs/crm/TELEGRAM_SELF_SERVICE.md`.

The client lifecycle workstream claims `0092` through `0095`, and its
scheduling-integrity restack claims `0096`. Lifecycle Automation v1 claims
`0097`: the first configuration that makes that engine do something, rather
than more machinery. It ships, per active artist, a 72-hour and a 24-hour
tattoo-session reminder plus a 24-hour consultation check-in (both
`in_person_consultation` and `video_consultation`, which are one rule each
because a lifecycle rule is conditioned on exactly one appointment type), the
three service templates those rules select, and nothing else. It deliberately
ships no 72-hour consultation reminder and leaves `touch_up` unconfigured.
Because a job materialises only from a new `appointment.scheduled` event and
history is never backfilled, applying it cannot send an email and does not
enrol already-booked clients.

Appointment client actions claim `0098` for their inert capability foundation.
That migration stores non-terminal client responses separately from internal
appointment status, adds server-only one-time capabilities bound to the exact
appointment version, exposes only narrow backend resolve/apply RPCs, and keeps
reschedule as a request while preserving the existing Calendar cancellation
path for an explicit client cancel. Applying `0098` itself issues no token.

Deposit-policy Gmail delivery claims `0099`, merged in PR #428 and applied to
production before `0100` was allocated. It connects deposit request and paid
confirmation mail to the existing approved-email Gmail path, adds payment
provenance to system-approved mail and preserves the conditional 72-hour
non-refundable cancellation wording in the tattoo reminder.

Appointment client-action lifecycle activation claims `0100`. It adds the three
catalogued action-link variables and activates Confirm attendance, Request a
different time and Cancel in the existing 24-hour tattoo and consultation
emails. The 72-hour tattoo message deliberately remains action-free: when an
appointment is first scheduled inside 24 hours, both the overdue 72-hour job and
the 24-hour job can execute in one automation tick, while the 0098 minting
contract permits only one active capability per appointment/action. Keeping the
72-hour email action-free prevents the later 24-hour mint from invalidating
links just written into an email from the same tick. Capability minting remains
inside the database-owned lifecycle execution transaction, after destination,
suppression, template and Gmail gates, and the branded public runtime remains
the already-deployed `booking.vishartattoo.com` proxy.

Telegram notification entity targets claim `0101`, merged in PR #440. The
existing backend-only notification claim RPC keeps the same input identity and
gains nullable `entity_type` and `entity_id` result fields so the trusted
Telegram connector can preserve the appointment entity already attached to an
internal notification and build the corresponding CRM deep link.

Lifecycle control-plane safe reads claim `0102`. The migration does not grant
browser SELECT on `message_templates` and does not create or enable any rule or
template. It adds three `SECURITY DEFINER` RPCs with pinned `search_path` that
require the caller's current `view_automations` capability on the requested
artist and return only lifecycle-compatible service email templates plus the
service-purpose and template-variable catalogues. This gives the private CRM a
server-authoritative read surface for lifecycle authoring without exposing
provider state, client values, template authorship or another backend path.

Post-session check-in activation claims `0103`. It adds one reviewed active
English workspace template and, per active Artist, exactly two enabled rules:
`tattoo_session` and `touch_up`, both anchored 1,440 minutes after authoritative
`session_end`. It deliberately excludes `in_person_consultation` and
`video_consultation`, adds no other post-session stage, does not backfill
historical appointments and keeps delivery on the existing system-approved
`approved_email` outbox and Gmail Worker path.

Lifecycle Automation Studio v2 preview foundation claims `0104`. It adds two
read-only `SECURITY DEFINER` RPCs with pinned `search_path`: a bounded real
session picker and a rule/session preview. The preview reuses the current
lifecycle schedule calculation, template resolution, rendering,
suppression and Gmail-availability gates, but it cannot create a rule,
template, automation job, email, provider outbox row or appointment action
capability. Real action links are never minted or returned; action templates
receive inert preview labels instead. The full rendered-message preview is
conservatively finance-gated because the shared production renderer can expose
`deposit_amount`; direct browser SELECT on lifecycle source tables remains
closed.

Lifecycle Automation Studio v2 execution-history foundation claims `0105`.
It adds one bounded read-only `SECURITY DEFINER` RPC with pinned `search_path`
for artist-scoped lifecycle jobs. The projection joins only enough session,
client, email and approved-email outbox state to explain whether a lifecycle
message is scheduled, pending, queued, sent, suppressed, withdrawn, cancelled,
failed or retrying. It returns normalized failure categories and deliberately
omits recipient addresses, message bodies, provider identifiers, provider
payloads and raw provider/database errors. It requires current automation,
session, client and integration read capabilities and performs no mutation.

Lifecycle Automation Studio v2 timing mutation foundation claims `0106`. It
adds one narrowly scoped authenticated RPC that accepts a positive amount,
minutes/hours/days, and either before-session-start or after-session-end. The
database converts that input to the canonical anchor and signed minute offset,
enforces the existing 30-day and five-minute boundaries, versions only the
owned lifecycle rule, and atomically moves pending unsent jobs onto the new
version. Running and terminal job snapshots remain unchanged. The mutation
writes a bounded before/after activity record with no client or provider data.

Lifecycle Automation Studio v2 template versioning claims `0107`. Every
template save still creates a disabled draft row, but the database now assigns
the next version inside the exact workspace/artist, purpose, channel and locale
slot. Transaction-scoped locking covers concurrent first saves, and separate
partial unique indexes make duplicate workspace or artist versions impossible.
Activating a replacement continues to retire, rather than rewrite or delete,
the previous active version, so execution history can retain the exact copy it
used.

Lifecycle Automation Studio v2 configuration mutation audit claims `0108`.
Lifecycle rule creation and enablement now record stable rule identifiers plus
bounded before/after state, while identical enablement requests are true
no-ops. Artist-scoped template draft creation and activation record immutable
template identifiers, slot fields, versions and status transitions. Audit
metadata never copies template subjects or bodies and no mutation creates a
job, email or provider-outbox row.

Lifecycle Automation Studio v2 configuration history reads claim `0109`. A
bounded cursor-paginated RPC projects only typed rule/template identifiers,
versions, status/timing/enablement transitions and the internal actor display
label for an authorized Artist. Raw activity metadata, template copy, client
data and provider state are not part of the browser contract. Malformed legacy
metadata normalizes to null instead of widening the projection or failing the
whole history read.

Lifecycle Automation health and runtime diagnostics claim `0110` and `0111`.
They provide the private CRM with a bounded read-only projection of rule,
template, integration and queue state while keeping client addresses, message
copy, destinations and raw provider errors out of the browser contract.

Lifecycle scheduler heartbeat diagnostics claim `0112`. The migration adds a
single private timestamp, writable only by the trusted backend after a valid
scheduler tick result. The Artist health projection exposes only that timestamp
and a 15-minute stale flag, allowing an empty queue to be distinguished from a
scheduler that has stopped without storing Artist, client, appointment,
message, provider or credential data.
