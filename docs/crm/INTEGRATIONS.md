# Email, Calendar and AI boundaries

Last updated: 29 July 2026

**Nothing described here is connected.** There is no Gmail OAuth, no Google
Calendar OAuth, no AI gateway, no credential and no route. This document
describes the boundaries the interfaces enforce, so that connecting a provider
later is an adapter and an owner decision — not a redesign.

| Integration | Status | What exists in the repository |
|---|---|---|
| Email (Gmail) | **Not connected** | `workers/lib/email.js` — interface, template rules, draft/approve flow |
| Calendar (Google) | **Not connected** | `workers/lib/calendar.js` — interface, eligibility and action planner |
| AI gateway | **Not built** | `workers/lib/ai-tools.js` — the complete tool set and its constraints |
| WhatsApp (Meta Cloud API) | **Not connected** | `workers/lib/whatsapp.js`, `workers/lib/whatsapp-drain.js`, `workers/lib/whatsapp-webhook.js` — artist-scoped send, drain and webhook; both Workers inert. See ADR 0007. |

Each module returns a `*NotConnectedError` rather than pretending to work. None
of them can be made to send, create or execute anything by passing a different
argument.

## 1. Email

### The rule

Automatic sending is limited to explicitly approved transactional templates.
Everything personalised is a draft until a person approves it.

| Message | Path |
|---|---|
| Enquiry received acknowledgement | only template eligible for a future automatic path (`enquiry_received`); not currently enqueued or sent |
| Estimate | draft → human approval |
| Quote | draft → human approval |
| Offered dates | draft → human approval |
| Decline | draft → human approval |
| Cover-up discussion | draft → human approval |
| Deposit request | draft → human approval |
| Reschedule | draft → human approval |

The automatic list contains one template, and it is a factual acknowledgement
with no offer, no price and no date in it. Adding to that list is an owner
decision: each entry is a message that reaches a client with nobody reading it.

### Why the rule holds

It is not enforced by `email.js`. It is enforced by the database, so a bug or a
future caller in the Worker cannot weaken it:

- `create_email_draft` inserts `status = 'draft'` regardless of what it is
  asked for — there is no argument that produces a sendable record;
- a trigger refuses an insert with `created_by_kind = 'ai'` in any state other
  than `draft`;
- a CHECK constraint requires `approved_by` and `approved_at` before a message
  can be `approved`, `queued` or `sent`;
- only the owner may call `approve_email_draft`;
- `provider_message_id` may only exist on a `sent` message, so an id is never
  recorded before the provider accepted it.

Approval does not send. It moves the message to `approved` and enqueues an
`approved_email` outbox job, which a drain worker would deliver — once a
provider exists.

### Interface

```js
createEmailService(supabase, provider)  // provider is null today
  .createDraft({ toEmail, subject, body, ..., origin })  // always a draft
  .approveDraft(emailMessageId)                          // owner only, enqueues
  .queueApproved(emailMessageId)                         // refuses: not connected
  .sendTransactional({ templateKey, toEmail, data })     // fixed renderer; no subject/body input
  .getStatus(providerMessageId)                          // refuses: not connected
  .isConnected()                                         // false
```

`enquiry_received` accepts only a validated enquiry reference. Its versioned
subject and body are rendered inside `email.js`; a caller cannot substitute
personalised copy. A future provider adapter must be invoked by an outbox drain
that records attempts before and after delivery.

### Owner actions still required

OAuth client, consent flow, and storing the client secret and refresh token in
an encrypted server-side store reachable only by the Worker. They must never be
placed in a Supabase table readable by any CRM role, and never sent to a
browser. See `OWNER_SETUP.md` §8.

## 2. Calendar

### The rules

1. **`sessions` is authoritative.** The calendar is a projection of it. When the
   two disagree, reconciliation moves the *provider* towards the database — it
   never rewrites a session to match a calendar somebody edited by hand.
2. **Only a confirmed session is eligible.** A draft or proposed session never
   produces an event, so a tentative date cannot appear in the artist's calendar
   as though it were booked.

Rule 2 is enforced in three independent places:

- `public.session_is_calendar_eligible(status)` — one definition, so no caller
  invents its own;
- a CHECK constraint that refuses a `calendar_event_id` on a `draft` or
  `proposed` session;
- `isEligible()` in `calendar.js`.

### Dedupe

Every calendar job carries a key built by `calendar_outbox_dedupe_key`:

```text
calendar:create:<session_id>:<calendar_version>
calendar:update:<session_id>:<calendar_version>
calendar:cancel:<session_id>:<calendar_version>
```

`integration_outbox.dedupe_key` is unique, so a retry that re-enqueues the same
logical action collides instead of producing a second event. `calendar_version`
increments on each status change, so a genuinely new action gets a new key.

### The action planner

`planCalendarAction(session)` is pure, so the rules are testable with no
provider at all:

| Session state | Action |
|---|---|
| Confirmed, no event | `create` |
| Confirmed, event exists | `update` |
| Cancelled, event exists | `cancel` |
| Completed or no-show, event exists | `none` (keep history) |
| Not confirmed, no event | `none` |

A provider event id is stored only after a successful provider response.

### Owner actions still required

OAuth client and consent, choosing which calendar to write to, and storing the
refresh token as an encrypted server-side secret. See `OWNER_SETUP.md` §8.

## 3. AI gateway

### The tools

Ten named tools. There is no eleventh, and no generic one.

| Tool | Kind | Role | Returns |
|---|---|---|---|
| `search_clients` | read | owner, manager | id, name, travelling_from, created_at |
| `get_client` | read | owner, manager | id, name, preferred_contact, travelling_from, notes_summary, created_at |
| `search_enquiries` | read | owner, manager | id, reference, status, project_type, placement, timestamps |
| `get_enquiry` | read | owner, manager | the enquiry including the described idea |
| `list_follow_ups` | read | owner, manager | id, subject, due_at, status, entity ids |
| `update_enquiry_status` | write | owner, manager | via `transition_enquiry_status` |
| `assign_enquiry` | write | owner, manager | via `assign_enquiry` |
| `create_internal_note` | write | owner, manager | via `create_internal_note` |
| `create_follow_up` | write | owner, manager | via `create_follow_up` |
| `create_email_draft` | write | owner, manager | via `create_email_draft` — **draft only** |

### The constraints

- **No arbitrary SQL.** No query tool, no table name argument, no filter
  expression. The gateway can call the ten RPCs above and nothing else.
- **Caller identity decides.** Each tool declares the role it needs, and the
  *caller's* role is checked. A gateway credential is never the authority: it
  may execute a narrow RPC only after that check passes, and is never disclosed
  to the assistant.
- **Field minimisation.** Every read declares its projection, and
  `projectFields` drops anything not declared. `search_clients` deliberately
  returns no email, phone or Instagram — an assistant helping triage does not
  need contact details, and returning them would make every conversation a
  potential contact-list export.
- **Row limits.** Every read is paginated and clamped to 25 rows per call.
- **No executable write path yet.** The manifest names the SECURITY DEFINER RPC
  each future write tool would call. Before a gateway is connected, dedicated
  on-behalf-of semantics must record both `actor_kind = 'ai'` and the
  authenticated human identity in the same transaction. The current staff RPCs
  do not provide that attribution and therefore are not an AI gateway.
- **No send.** `create_email_draft` can only draft. There is no send tool, and
  the database refuses an AI-originated message in any state but `draft`.
- **`read_only` gets nothing.** No tool lists it.

### Owner actions still required

Choosing an authentication method for AI callers, issuing per-caller tokens
mapped to a CRM profile, and deciding whether an AI assistant is permitted at
all. None of this has been built.

## 4. What "not connected" means here

For each of the three: no OAuth application exists, no consent has been given,
no token is stored, no route is wired, and no call has ever been made. The CRM's
session screens say "Calendar: not connected" rather than showing a placeholder
that implies a connection, and the privacy notice states plainly that Gmail and
Google Calendar are not connected.
